-- 033 — Slice 3C (2/3): the one transition function, amending planned times, the release stub, and the shared start rule
-- (PRD v1.13 §5.5 Allocation lifecycle / Allocation rules / Starting an allocation; DEC-22, DEC-24, DEC-39, DEC-40).
-- All SECURITY DEFINER, search_path = '', explicit REVOKE from public/anon; only what clients call is granted to authenticated.
--
-- Added (client):   transition_allocation, amend_allocation_times, release_allocation (stub)
-- Added (internal): allocation_fail, allocation_start_blockers, allocation_eligibility_core (7-argument form)
-- Replaced (CREATE OR REPLACE, ACLs kept): allocation_eligibility_core (6-argument form, now a wrapper), allocation_refusal (+ hint).
--
-- Stable refusals (SQLSTATE; the message is written for a supervisor and the UI shows it as is: HINT = 'user_message'):
--   42501 not allowed (not the driver / not allocation.manage for the branch)   P0002 allocation not found (incl. other company)
--   55000 wrong state or time (final status, outside the start window, too early for a no-show, wrong status to amend, ...)
--   22023 invalid input (reason missing or longer than 500, times outside the shift window, nothing to change)
--   23514 licence rule (no eligible licence)   23P01 vehicle/driver overlap   0A000 not available until a later phase

