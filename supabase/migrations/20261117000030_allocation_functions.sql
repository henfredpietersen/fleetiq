-- 030 — Slice 3B (3/3): allocation functions, licence-override approvals, consistency guards
-- (PRD v1.12 §4.2, §4.3, §5.3, §5.4 "Eligibility at allocation", §5.5; ARCH v1.12 §5.2, §6.1; DEC-01, DEC-02, DEC-22,
-- DEC-23, DEC-24). All SECURITY DEFINER, search_path = '', explicit REVOKE from public/anon; only what clients call is
-- granted to authenticated. Internal helpers are granted to nobody.
--
-- Added: allocation_eligibility, request_allocation (client); allocation_eligibility_core, allocation_refusal,
--        allocation_create_row, apply_licence_override (internal); approvals_licence_override_guard (trigger).
-- Replaced (CREATE OR REPLACE; ACLs kept): approval_decide_permission, apply_approved_effect (022), shift_has_active_allocations
--        (027 hook), apply_branch_transfer (015, + guard), set_driver_status (018, + guard).
-- Licence rule (DEC-22), checked for the allocation's PLANNED period, not for today:
--   a. BLOCK, no override: no verified licence that expires on or after the local (Africa/Johannesburg) date of
--      planned_end_at and, where prdp_required, has prdp_expiry_date on or after that date ("eligible licence").
--   b. an eligible licence covers the vehicle's required_licence_code (licence_code_coverage) -> 'matched'.
--   c. the vehicle has no required code -> allowed, 'not_configured' (permanent on that allocation).
--   d. eligible licence(s) exist but none covers the code -> NO allocation; a 'licence_override' approval is requested.
--      Only a different holder of allocation.manage for the branch may decide it; never the requester (014 CHECK), never
--      the driver (trigger below). On approval the effect creates the allocation ('override_approved') after re-running
--      every other check; if anything now fails the decision fails and nothing changes.

-- ---------------------------------------------------------------- one pending override per (vehicle, driver, shift)
create unique index approvals_one_pending_licence_override on public.approvals
  (company_id, (payload ->> 'vehicle_id'), (payload ->> 'driver_id'), (payload ->> 'shift_id'))
  where approval_type = 'licence_override' and status = 'pending';

-- ---------------------------------------------------------------- DEC-24: the driver cannot approve their own override
create function public.approvals_licence_override_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.approval_type = 'licence_override' and new.status = 'approved' and new.decided_by is not null
     and exists (select 1 from public.drivers d
                  where d.id = (new.payload ->> 'driver_id')::uuid and d.company_id = new.company_id
                    and d.profile_id = new.decided_by) then
    raise exception 'segregation of duties (DEC-24): the driver cannot approve their own licence override' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger approvals_licence_override_guard_t before insert or update on public.approvals for each row
  execute function public.approvals_licence_override_guard();
revoke execute on function public.approvals_licence_override_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- approvals: the new type (branch_transfer + service_config_override unchanged)
create or replace function public.approval_decide_permission(p_type text) returns text
language sql immutable set search_path = '' as $$
  select case p_type
    when 'branch_transfer'         then 'vehicle.transfer.approve'
    when 'service_config_override' then 'service.config.manage'
    when 'licence_override'        then 'allocation.manage'
  end
$$;

