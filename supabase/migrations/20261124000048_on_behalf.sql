-- 048 — Slice 4C (3/3): the supervisor completes the POST-shift inspection on the driver's behalf (PRD v1.18 §5.5, §5.6; ARCH v1.17 §6.2, §6.3;
-- DB v1.13 §6; DEC-09, DEC-24, DEC-35, DEC-41, DEC-42).
-- Added:    begin_inspection_on_behalf(p_allocation_id, p_reason, p_device_started_at, p_captured_offline, p_client_submission_id) -> inspection id.
-- Replaced (CREATE OR REPLACE, same signature, ACL unchanged):
--   inspection_load_for_driver — the ONE completer check for save / attach / report_damage / confirm / submit:
--       the caller must be the inspection's submitted_by AND either (driver path) completed_by_role = 'driver', the allocation's own driver,
--       inspection.submit for the branch, or (on-behalf path) completed_by_role = 'supervisor_on_behalf', inspection.submit AND allocation.manage.
--   transition_allocation — rule e also allows begin_inspection_on_behalf (see the exact change in the rule-e comment below);
--   my_inspection — known damage list (open items), known_damage_reviewed, the inspection's own new damage, completed_by_role and
--       on_behalf_reason; it answers the allocation's driver AND the completer of an on-behalf post-shift inspection, nobody else.
-- The device flag is computed as before (against the DRIVER's issued phone), so an on-behalf inspection normally shows other_device /
-- unknown_device. It is stored unchanged; the UI shows it neutrally for on-behalf inspections. It never blocks.
-- Audit: the reason is in inspections.on_behalf_reason, in the allocation event, and in audit_logs (app.audit_reason).

create or replace function public.inspection_load_for_driver(p_inspection_id uuid) returns public.inspections
language plpgsql security definer set search_path = '' as $$
declare
  i public.inspections;
  v_ok boolean;
begin
  if auth.uid() is null or public.current_company_id() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into i from public.inspections x where x.id = p_inspection_id and x.company_id = public.current_company_id() for update;
  if not found then
    perform public.inspection_fail('P0002', 'that inspection was not found, or you cannot access it');
  end if;
  v_ok := i.submitted_by = auth.uid() and public.has_permission('inspection.submit', i.branch_id)
          and ((i.completed_by_role = 'driver' and public.driver_is_self(i.driver_id))
               or (i.completed_by_role = 'supervisor_on_behalf' and public.has_permission('allocation.manage', i.branch_id)));
  if not v_ok then
    perform public.inspection_fail('42501', 'only the person completing this inspection can change it');
  end if;
  return i;
end $$;

-- ---------------------------------------------------------------- transition_allocation: rule e (039) + on behalf (DEC-09)
-- THE EXACT CHANGE to rule e (post_inspection_pending). Before (039): flag '<allocation>:post_inspection_pending' AND the caller is the
-- allocation's driver. Now: that, OR flag '<allocation>:post_inspection_pending:on_behalf' AND the caller holds allocation.manage for the
-- branch AND inspection.submit AND is not the driver, with a reason (1-500). Only begin_inspection() and begin_inspection_on_behalf() set
-- those flags (transaction-local); every other caller keeps the 0A000 refusal. The allocation event records on_behalf.

create or replace function public.transition_allocation(
  p_allocation_id uuid, p_to_status text, p_reason text, p_client_submission_id uuid)
returns table (out_allocation_id uuid, out_status text, out_replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := nullif(btrim(p_reason), '');
  v_now timestamptz := now();
  a public.vehicle_allocations;
  ev public.allocation_events;
  ins public.inspections;
  st record;
  v_manager boolean;
  v_driver boolean;
  v_on_behalf boolean := false;
  v_blockers text[];
  v_event_type text := 'status_changed';
  v_flag text := coalesce(current_setting('app.inspection_transition', true), '');
  v_extra jsonb := '{}'::jsonb;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.allocation_fail('22023', 'client_submission_id is required');
  end if;
  if p_to_status is null or p_to_status not in ('planned', 'pre_inspection_pending', 'in_use', 'post_inspection_pending',
                                                'closed', 'closed_with_exceptions', 'cancelled', 'no_show') then
    perform public.allocation_fail('22023', 'unknown allocation status');
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    perform public.allocation_fail('22023', 'the reason must be at most 500 characters');
  end if;

  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company for update;
  if not found then
    perform public.allocation_fail('P0002', 'that allocation was not found, or it is not in a branch you can access');
  end if;

  v_manager := public.has_permission('allocation.manage', a.branch_id);
  v_driver := public.driver_is_self(a.driver_id);
  if not (v_manager or v_driver) then
    perform public.allocation_fail('42501', 'you are not allowed to change this allocation: only its driver, or a manager of its branch, can');
  end if;

  select * into ev from public.allocation_events e
   where e.allocation_id = a.id and e.actor_id = v_uid and e.metadata ->> 'client_submission_id' = p_client_submission_id::text;
  if found then
    if ev.new_value ->> 'status' is distinct from p_to_status then
      perform public.allocation_fail('22023', 'client_submission_id was already used for a different request');
    end if;
    out_allocation_id := a.id;
    out_status := p_to_status;
    out_replayed := true;
    return next;
    return;
  end if;

  if not public.allocation_transition_allowed(a.status, p_to_status) then
    if a.status in ('closed', 'cancelled', 'no_show') then
      perform public.allocation_fail('55000', format('this allocation is %s and can no longer change status', replace(a.status, '_', ' ')));
    end if;
    perform public.allocation_fail('55000', format('an allocation that is %s cannot be moved to %s',
                                                    replace(a.status, '_', ' '), replace(p_to_status, '_', ' ')));
  end if;

  if p_to_status = 'pre_inspection_pending' then
    -- a. start (DEC-40): the allocation's own driver, or allocation.manage for the branch on the driver's behalf
    select * into st from public.allocation_settings(a.company_id);
    if v_driver then
      v_on_behalf := false;
    else
      if v_reason is null then
        perform public.allocation_fail('22023', 'a reason (1-500 characters) is required to start an allocation on the driver''s behalf');
      end if;
      v_on_behalf := true;
    end if;
    v_blockers := public.allocation_start_blockers(a.id, v_now);
    if cardinality(v_blockers) > 0 then
      if v_blockers[1] = 'too_early' then
        perform public.allocation_fail('55000', format('it is too early to start this allocation: it can be started from %s (%s minutes before the planned start)',
          to_char((a.planned_start_at - make_interval(mins => st.open_before_start_minutes)) at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'),
          st.open_before_start_minutes));
      elsif v_blockers[1] = 'window_closed' then
        perform public.allocation_fail('55000', 'the planned period of this allocation has ended, so it can no longer be started');
      end if;
      perform public.allocation_refusal(v_blockers);
    end if;
    perform set_config('app.audit_reason', coalesce(v_reason, 'allocation started'), true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations
       set status = 'pre_inspection_pending', opened_at = v_now, opened_by = v_uid, opened_on_behalf = v_on_behalf
     where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);

  elsif p_to_status = 'cancelled' then
    if not v_manager then
      perform public.allocation_fail('42501', 'only a manager of this branch can cancel an allocation');
    end if;
    if v_reason is null then
      perform public.allocation_fail('22023', 'a reason (1-500 characters) is required to cancel an allocation');
    end if;
    perform set_config('app.audit_reason', v_reason, true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations set status = 'cancelled' where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);
    v_event_type := 'cancelled';

  elsif p_to_status = 'no_show' then
    if not v_manager then
      perform public.allocation_fail('42501', 'only a manager of this branch can record a no-show');
    end if;
    if v_reason is null then
      perform public.allocation_fail('22023', 'a reason (1-500 characters) is required to record a no-show');
    end if;
    select * into st from public.allocation_settings(a.company_id);
    if not public.allocation_no_show_allowed(a.planned_start_at, v_now, st.no_show_grace_minutes) then
      perform public.allocation_fail('55000', format('a no-show can only be recorded from %s (%s minutes after the planned start)',
        to_char((a.planned_start_at + make_interval(mins => st.no_show_grace_minutes)) at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'),
        st.no_show_grace_minutes));
    end if;
    perform set_config('app.audit_reason', v_reason, true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations set status = 'no_show' where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);

  elsif p_to_status = 'in_use' then
    -- d. ONLY inside submit_inspection(): flag + the allocation's driver + a submitted pre-shift inspection
    select * into ins from public.inspections x
     where x.allocation_id = a.id and x.inspection_stage = 'pre_shift' and x.status = 'submitted';
    if v_flag <> a.id::text || ':in_use' or not v_driver or not found then
      perform public.allocation_fail('0A000', 'This step needs a submitted pre-shift inspection — available from Phase 4.');
    end if;
    perform set_config('app.audit_reason', 'pre-shift inspection submitted', true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations set status = 'in_use', started_at = ins.submitted_at where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);
    v_extra := jsonb_build_object('inspection_id', ins.id);

  elsif p_to_status = 'post_inspection_pending' then
    -- e. ONLY inside begin_inspection() (the allocation's driver) or begin_inspection_on_behalf() (DEC-09: a manager of the
    --    branch holding inspection.submit, who is NOT the driver) for the post-shift stage. The transaction-local flag names this
    --    allocation and the move; the on-behalf flag also needs the caller to be that completer. Everyone else keeps the 0A000 refusal.
    v_on_behalf := v_flag = a.id::text || ':post_inspection_pending:on_behalf' and v_manager and not v_driver
                   and public.has_permission('inspection.submit', a.branch_id);
    if not ((v_flag = a.id::text || ':post_inspection_pending' and v_driver) or v_on_behalf) then
      perform public.allocation_fail('0A000', 'This step needs the post-shift inspection flow — available from Phase 4.');
    end if;
    if v_on_behalf and v_reason is null then
      perform public.allocation_fail('22023', 'a reason (1-500 characters) is required to complete the post-shift inspection on the driver''s behalf');
    end if;
    perform set_config('app.audit_reason', case when v_on_behalf then v_reason else 'post-shift inspection started' end, true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations set status = 'post_inspection_pending' where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);

  elsif p_to_status in ('closed', 'closed_with_exceptions') then
    -- f. not available yet: the closure decision lives behind allocation_closure_blockers() (Phase 5 fills it in)
    v_blockers := public.allocation_closure_blockers(a.id);
    perform public.allocation_fail('0A000', 'Closing an allocation needs the closure rules — available from Phase 5.', array_to_string(v_blockers, ','));
  else
    perform public.allocation_fail('55000', format('an allocation that is %s cannot be moved to %s',
                                                    replace(a.status, '_', ' '), replace(p_to_status, '_', ' ')));
  end if;
  perform set_config('app.audit_reason', '', true);

  insert into public.allocation_events (company_id, allocation_id, event_type, previous_value, new_value, reason, actor_id, metadata)
  values (a.company_id, a.id, v_event_type,
          jsonb_build_object('status', a.status), jsonb_build_object('status', p_to_status),
          v_reason, v_uid,
          jsonb_build_object('client_submission_id', p_client_submission_id)
            || case when p_to_status in ('pre_inspection_pending', 'post_inspection_pending') then jsonb_build_object('on_behalf', v_on_behalf) else '{}'::jsonb end
            || v_extra);

  out_allocation_id := a.id;
  out_status := p_to_status;
  out_replayed := false;
  return next;
end $$;

-- ---------------------------------------------------------------- my_inspection: known damage + the on-behalf completer
create or replace function public.my_inspection(p_allocation_id uuid, p_stage text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
  a public.vehicle_allocations;
  i public.inspections;
  v_template uuid;
  v_items jsonb;
  v_slots jsonb;
  v_odo boolean := false;
  v_vehicle jsonb;
  v_known jsonb;
  v_new jsonb;
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_stage is null or p_stage not in ('pre_shift', 'post_shift') then
    perform public.inspection_fail('22023', 'the inspection stage must be pre_shift or post_shift');
  end if;
  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company;
  if not found then
    perform public.inspection_fail('P0002', 'that allocation was not found, or you cannot access it');
  end if;
  select * into i from public.inspections x where x.allocation_id = a.id and x.inspection_stage = p_stage and x.status <> 'void';
  -- the allocation's own driver, or (DEC-09) the person completing an on-behalf post-shift inspection — never anyone else
  if not public.driver_is_self(a.driver_id)
     and not (i.id is not null and i.completed_by_role = 'supervisor_on_behalf' and i.submitted_by = auth.uid()
              and public.has_permission('inspection.submit', i.branch_id) and public.has_permission('allocation.manage', i.branch_id)) then
    perform public.inspection_fail('P0002', 'that allocation was not found, or you cannot access it');
  end if;
  v_template := coalesce(i.template_id, public.inspection_template_for(a.vehicle_id));
  select jsonb_build_object('fleet_number', v.fleet_number, 'registration', v.registration_number, 'make', v.make, 'model', v.model)
    into v_vehicle from public.vehicles v where v.id = a.vehicle_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'template_item_id', it.id, 'item_key', it.item_key, 'question', it.question, 'response_type', it.response_type,
           'required', it.required, 'severity_rule', it.severity_rule, 'sequence', it.sequence,
           'allow_na', coalesce((it.configuration ->> 'allow_na')::boolean, false),
           'answer', case when r.id is null then null else jsonb_build_object('value', r.response_value, 'comment', r.comment) end)
           order by it.sequence), '[]'::jsonb)
    into v_items
    from public.inspection_template_items it
    left join public.inspection_responses r on r.template_item_id = it.id and r.inspection_id = i.id
   where it.template_id = v_template and it.applies_to_stage in (p_stage, 'both');

  -- DEC-42: the vehicle's open damage (reported or verified): zone, severity, description, status, date. No photos, no names.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'zone', d.zone, 'zone_label', public.damage_zone_label(d.zone), 'severity', d.severity, 'description', d.description,
           'status', d.status, 'reported_at', d.reported_at, 'source', d.source,
           'reported_now', d.reported_in_inspection_id is not distinct from i.id and i.id is not null)
           order by d.reported_at, d.id), '[]'::jsonb)
    into v_known
    from public.vehicle_damage_items d
   where d.vehicle_id = a.vehicle_id and d.company_id = a.company_id and d.status in ('reported', 'verified');
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'zone', d.zone, 'zone_label', public.damage_zone_label(d.zone), 'severity', d.severity, 'description', d.description,
           'reported_at', d.reported_at) order by d.reported_at, d.id), '[]'::jsonb)
    into v_new
    from public.vehicle_damage_items d where i.id is not null and d.reported_in_inspection_id = i.id;

  if i.id is not null then
    v_odo := exists (select 1 from public.odometer_evidence o where o.inspection_id = i.id and o.is_current);
  end if;
  select coalesce(jsonb_agg(s order by s ->> 'sequence'), '[]'::jsonb) into v_slots from (
    select jsonb_build_object('kind', 'odometer', 'template_item_id', null, 'required', true, 'filled', v_odo, 'sequence', '000') s
    union all
    select jsonb_build_object('kind', 'defect_photo', 'template_item_id', it.id, 'question', it.question, 'required', true,
             'filled', exists (select 1 from public.inspection_photos p where p.inspection_id = i.id and p.template_item_id = it.id),
             'sequence', lpad(it.sequence::text, 3, '0'))
      from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
     where r.inspection_id = i.id and r.response_value = 'defect'
  ) q;

  return jsonb_build_object(
    'allocation_status', a.status, 'stage', p_stage, 'vehicle', v_vehicle,
    'inspection', case when i.id is null then null else jsonb_build_object(
        'id', i.id, 'status', i.status, 'vehicle_confirmed', i.vehicle_confirmed, 'known_damage_reviewed', i.known_damage_reviewed,
        'completed_by_role', i.completed_by_role, 'on_behalf_reason', i.on_behalf_reason, 'late_flag', i.late_flag,
        'safety_defect_flag', i.safety_defect_flag, 'captured_offline', i.captured_offline,
        'started_at', i.started_at, 'submitted_at', i.submitted_at) end,
    'items', v_items, 'photo_slots', v_slots, 'odometer_photo_present', v_odo,
    'known_damage_reviewed', coalesce(i.known_damage_reviewed, false), 'known_damage', v_known, 'new_damage', v_new);