-- ---------------------------------------------------------------- one way to refuse with a user-facing message
create function public.allocation_fail(p_sqlstate text, p_message text, p_detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%', p_message using errcode = p_sqlstate, hint = 'user_message', detail = coalesce(p_detail, '');
end $$;
revoke all on function public.allocation_fail(text, text, text) from public, anon, authenticated;

-- allocation_refusal (030) with the user-message hint added; same messages, same SQLSTATEs.
create or replace function public.allocation_refusal(p_reasons text[]) returns void
language plpgsql set search_path = '' as $$
declare r text := p_reasons[1]; msg text; code text;
begin
  if r is null then
    return;
  end if;
  select m.msg, m.code into msg, code from (values
    ('shift_not_scheduled',   'the shift is not scheduled (it was cancelled)', '55000'),
    ('vehicle_not_available', 'the vehicle is not available (in maintenance, out of service, retired or archived)', '55000'),
    ('driver_inactive',       'the driver is not active', '55000'),
    ('vehicle_wrong_branch',  'the vehicle is not at the shift''s branch', '23514'),
    ('driver_wrong_branch',   'the driver is not at the shift''s branch', '23514'),
    ('no_eligible_licence',   'no eligible licence: the driver needs a verified licence valid until the end of the planned period (and a valid PrDP where required); this cannot be overridden', '23514'),
    ('vehicle_conflict',      'vehicle already allocated during that period', '23P01'),
    ('driver_conflict',       'driver already allocated during that period', '23P01')
  ) as m(reason, msg, code) where m.reason = r;
  raise exception '%', coalesce(msg, 'allocation refused: ' || r)
    using errcode = coalesce(code, '55000'), detail = array_to_string(p_reasons, ','), hint = 'user_message';
end $$;

-- ---------------------------------------------------------------- eligibility core, 7-argument form (adds: exclude this allocation)
-- Identical rules to 030 (DEC-22 / DEC-39); the only addition is p_exclude_allocation_id, so an existing allocation can be
-- re-checked (start, amend) without conflicting with itself. The 6-argument form of 030 becomes a wrapper (below).
create function public.allocation_eligibility_core(
  p_company uuid, p_shift_id uuid, p_vehicle_id uuid, p_driver_id uuid, p_start timestamptz, p_end timestamptz,
  p_exclude_allocation_id uuid)
returns table (r_ok boolean, r_reasons text[], r_check text, r_needs_override boolean,
               r_start timestamptz, r_end timestamptz, r_branch uuid)
language plpgsql security definer set search_path = '' as $$
declare
  s public.shifts;
  v public.vehicles;
  d public.drivers;
  v_start timestamptz;
  v_end timestamptz;
  v_end_date date;
  v_eligible boolean;
  v_covered boolean;
  v_reasons text[] := '{}';
begin
  select * into s from public.shifts where id = p_shift_id and company_id = p_company;
  if not found then
    raise exception 'shift not found' using errcode = 'P0002';
  end if;
  select * into v from public.vehicles where id = p_vehicle_id and company_id = p_company;
  if not found then
    raise exception 'vehicle not found' using errcode = 'P0002';
  end if;
  select * into d from public.drivers where id = p_driver_id and company_id = p_company;
  if not found then
    raise exception 'driver not found' using errcode = 'P0002';
  end if;

  v_start := coalesce(p_start, s.scheduled_start_at);
  v_end := coalesce(p_end, s.scheduled_end_at);
  if v_end <= v_start then
    raise exception 'the planned end must be after the planned start' using errcode = '22023';
  end if;
  if v_start < s.scheduled_start_at or v_end > s.scheduled_end_at then
    raise exception 'the planned times must lie within the shift''s scheduled window' using errcode = '22023';
  end if;
  v_end_date := (v_end at time zone 'Africa/Johannesburg')::date;

  if s.status <> 'scheduled' then v_reasons := array_append(v_reasons, 'shift_not_scheduled'); end if;
  if v.administrative_status <> 'available' or v.archived_at is not null then v_reasons := array_append(v_reasons, 'vehicle_not_available'); end if;
  if d.active_status <> 'active' then v_reasons := array_append(v_reasons, 'driver_inactive'); end if;
  if v.current_branch_id <> s.branch_id then v_reasons := array_append(v_reasons, 'vehicle_wrong_branch'); end if;
  if d.branch_id <> s.branch_id then v_reasons := array_append(v_reasons, 'driver_wrong_branch'); end if;

  -- DEC-22 a: eligible licence, judged at the local date of planned_end_at
  select exists (select 1 from public.driver_licences l
                  where l.driver_id = d.id and l.company_id = p_company
                    and l.verification_status = 'verified'
                    and l.expiry_date >= v_end_date
                    and (not l.prdp_required or l.prdp_expiry_date >= v_end_date))
    into v_eligible;
  r_check := null;
  r_needs_override := false;
  if not v_eligible then
    v_reasons := array_append(v_reasons, 'no_eligible_licence');
  elsif v.required_licence_code is null then
    r_check := 'not_configured';                                   -- DEC-22 c
  else
    select exists (select 1 from public.driver_licences l
                    where l.driver_id = d.id and l.company_id = p_company
                      and l.verification_status = 'verified'
                      and l.expiry_date >= v_end_date
                      and (not l.prdp_required or l.prdp_expiry_date >= v_end_date)
                      and public.licence_code_coverage(l.licence_code, v.required_licence_code))
      into v_covered;
    if v_covered then
      r_check := 'matched';                                        -- DEC-22 b
    else
      r_needs_override := true;                                    -- DEC-22 d
    end if;
  end if;

  if exists (select 1 from public.vehicle_allocations a
              where a.company_id = p_company and a.vehicle_id = v.id and a.status not in ('cancelled', 'no_show')
                and a.id is distinct from p_exclude_allocation_id
                and a.active_period && tstzrange(v_start, v_end, '[)')) then
    v_reasons := array_append(v_reasons, 'vehicle_conflict');
  end if;
  if exists (select 1 from public.vehicle_allocations a
              where a.company_id = p_company and a.driver_id = d.id and a.status not in ('cancelled', 'no_show')
                and a.id is distinct from p_exclude_allocation_id
                and a.active_period && tstzrange(v_start, v_end, '[)')) then
    v_reasons := array_append(v_reasons, 'driver_conflict');
  end if;

  r_ok := cardinality(v_reasons) = 0;
  r_reasons := v_reasons;
  r_start := v_start;
  r_end := v_end;
  r_branch := s.branch_id;
  return next;
end $$;

create or replace function public.allocation_eligibility_core(
  p_company uuid, p_shift_id uuid, p_vehicle_id uuid, p_driver_id uuid, p_start timestamptz, p_end timestamptz)
returns table (r_ok boolean, r_reasons text[], r_check text, r_needs_override boolean,
               r_start timestamptz, r_end timestamptz, r_branch uuid)
language sql security definer set search_path = '' as $$
  select * from public.allocation_eligibility_core(p_company, p_shift_id, p_vehicle_id, p_driver_id, p_start, p_end, null::uuid)
$$;
comment on function public.allocation_eligibility_core(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid) is
  'DEC-39 / DEC-22: the one set of creation rules (see the 6-argument form). p_exclude_allocation_id leaves one existing allocation out of the overlap checks, so starting and amending re-run the same rules.';

revoke all on function public.allocation_eligibility_core(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- the start rule, ONE place (DEC-40)
-- Returns the codes that stop THIS allocation being started now (empty = it can be started). Used by transition_allocation
-- (which refuses with the first code) and by my_allocations (can_open = no codes), so the two can never disagree.
-- Checks: the allocation is planned; inside the start window (settings); the shift is still scheduled; the driver is active;
-- the driver still holds an eligible licence for the planned period (DEC-22 a: verified, licence and any required PrDP valid
-- until the local date of planned_end_at). Class coverage was decided when the allocation was created and is permanent.
create function public.allocation_start_blockers(p_allocation_id uuid, p_now timestamptz) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  a public.vehicle_allocations;
  st record;
  c record;
  v text[] := '{}';
begin
  select * into a from public.vehicle_allocations x where x.id = p_allocation_id;
  if not found then
    return array['not_found'];
  end if;
  select * into st from public.allocation_settings(a.company_id);
  if a.status <> 'planned' then
    v := array_append(v, 'not_planned');
  end if;
  if not public.allocation_start_window_open(a.planned_start_at, a.planned_end_at, p_now, st.open_before_start_minutes) then
    v := array_append(v, case when p_now >= a.planned_end_at then 'window_closed' else 'too_early' end);
  end if;
  select * into c from public.allocation_eligibility_core(a.company_id, a.shift_id, a.vehicle_id, a.driver_id,
                                                          a.planned_start_at, a.planned_end_at, a.id);
  v := v || array(select r from unnest(c.r_reasons) as r
                   where r in ('shift_not_scheduled', 'driver_inactive', 'no_eligible_licence'));
  return v;
end $$;
revoke all on function public.allocation_start_blockers(uuid, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------- transition_allocation (client): every status change
create function public.transition_allocation(
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
  st record;
  v_manager boolean;
  v_driver boolean;
  v_on_behalf boolean := false;
  v_blockers text[];
  v_event_type text := 'status_changed';
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

  -- idempotent retry (same actor, same submission id): success without a second event
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

  -- the transition table (032), then the rule for this transition
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
      perform public.allocation_refusal(v_blockers);     -- shift_not_scheduled, driver_inactive, no_eligible_licence
    end if;
    perform set_config('app.audit_reason', coalesce(v_reason, 'allocation started'), true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations
       set status = 'pre_inspection_pending', opened_at = v_now, opened_by = v_uid, opened_on_behalf = v_on_behalf
     where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);

  elsif p_to_status = 'cancelled' then
    -- b. cancel (from planned or pre_inspection_pending): allocation.manage, with a reason
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
    -- c. no-show (pre_inspection_pending only): allocation.manage, with a reason, only from planned start + grace
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
    -- d. not available yet
    perform public.allocation_fail('0A000', 'This step needs a submitted pre-shift inspection — available from Phase 4.');
  elsif p_to_status = 'post_inspection_pending' then
    -- e. not available yet
    perform public.allocation_fail('0A000', 'This step needs the post-shift inspection flow — available from Phase 4.');
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
            || case when p_to_status = 'pre_inspection_pending' then jsonb_build_object('on_behalf', v_on_behalf) else '{}'::jsonb end);

  out_allocation_id := a.id;
  out_status := p_to_status;
  out_replayed := false;
  return next;
end $$;

-- ---------------------------------------------------------------- amend_allocation_times (client): no status change
-- Shortening and extending both. allocation.manage for the branch; a reason; only while planned or pre_inspection_pending; the
-- new times inside the shift's window; the licence check for the NEW period; the vehicle/driver overlap check (not against itself).
create function public.amend_allocation_times(
  p_allocation_id uuid, p_planned_start_at timestamptz, p_planned_end_at timestamptz, p_reason text, p_client_submission_id uuid)
returns table (out_allocation_id uuid, out_planned_start_at timestamptz, out_planned_end_at timestamptz, out_replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := nullif(btrim(p_reason), '');
  a public.vehicle_allocations;
  ev public.allocation_events;
  c record;
  v_blockers text[];
  v_constraint text;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.allocation_fail('22023', 'client_submission_id is required');
  end if;

  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company for update;
  if not found then
    perform public.allocation_fail('P0002', 'that allocation was not found, or it is not in a branch you can access');
  end if;
  if not public.has_permission('allocation.manage', a.branch_id) then
    perform public.allocation_fail('42501', 'only a manager of this branch can change the planned times of an allocation');
  end if;

  select * into ev from public.allocation_events e
   where e.allocation_id = a.id and e.actor_id = v_uid and e.metadata ->> 'client_submission_id' = p_client_submission_id::text;
  if found then
    if ev.event_type <> 'amended' or (ev.new_value ->> 'planned_start_at')::timestamptz is distinct from p_planned_start_at
       or (ev.new_value ->> 'planned_end_at')::timestamptz is distinct from p_planned_end_at then
      perform public.allocation_fail('22023', 'client_submission_id was already used for a different request');
    end if;
    out_allocation_id := a.id;
    out_planned_start_at := a.planned_start_at;
    out_planned_end_at := a.planned_end_at;
    out_replayed := true;
    return next;
    return;
  end if;

  if v_reason is null or length(v_reason) > 500 then
    perform public.allocation_fail('22023', 'a reason (1-500 characters) is required to change the planned times');
  end if;
  if a.status not in ('planned', 'pre_inspection_pending') then
    perform public.allocation_fail('55000', format('the planned times can only be changed while the allocation is planned or pre-inspection pending; this one is %s',
                                                    replace(a.status, '_', ' ')));
  end if;
  if p_planned_start_at is null or p_planned_end_at is null then
    perform public.allocation_fail('22023', 'both the new start and the new end are required');
  end if;
  if p_planned_start_at = a.planned_start_at and p_planned_end_at = a.planned_end_at then
    perform public.allocation_fail('22023', 'those are already the planned times: nothing to change');
  end if;

  -- window + order (22023), then licence for the new period and overlap, excluding this allocation (DEC-39, DEC-22 a)
  select * into c from public.allocation_eligibility_core(a.company_id, a.shift_id, a.vehicle_id, a.driver_id,
                                                          p_planned_start_at, p_planned_end_at, a.id);
  v_blockers := array(select r from unnest(c.r_reasons) as r
                       where r in ('shift_not_scheduled', 'no_eligible_licence', 'vehicle_conflict', 'driver_conflict'));
  if cardinality(v_blockers) > 0 then
    perform public.allocation_refusal(v_blockers);
  end if;

  perform set_config('app.audit_reason', v_reason, true);
  perform set_config('app.allocation_amend', 'on', true);
  begin
    update public.vehicle_allocations set planned_start_at = p_planned_start_at, planned_end_at = p_planned_end_at where id = a.id;
  exception when exclusion_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'va_driver_no_overlap' then
      perform public.allocation_fail('23P01', 'driver already allocated during that period');
    end if;
    perform public.allocation_fail('23P01', 'vehicle already allocated during that period');
  end;
  perform set_config('app.allocation_amend', 'off', true);
  perform set_config('app.audit_reason', '', true);

  insert into public.allocation_events (company_id, allocation_id, event_type, previous_value, new_value, reason, actor_id, metadata)
  values (a.company_id, a.id, 'amended',
          jsonb_build_object('planned_start_at', a.planned_start_at, 'planned_end_at', a.planned_end_at),
          jsonb_build_object('planned_start_at', p_planned_start_at, 'planned_end_at', p_planned_end_at),
          v_reason, v_uid, jsonb_build_object('client_submission_id', p_client_submission_id, 'status', a.status));

  out_allocation_id := a.id;
  out_planned_start_at := p_planned_start_at;
  out_planned_end_at := p_planned_end_at;
  out_replayed := false;
  return next;
end $$;

-- ---------------------------------------------------------------- release_allocation (stub: the API shape exists, Phase 4 fills it in)
-- Releasing an in-use allocation (released_at) belongs with the post-shift flow. Nothing sets started_at or released_at in 3C.
create function public.release_allocation(p_allocation_id uuid, p_reason text, p_client_submission_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or public.current_company_id() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  perform public.allocation_fail('0A000', 'Releasing an allocation that is in use belongs with the post-shift flow — available from Phase 4.');
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on function
  public.transition_allocation(uuid, text, text, uuid),
  public.amend_allocation_times(uuid, timestamptz, timestamptz, text, uuid),
  public.release_allocation(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function
  public.transition_allocation(uuid, text, text, uuid),
  public.amend_allocation_times(uuid, timestamptz, timestamptz, text, uuid),
  public.release_allocation(uuid, text, uuid)
  to authenticated;