-- apply_licence_override is defined below; plpgsql resolves it at call time.
create or replace function public.apply_approved_effect(p_approval_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_type text;
begin
  select approval_type into v_type from public.approvals where id = p_approval_id and status = 'approved';
  if v_type is null then
    raise exception 'not an approved approval' using errcode = '55000';
  elsif v_type = 'branch_transfer' then
    perform public.apply_branch_transfer(p_approval_id);
  elsif v_type = 'service_config_override' then
    perform public.apply_service_config_override(p_approval_id);
  elsif v_type = 'licence_override' then
    perform public.apply_licence_override(p_approval_id);
  else
    raise exception 'approval type % has no effect handler yet', v_type using errcode = '0A000';
  end if;
end $$;

-- ---------------------------------------------------------------- slice 3A hook: a shift with live allocations cannot be cancelled
create or replace function public.shift_has_active_allocations(p_shift_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.vehicle_allocations a
                  where a.shift_id = p_shift_id and a.status not in ('cancelled', 'no_show'))
$$;

-- ---------------------------------------------------------------- eligibility: the one set of rules (internal, no permission check)
-- Returns exactly one row. block_reasons come in a fixed priority order. licence_class_check is NULL when no class result
-- exists (no eligible licence) and when a class mismatch needs an override (needs_override = true).
-- Times default to the shift's scheduled times; they must lie within the shift window (invalid input -> 22023).
create function public.allocation_eligibility_core(
  p_company uuid, p_shift_id uuid, p_vehicle_id uuid, p_driver_id uuid, p_start timestamptz, p_end timestamptz)
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
                and a.active_period && tstzrange(v_start, v_end, '[)')) then
    v_reasons := array_append(v_reasons, 'vehicle_conflict');
  end if;
  if exists (select 1 from public.vehicle_allocations a
              where a.company_id = p_company and a.driver_id = d.id and a.status not in ('cancelled', 'no_show')
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

-- Raises the clear error for a non-empty list of block reasons (first reason decides the message and SQLSTATE; all are in DETAIL).
create function public.allocation_refusal(p_reasons text[]) returns void
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
    using errcode = coalesce(code, '55000'), detail = array_to_string(p_reasons, ',');
end $$;

-- ---------------------------------------------------------------- the only INSERT path into vehicle_allocations (+ its 'created' event)
create function public.allocation_create_row(
  p_id uuid, p_company uuid, p_branch uuid, p_vehicle uuid, p_driver uuid, p_shift uuid,
  p_start timestamptz, p_end timestamptz, p_check text, p_approval uuid, p_csid uuid,
  p_created_by uuid, p_actor uuid, p_reason text, p_metadata jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_prev uuid;
  v_id uuid;
  v_constraint text;
begin
  -- DB §5: the vehicle's latest allocation (not cancelled / no_show) that starts before this one. Out-of-order creation can
  -- leave this stale: Phase 7 must recompute chronology from the data, not trust this pointer.
  select a.id into v_prev from public.vehicle_allocations a
   where a.company_id = p_company and a.vehicle_id = p_vehicle and a.status not in ('cancelled', 'no_show')
     and a.planned_start_at < p_start
   order by a.planned_start_at desc, a.created_at desc
   limit 1;

  perform set_config('app.audit_reason', coalesce(nullif(btrim(p_reason), ''), 'allocation created'), true);
  begin
    insert into public.vehicle_allocations
      (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, previous_allocation_id,
       licence_class_check, licence_override_approval_id, client_submission_id, created_by)
    values (coalesce(p_id, gen_random_uuid()), p_company, p_branch, p_vehicle, p_driver, p_shift, p_start, p_end, v_prev,
            p_check, p_approval, p_csid, p_created_by)
    returning id into v_id;
  exception
    when exclusion_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform set_config('app.audit_reason', '', true);
      if v_constraint = 'va_driver_no_overlap' then
        raise exception 'driver already allocated during that period' using errcode = '23P01';
      end if;
      raise exception 'vehicle already allocated during that period' using errcode = '23P01';
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform set_config('app.audit_reason', '', true);
      if v_constraint = 'va_idempotent' then
        -- a concurrent retry of the same submission won the race: return its row, write no second event
        select a.id into v_id from public.vehicle_allocations a
         where a.company_id = p_company and a.created_by = p_created_by and a.client_submission_id = p_csid;
        return v_id;
      end if;
      raise;
  end;
  perform set_config('app.audit_reason', '', true);

  insert into public.allocation_events (company_id, allocation_id, event_type, previous_value, new_value, reason, actor_id, metadata)
  values (p_company, v_id, 'created', null,
          jsonb_build_object('status', 'planned', 'allocation_type', 'standard', 'branch_id', p_branch, 'vehicle_id', p_vehicle,
            'driver_id', p_driver, 'shift_id', p_shift, 'planned_start_at', p_start, 'planned_end_at', p_end,
            'previous_allocation_id', v_prev, 'licence_class_check', p_check, 'licence_override_approval_id', p_approval),
          nullif(btrim(p_reason), ''), p_actor, coalesce(p_metadata, '{}'::jsonb));
  return v_id;
end $$;

-- ---------------------------------------------------------------- allocation_eligibility (client): explain before submitting
-- ok = nothing blocks it (it may still need an override REQUEST: see needs_override). Needs allocation.manage for the shift's branch.
create function public.allocation_eligibility(
  p_vehicle_id uuid, p_driver_id uuid, p_shift_id uuid, p_planned_start_at timestamptz, p_planned_end_at timestamptz)
returns table (ok boolean, block_reasons text[], licence_class_check text, needs_override boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
  v_branch uuid;
  c record;
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select sh.branch_id into v_branch from public.shifts sh where sh.id = p_shift_id and sh.company_id = v_company;
  if not found then
    raise exception 'shift not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('allocation.manage', v_branch) then
    raise exception 'missing permission allocation.manage for this branch' using errcode = '42501';
  end if;
  select * into c from public.allocation_eligibility_core(v_company, p_shift_id, p_vehicle_id, p_driver_id, p_planned_start_at, p_planned_end_at);
  ok := c.r_ok;
  block_reasons := c.r_reasons;
  licence_class_check := c.r_check;
  needs_override := c.r_needs_override;
  return next;
end $$;

-- ---------------------------------------------------------------- request_allocation (client)
-- Creates the allocation (class matched / not configured) or, on a class mismatch, a licence_override approval request.
-- Idempotent on p_client_submission_id for both outcomes. Returns (allocation_id, approval_id): the allocation id when
-- created (approval_id then null, or the approval that authorised it on a retry after approval), otherwise (null, approval id).
create function public.request_allocation(
  p_shift_id uuid, p_vehicle_id uuid, p_driver_id uuid, p_planned_start_at timestamptz, p_planned_end_at timestamptz,
  p_reason text, p_client_submission_id uuid)
returns table (allocation_id uuid, approval_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := nullif(btrim(p_reason), '');
  v_branch uuid;
  v_id uuid;
  v_approval uuid;
  ap public.approvals;
  al public.vehicle_allocations;
  c record;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;

  -- idempotent retry, either outcome
  select * into al from public.vehicle_allocations a
   where a.company_id = v_company and a.created_by = v_uid and a.client_submission_id = p_client_submission_id;
  if found then
    allocation_id := al.id;
    approval_id := al.licence_override_approval_id;
    return next;
    return;
  end if;
  select * into ap from public.approvals x
   where x.company_id = v_company and x.requested_by = v_uid and x.client_submission_id = p_client_submission_id;
  if found then
    if ap.approval_type <> 'licence_override' then
      raise exception 'client_submission_id was already used for a different request' using errcode = '22023';
    end if;
    allocation_id := null;
    approval_id := ap.id;
    return next;
    return;
  end if;

  select sh.branch_id into v_branch from public.shifts sh where sh.id = p_shift_id and sh.company_id = v_company;
  if not found then
    raise exception 'shift not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('allocation.manage', v_branch) then
    raise exception 'missing permission allocation.manage for this branch' using errcode = '42501';
  end if;
  if v_reason is not null and length(v_reason) > 1000 then
    raise exception 'the reason must be at most 1000 characters' using errcode = '22023';
  end if;

  select * into c from public.allocation_eligibility_core(v_company, p_shift_id, p_vehicle_id, p_driver_id, p_planned_start_at, p_planned_end_at);
  if not c.r_ok then
    perform public.allocation_refusal(c.r_reasons);
  end if;

  if c.r_needs_override then
    -- DEC-22 d: no allocation; request the override (every argument in the payload, so the effect can re-run the checks)
    if v_reason is null then
      raise exception 'a reason (1-1000 characters) is required to request a licence override' using errcode = '22023';
    end if;
    begin
      insert into public.approvals (company_id, branch_id, entity_type, entity_id, approval_type, requested_by, reason, payload, client_submission_id)
      values (v_company, c.r_branch, 'vehicle_allocation', gen_random_uuid(), 'licence_override', v_uid, v_reason,
              jsonb_build_object('shift_id', p_shift_id, 'vehicle_id', p_vehicle_id, 'driver_id', p_driver_id,
                                 'planned_start_at', c.r_start, 'planned_end_at', c.r_end),
              p_client_submission_id)
      returning id into v_approval;
    exception when unique_violation then
      select x.id into v_approval from public.approvals x
       where x.company_id = v_company and x.requested_by = v_uid and x.client_submission_id = p_client_submission_id;
      if v_approval is null then
        raise exception 'a licence override for this vehicle, driver and shift is already waiting for approval' using errcode = '55000';
      end if;
    end;
    allocation_id := null;
    approval_id := v_approval;
    return next;
    return;
  end if;

  v_id := public.allocation_create_row(null, v_company, c.r_branch, p_vehicle_id, p_driver_id, p_shift_id, c.r_start, c.r_end,
                                       c.r_check, null, p_client_submission_id, v_uid, v_uid, v_reason, '{}'::jsonb);
  allocation_id := v_id;
  approval_id := null;
  return next;
end $$;

-- ---------------------------------------------------------------- the override's effect (reachable only through decide_approval)
create function public.apply_licence_override(p_approval_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ap public.approvals;
  pl jsonb;
  c record;
  v_id uuid;
begin
  select * into ap from public.approvals where id = p_approval_id;
  if not found or ap.status <> 'approved' or ap.approval_type <> 'licence_override' then
    raise exception 'not an approved licence override' using errcode = '55000';
  end if;
  pl := ap.payload;
  -- re-run every check at decision time; any failure rolls the decision back with a clear error
  select * into c from public.allocation_eligibility_core(ap.company_id, (pl ->> 'shift_id')::uuid, (pl ->> 'vehicle_id')::uuid,
    (pl ->> 'driver_id')::uuid, (pl ->> 'planned_start_at')::timestamptz, (pl ->> 'planned_end_at')::timestamptz);
  if not c.r_ok then
    perform public.allocation_refusal(c.r_reasons);
  end if;
  v_id := public.allocation_create_row(ap.entity_id, ap.company_id, c.r_branch, (pl ->> 'vehicle_id')::uuid, (pl ->> 'driver_id')::uuid,
    (pl ->> 'shift_id')::uuid, c.r_start, c.r_end, 'override_approved', ap.id, ap.client_submission_id, ap.requested_by,
    auth.uid(), ap.reason,
    jsonb_build_object('licence_override_approval_id', ap.id, 'requested_by', ap.requested_by, 'approved_by', ap.decided_by));
end $$;

-- ---------------------------------------------------------------- consistency guard: branch transfer (015 + guard)
create or replace function public.apply_branch_transfer(p_approval_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p_approval public.approvals;
  v public.vehicles;
  v_from uuid;
  v_to uuid;
  v_now timestamptz := clock_timestamp();
begin
  select * into p_approval from public.approvals where id = p_approval_id;
  if not found or p_approval.status <> 'approved' or p_approval.approval_type <> 'branch_transfer' then
    raise exception 'not an approved branch transfer' using errcode = '55000';
  end if;
  v_from := (p_approval.payload ->> 'from_branch_id')::uuid;
  v_to := (p_approval.payload ->> 'to_branch_id')::uuid;
  select * into v from public.vehicles where id = p_approval.entity_id and company_id = p_approval.company_id for update;
  if not found then
    raise exception 'vehicle not found' using errcode = 'P0002';
  end if;
  if v.archived_at is not null then
    raise exception 'an archived vehicle cannot be transferred' using errcode = '55000';
  end if;
  if v.current_branch_id is distinct from v_from then
    raise exception 'the vehicle has moved since this request was made; reject it and request again' using errcode = '55000';
  end if;
  -- 3B guard: no transfer while the vehicle has open allocations at the old branch that end in the future
  if exists (select 1 from public.vehicle_allocations a
              where a.vehicle_id = v.id and a.company_id = v.company_id and a.branch_id = v_from
                and a.status not in ('cancelled', 'no_show', 'closed', 'closed_with_exceptions')
                and upper(a.active_period) > now()) then
    raise exception 'the vehicle has open allocations at its current branch; cancel or finish them before it is transferred' using errcode = '55000';
  end if;
  -- the approver must be a fleet administrator for the destination as well
  if not public.has_permission('vehicle.transfer.approve', v_to) then
    raise exception 'missing permission vehicle.transfer.approve for the destination branch' using errcode = '42501';
  end if;

  update public.vehicle_branch_assignments set effective_to = v_now
   where vehicle_id = v.id and company_id = v.company_id and effective_to is null;
  insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, approval_id, created_by)
  values (v.company_id, v.id, v_to, v_now, p_approval.id, p_approval.requested_by);
  -- vba_sync_cache_t updates vehicles.current_branch_id
end $$;

-- ---------------------------------------------------------------- consistency guard: driver deactivation (018 + guard)
create or replace function public.set_driver_status(p_driver_id uuid, p_status text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
  d public.drivers;
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_status not in ('active', 'inactive') then
    raise exception 'unknown status %', p_status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'a reason (1-500 characters) is required' using errcode = '22023';
  end if;
  select * into d from public.drivers where id = p_driver_id and company_id = v_company for update;
  if not found then
    raise exception 'driver not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('driver.manage', d.branch_id) then
    raise exception 'missing permission driver.manage for this branch' using errcode = '42501';
  end if;
  if d.profile_id = auth.uid() then
    raise exception 'nobody may change the status of their own driver record (DEC-24)' using errcode = '42501';
  end if;
  -- 3B guard: no deactivation while the driver has open allocations that end in the future
  if p_status = 'inactive' and exists (
       select 1 from public.vehicle_allocations a
        where a.driver_id = d.id and a.company_id = d.company_id
          and a.status not in ('cancelled', 'no_show', 'closed', 'closed_with_exceptions')
          and upper(a.active_period) > now()) then
    raise exception 'the driver has open allocations; cancel or finish them before deactivating the driver' using errcode = '55000';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.drivers set active_status = p_status where id = d.id;
  update public.profiles
     set status = case when p_status = 'inactive' then 'disabled' else 'active' end,
         locked_until = case when p_status = 'active' then null else locked_until end
   where id = d.profile_id and company_id = v_company
     and (p_status = 'inactive' and status <> 'disabled' or p_status = 'active' and status = 'disabled');
  perform set_config('app.audit_reason', '', true);
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on function
  public.allocation_eligibility_core(uuid, uuid, uuid, uuid, timestamptz, timestamptz),
  public.allocation_refusal(text[]),
  public.allocation_create_row(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid, uuid, uuid, text, jsonb),
  public.apply_licence_override(uuid),
  public.allocation_eligibility(uuid, uuid, uuid, timestamptz, timestamptz),
  public.request_allocation(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid)
  from public, anon, authenticated;
grant execute on function
  public.allocation_eligibility(uuid, uuid, uuid, timestamptz, timestamptz),
  public.request_allocation(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid)
  to authenticated;
