-- 043 — Slice 4B (3/4): which phone an inspection came from (DEC-35). Flags only; it never blocks a submission.
-- Added: inspections.device_id (nullable; composite FK to company_devices; covering index), inspections.device_flag
--   ('issued_device', 'other_device', 'unknown_device', 'no_issued_device'; null while the inspection is a draft),
--   inspection_device_flag(company, driver, device) — the ONE place the comparison is made (internal, no client grant).
-- Replaced (CREATE OR REPLACE, same signature, ACL unchanged): submit_inspection — keeps migration 040's late rule and, in
--   one step, sets device_id (from the current odometer photo's device) and device_flag; inspections_guard (the two new
--   columns are submission fields: only submit_inspection() sets them). list_inspections is dropped and created again with
--   device_flag as an extra column (a returned row type cannot change in place; ACL as before).
-- Flag meanings, evaluated at submit time against the driver's OPEN assignment of an ACTIVE device:
--   no_issued_device : the driver has no issued device (nothing to compare with)
--   unknown_device   : the photo carries no registered device (key absent or not in the register)
--   issued_device    : the photo came from the driver's issued device
--   other_device     : a registered device that is not the driver's issued one

alter table public.inspections
  add column device_id uuid,
  add column device_flag text check (device_flag in ('issued_device', 'other_device', 'unknown_device', 'no_issued_device')),
  add constraint inspections_device_fk foreign key (device_id, company_id) references public.company_devices (id, company_id),
  add constraint inspections_draft_no_device check (status <> 'draft' or device_flag is null);
create index inspections_device_company_idx on public.inspections (device_id, company_id);
comment on column public.inspections.device_flag is 'DEC-35: issued_device | other_device | unknown_device | no_issued_device, set by submit_inspection(). Never blocks; shown to supervisors.';