end $$;

-- ---------------------------------------------------------------- begin_inspection_on_behalf
create function public.begin_inspection_on_behalf(
  p_allocation_id uuid, p_reason text, p_device_started_at timestamptz, p_captured_offline boolean, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := nullif(btrim(p_reason), '');
  v_hash text;
  v_replay uuid;
  a public.vehicle_allocations;
  ex public.inspections;
  v_template uuid;
  v_id uuid;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company for update;
  if not found then
    perform public.inspection_fail('P0002', 'that allocation was not found, or you cannot access it');
  end if;
  if not (public.has_permission('inspection.submit', a.branch_id) and public.has_permission('allocation.manage', a.branch_id)) then
    perform public.inspection_fail('42501', 'only a manager of this branch who can submit inspections can complete one on the driver''s behalf');
  end if;
  if exists (select 1 from public.drivers d where d.id = a.driver_id and d.company_id = a.company_id and d.profile_id = v_uid) then
    perform public.inspection_fail('42501', 'you cannot complete your own inspection on your own behalf');
  end if;
  v_hash := md5(a.id::text || '|' || coalesce(v_reason, ''));
  v_replay := public.inspection_replay(v_company, v_uid, p_client_submission_id, 'begin_on_behalf', v_hash);
  if v_replay is not null then
    return v_replay;
  end if;
  if v_reason is null or length(v_reason) > 500 then
    perform public.inspection_fail('22023', 'a reason (1-500 characters) is required to complete the post-shift inspection on the driver''s behalf');
  end if;
  if a.status not in ('in_use', 'post_inspection_pending') then
    perform public.inspection_fail('55000', format('the post-shift inspection can only be completed while the vehicle is in use; this allocation is %s', replace(a.status, '_', ' ')));
  end if;

  select * into ex from public.inspections x where x.allocation_id = a.id and x.inspection_stage = 'post_shift' and x.status <> 'void';
  if found then
    if ex.status = 'submitted' then
      perform public.inspection_fail('55000', 'the post-shift inspection for this allocation has already been submitted');
    elsif ex.completed_by_role = 'supervisor_on_behalf' and ex.submitted_by = v_uid then
      perform public.inspection_record(v_company, v_uid, p_client_submission_id, 'begin_on_behalf', v_hash, ex.id);
      return ex.id;                                          -- resuming your own on-behalf draft
    elsif ex.completed_by_role = 'supervisor_on_behalf' then
      perform public.inspection_fail('55000', 'another manager is already completing this post-shift inspection on the driver''s behalf');
    end if;
    perform public.inspection_fail('55000', 'The driver has already started this post-shift inspection. Void the driver''s draft first, then complete it on their behalf.');
  end if;

  v_template := public.inspection_template_for(a.vehicle_id);
  if v_template is null then
    perform public.inspection_fail('55000', 'there is no active inspection checklist for this vehicle; ask your administrator');
  end if;

  if a.status = 'in_use' then
    perform set_config('app.inspection_transition', a.id::text || ':post_inspection_pending:on_behalf', true);
    perform public.transition_allocation(a.id, 'post_inspection_pending', v_reason, md5(p_client_submission_id::text || ':post_inspection_pending')::uuid);
    perform set_config('app.inspection_transition', '', true);
  end if;
  update public.inspection_templates set first_used_at = now() where id = v_template and first_used_at is null;

  perform set_config('app.audit_reason', 'completed on behalf of the driver: ' || v_reason, true);
  insert into public.inspections (company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, template_id, inspection_stage,
                                  device_started_at, captured_offline, submitted_by, completed_by_role, on_behalf_reason, client_submission_id)
  values (a.company_id, a.branch_id, a.vehicle_id, a.driver_id, a.shift_id, a.id, v_template, 'post_shift',
          p_device_started_at, coalesce(p_captured_offline, false), v_uid, 'supervisor_on_behalf', v_reason, p_client_submission_id)
  returning id into v_id;
  perform set_config('app.audit_reason', '', true);
  perform public.inspection_record(v_company, v_uid, p_client_submission_id, 'begin_on_behalf', v_hash, v_id);
  return v_id;
end $$;

revoke all on function public.begin_inspection_on_behalf(uuid, text, timestamptz, boolean, uuid) from public, anon, authenticated;
grant execute on function public.begin_inspection_on_behalf(uuid, text, timestamptz, boolean, uuid) to authenticated;