create function public.inspection_device_flag(p_company_id uuid, p_driver_id uuid, p_device_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when v.id is null then 'no_issued_device'
    when p_device_id is null then 'unknown_device'
    when p_device_id = v.id then 'issued_device'
    else 'other_device'
  end
  from (select 1) x
  left join lateral (
    select d.id from public.company_devices d
     where d.company_id = p_company_id and d.assigned_driver_id = p_driver_id and d.assigned_to is null and d.status = 'active'
     limit 1) v on true
$$;
revoke all on function public.inspection_device_flag(uuid, uuid, uuid) from public, anon, authenticated;

-- the two new columns belong to the submission (same rule as submitted_at / late_flag / safety_defect_flag)
create or replace function public.inspections_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c text;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  v_void text[] := array['status', 'voided_at', 'void_reason', 'voided_by', 'updated_at'];
begin
  foreach c in array array['id', 'company_id', 'branch_id', 'vehicle_id', 'driver_id', 'shift_id', 'allocation_id', 'template_id',
                           'inspection_stage', 'started_at', 'submitted_by', 'completed_by_role', 'on_behalf_reason',
                           'client_submission_id', 'created_at'] loop
    if o -> c is distinct from n -> c then
      raise exception 'column inspections.% is immutable', c using errcode = '23514';
    end if;
  end loop;
  if old.status = 'void' then
    raise exception 'a voided inspection cannot change' using errcode = '55000';
  elsif old.status = 'submitted' then
    if new.status <> 'void' or (o - v_void) is distinct from (n - v_void) then
      raise exception 'a submitted inspection cannot change; it can only be voided' using errcode = '55000';
    end if;
  else  -- draft
    if new.status = 'submitted' then
      if new.submitted_at is distinct from now() then
        raise exception 'submitted_at is the server time' using errcode = '23514';
      end if;
    elsif new.status = 'void' then
      if new.voided_at is distinct from now() then
        raise exception 'voided_at is the server time' using errcode = '23514';
      end if;
    elsif new.submitted_at is not null or new.late_flag or new.safety_defect_flag or new.device_id is not null or new.device_flag is not null then
      raise exception 'the submission fields are set by submit_inspection()' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- submit_inspection: 040's late rule + the device flag
create or replace function public.submit_inspection(
  p_inspection_id uuid, p_device_submitted_at timestamptz, p_captured_offline boolean, p_client_submission_id uuid)
returns table (out_inspection_id uuid, out_status text, out_late_flag boolean, out_safety_defect_flag boolean, out_replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  i public.inspections;
  a public.vehicle_allocations;
  st record;
  v_late boolean;
  v_safety boolean;
  v_text text;
  v_n integer;
  v_reg text;
  v_device uuid;
  v_flag text;
begin
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  -- lock order: the allocation, then the inspection (begin_inspection locks the allocation first too)
  perform 1 from public.vehicle_allocations x
   where x.company_id = public.current_company_id()
     and x.id = (select y.allocation_id from public.inspections y where y.id = p_inspection_id and y.company_id = x.company_id) for update;
  i := public.inspection_load_for_driver(p_inspection_id);
  v_hash := md5(p_inspection_id::text);
  if public.inspection_replay(i.company_id, v_uid, p_client_submission_id, 'submit', v_hash) is not null then
    out_inspection_id := i.id; out_status := i.status; out_late_flag := i.late_flag; out_safety_defect_flag := i.safety_defect_flag;
    out_replayed := true;
    return next;
    return;
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is already %s', i.status));
  end if;
  select * into a from public.vehicle_allocations x where x.id = i.allocation_id;
  if (i.inspection_stage = 'pre_shift' and a.status <> 'pre_inspection_pending')
     or (i.inspection_stage = 'post_shift' and a.status <> 'post_inspection_pending') then
    perform public.inspection_fail('55000', format('this inspection cannot be submitted while the allocation is %s', replace(a.status, '_', ' ')));
  end if;

  -- 1. the driver confirmed the vehicle
  if not i.vehicle_confirmed then
    select v.registration_number into v_reg from public.vehicles v where v.id = i.vehicle_id;
    perform public.inspection_fail('IN001', format('Confirm that you are inspecting the vehicle shown (%s) before you submit.', v_reg));
  end if;
  -- 2. every required item for the stage is answered
  select count(*) into v_n
    from public.inspection_template_items it
   where it.template_id = i.template_id and it.required and it.applies_to_stage in (i.inspection_stage, 'both')
     and not exists (select 1 from public.inspection_responses r where r.inspection_id = i.id and r.template_item_id = it.id);
  select it.question into v_text
    from public.inspection_template_items it
   where it.template_id = i.template_id and it.required and it.applies_to_stage in (i.inspection_stage, 'both')
     and not exists (select 1 from public.inspection_responses r where r.inspection_id = i.id and r.template_item_id = it.id)
   order by it.sequence limit 1;
  if v_n > 0 then
    perform public.inspection_fail('IN002', format('Answer every required item before you submit: "%s" is not answered (%s still to answer).', v_text, v_n));
  end if;
  -- 3. every Defect has a comment and a photo linked to that item
  select it.question into v_text
    from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
   where r.inspection_id = i.id and r.response_value = 'defect' and r.comment is null
   order by it.sequence limit 1;
  if found then
    perform public.inspection_fail('IN003', format('Describe the defect: "%s" needs a comment.', v_text));
  end if;
  select it.question into v_text
    from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
   where r.inspection_id = i.id and r.response_value = 'defect'
     and not exists (select 1 from public.inspection_photos p where p.inspection_id = i.id and p.template_item_id = r.template_item_id)
   order by it.sequence limit 1;
  if found then
    perform public.inspection_fail('IN004', format('Add a photo of the defect: "%s" needs at least one photo.', v_text));
  end if;
  -- 4. every Yes (yes_no_detail) has a comment
  select it.question into v_text
    from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
   where r.inspection_id = i.id and it.response_type = 'yes_no_detail' and r.response_value = 'yes' and r.comment is null
   order by it.sequence limit 1;
  if found then
    perform public.inspection_fail('IN005', format('Add the details: "%s" was answered Yes and needs a comment.', v_text));
  end if;
  -- 5. a current odometer photo (mandatory; the no-photo exception is Phase 5 and does not exist yet: no bypass)
  if not exists (select 1 from public.odometer_evidence o where o.inspection_id = i.id and o.is_current) then
    perform public.inspection_fail('IN006', 'The odometer photo is required: take a photo of the odometer before you submit.');
  end if;

  select * into st from public.allocation_settings(i.company_id);
  v_late := public.inspection_is_late(i.inspection_stage, now(), a.planned_start_at, a.planned_end_at, st.pre_shift_late_minutes, st.post_shift_late_minutes);
  v_safety := exists (select 1 from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
                       where r.inspection_id = i.id and r.response_value = 'defect' and it.severity_rule = 'safety_critical');

  -- DEC-35: the inspection's device is the one that took its CURRENT odometer photo; compared with the driver's issued device
  -- as it stands now. Flags only — nothing here can refuse a submission.
  select ef.device_id into v_device
    from public.odometer_evidence o join public.evidence_files ef on ef.id = o.evidence_file_id
   where o.inspection_id = i.id and o.is_current;
  v_flag := public.inspection_device_flag(i.company_id, i.driver_id, v_device);

  update public.inspections
     set status = 'submitted', submitted_at = now(), device_submitted_at = p_device_submitted_at,
         captured_offline = captured_offline or coalesce(p_captured_offline, false),
         late_flag = v_late, safety_defect_flag = v_safety, device_id = v_device, device_flag = v_flag
   where id = i.id;

  if i.inspection_stage = 'pre_shift' then
    -- rule d (033 refuses it for everyone else): only through this function, only for this allocation
    perform set_config('app.inspection_transition', a.id::text || ':in_use', true);
    perform public.transition_allocation(a.id, 'in_use', null, md5(p_client_submission_id::text || ':in_use')::uuid);
    perform set_config('app.inspection_transition', '', true);
  end if;

  perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'submit', v_hash, i.id);
  out_inspection_id := i.id; out_status := 'submitted'; out_late_flag := v_late; out_safety_defect_flag := v_safety; out_replayed := false;
  return next;
end $$;

-- ---------------------------------------------------------------- list_inspections: + device_flag (same rules, same ACL)
drop function public.list_inspections(timestamptz, timestamptz, uuid, integer);
create function public.list_inspections(p_from timestamptz, p_to timestamptz, p_branch_id uuid default null, p_limit integer default 200)
returns table (
  inspection_id uuid, allocation_id uuid, branch_id uuid, branch_name text, shift_date date, inspection_stage text, status text,
  vehicle_fleet_number text, vehicle_registration text, started_at timestamptz, submitted_at timestamptz,
  late_flag boolean, safety_defect_flag boolean, captured_offline boolean, completed_by_role text, allocation_status text, device_flag text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    perform public.inspection_fail('22023', 'the end of the range must be after its start');
  end if;
  if p_to - p_from > interval '92 days' then
    perform public.inspection_fail('22023', 'the range can be at most 92 days');
  end if;
  return query
  select i.id, i.allocation_id, i.branch_id, b.name::text, s.shift_date, i.inspection_stage, i.status,
         v.fleet_number::text, v.registration_number::text, i.started_at, i.submitted_at,
         i.late_flag, i.safety_defect_flag, i.captured_offline, i.completed_by_role, a.status, i.device_flag
    from public.inspections i
    join public.branches b on b.id = i.branch_id and b.company_id = i.company_id
    join public.shifts s on s.id = i.shift_id and s.company_id = i.company_id
    join public.vehicles v on v.id = i.vehicle_id and v.company_id = i.company_id
    join public.vehicle_allocations a on a.id = i.allocation_id and a.company_id = i.company_id
   where i.company_id = v_company
     and (p_branch_id is null or i.branch_id = p_branch_id)
     and i.started_at >= p_from and i.started_at < p_to
     and (public.has_permission('allocation.manage', i.branch_id) or public.has_permission('reports.view', i.branch_id))
   order by i.started_at desc, i.id
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;
revoke all on function public.list_inspections(timestamptz, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function public.list_inspections(timestamptz, timestamptz, uuid, integer) to authenticated;
