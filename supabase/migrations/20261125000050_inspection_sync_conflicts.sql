-- 050 — Slice 4D (2/2): sync conflicts — queued items the server refused permanently (PRD v1.18 §5.7, §6; ARCH v1.17 §6.9;
-- DB v1.13 §6, §18; DEC-06, DEC-24, DEC-43).
-- Added:    inspection_sync_conflicts (table, guard, audit, RLS), report_sync_conflict(), resolve_sync_conflict().
-- Replaced: list_overdue_inspections(uuid) (CREATE OR REPLACE, same signature and return type, ACL kept): now also returns open conflicts.
-- Rules:    a conflict stores the REFUSAL only (function, code, message, device time): never photos, answers or readings, which stay on the
--           phone. The driver (or the on-behalf completer) reports it; a DIFFERENT supervisor with allocation.manage resolves it with a
--           note (DEC-24). Only after that may the driver remove that inspection's queued items from the phone; nothing on the server
--           is touched. Nothing is ever deleted.

create table public.inspection_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  allocation_id uuid not null,
  inspection_id uuid,
  reported_by uuid not null,
  client_submission_id uuid not null,                              -- of the refused item (idempotent report)
  function_name text not null check (function_name = btrim(function_name) and length(function_name) between 1 and 60),
  refusal_code text not null check (length(refusal_code) between 1 and 20),
  refusal_message text not null check (length(refusal_message) between 1 and 1000),
  device_time timestamptz,                                         -- untrusted (DEC-06)
  reported_at timestamptz not null default now(),                  -- server time
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note text check (length(resolution_note) between 1 and 500),
  resolve_client_submission_id uuid,
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (allocation_id, company_id) references public.vehicle_allocations (id, company_id),
  foreign key (inspection_id, company_id) references public.inspections (id, company_id),
  foreign key (reported_by, company_id) references public.profiles (id, company_id),
  foreign key (resolved_by, company_id) references public.profiles (id, company_id),
  constraint inspection_sync_conflicts_idempotent unique (company_id, reported_by, client_submission_id),
  constraint inspection_sync_conflicts_resolved_together check (
    (resolved_by is null) = (resolved_at is null) and (resolved_by is null) = (resolution_note is null)
    and (resolved_by is null) = (resolve_client_submission_id is null)),
  constraint inspection_sync_conflicts_segregation check (resolved_by is null or resolved_by <> reported_by)   -- DEC-24
);
create unique index inspection_sync_conflicts_resolve_idempotent_uq
  on public.inspection_sync_conflicts (company_id, resolved_by, resolve_client_submission_id) where resolved_by is not null;
create index inspection_sync_conflicts_branch_company_idx     on public.inspection_sync_conflicts (branch_id, company_id);
create index inspection_sync_conflicts_allocation_company_idx on public.inspection_sync_conflicts (allocation_id, company_id);
create index inspection_sync_conflicts_inspection_company_idx on public.inspection_sync_conflicts (inspection_id, company_id);
create index inspection_sync_conflicts_reported_by_company_idx on public.inspection_sync_conflicts (reported_by, company_id);
create index inspection_sync_conflicts_resolved_by_company_idx on public.inspection_sync_conflicts (resolved_by, company_id);
create index inspection_sync_conflicts_open_idx on public.inspection_sync_conflicts (company_id, branch_id) where resolved_at is null;
comment on table public.inspection_sync_conflicts is
  'DEC-43: a queued write the server refused permanently. Holds the refusal only (no photos, answers or readings: those stay on the phone). Resolved by a different supervisor with a note; only then may the driver remove the queued items from the phone. Never deleted.';

-- only the resolution can change, once
create function public.inspection_sync_conflicts_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'resolved_by' - 'resolved_at' - 'resolution_note' - 'resolve_client_submission_id')
     is distinct from (to_jsonb(old) - 'resolved_by' - 'resolved_at' - 'resolution_note' - 'resolve_client_submission_id') then
    raise exception 'a sync conflict can only be resolved' using errcode = '23514';
  end if;
  if old.resolved_at is not null then
    raise exception 'this sync conflict is already resolved' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger inspection_sync_conflicts_guard_t before update on public.inspection_sync_conflicts
  for each row execute function public.inspection_sync_conflicts_guard();
create trigger inspection_sync_conflicts_no_delete   before delete   on public.inspection_sync_conflicts for each row       execute function public.forbid_delete();
create trigger inspection_sync_conflicts_no_truncate before truncate on public.inspection_sync_conflicts for each statement execute function public.forbid_delete();
create trigger inspection_sync_conflicts_audit after insert or update or delete on public.inspection_sync_conflicts
  for each row execute function public.audit_row_change();
revoke execute on function public.inspection_sync_conflicts_guard() from public, anon, authenticated;

alter table public.inspection_sync_conflicts enable row level security;
revoke all on public.inspection_sync_conflicts from public, anon, authenticated;
grant select on public.inspection_sync_conflicts to authenticated;
-- the reporter reads their own (the phone checks resolution on its next sync); allocation.manage / reports.view read the branch's
create policy inspection_sync_conflicts_select on public.inspection_sync_conflicts for select to authenticated
  using (company_id = (select public.current_company_id())
         and (reported_by = (select auth.uid())
              or public.has_permission('allocation.manage', branch_id)
              or public.has_permission('reports.view', branch_id)));

-- ---------------------------------------------------------------- report_sync_conflict
-- Caller: the allocation's own driver, or the supervisor who completed the inspection on the driver's behalf. Idempotent on
-- p_client_submission_id (the refused item's id): a retry returns the same conflict; the same id for a different item is refused.
create function public.report_sync_conflict(
  p_allocation_id uuid, p_inspection_id uuid, p_function_name text, p_refusal_code text, p_refusal_message text,
  p_device_time timestamptz, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  a public.vehicle_allocations;
  i public.inspections;
  c public.inspection_sync_conflicts;
  v_fn text := nullif(btrim(p_function_name), '');
  v_code text := left(nullif(btrim(p_refusal_code), ''), 20);
  v_msg text := left(nullif(btrim(p_refusal_message), ''), 1000);
  v_id uuid;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  if v_fn is null or length(v_fn) > 60 or v_code is null or v_msg is null then
    perform public.inspection_fail('22023', 'the refused function, code and message are required');
  end if;
  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company;
  if not found then
    perform public.inspection_fail('P0002', 'that allocation was not found, or you cannot access it');
  end if;
  if p_inspection_id is not null then
    select * into i from public.inspections x where x.id = p_inspection_id and x.company_id = v_company and x.allocation_id = a.id;
    if not found then
      perform public.inspection_fail('P0002', 'that inspection was not found on this allocation');
    end if;
  end if;
  -- the allocation's own driver, or the manager completing its inspection on the driver's behalf
  if not (
       (public.driver_is_self(a.driver_id) and public.has_permission('inspection.submit', a.branch_id))
       or (public.has_permission('inspection.submit', a.branch_id) and public.has_permission('allocation.manage', a.branch_id)
           and exists (select 1 from public.inspections x
                        where x.allocation_id = a.id and x.company_id = v_company and x.completed_by_role = 'supervisor_on_behalf'
                          and x.submitted_by = v_uid and (p_inspection_id is null or x.id = p_inspection_id)))) then
    perform public.inspection_fail('42501', 'only the allocation''s driver, or the manager completing its inspection on their behalf, can report a sync conflict');
  end if;

  select * into c from public.inspection_sync_conflicts x
   where x.company_id = v_company and x.reported_by = v_uid and x.client_submission_id = p_client_submission_id;
  if found then
    if c.allocation_id <> a.id or c.function_name <> v_fn then
      perform public.inspection_fail('22023', 'client_submission_id was already used for a different request');
    end if;
    return c.id;
  end if;

  insert into public.inspection_sync_conflicts (company_id, branch_id, allocation_id, inspection_id, reported_by, client_submission_id,
                                                function_name, refusal_code, refusal_message, device_time)
  values (a.company_id, a.branch_id, a.id, p_inspection_id, v_uid, p_client_submission_id, v_fn, v_code, v_msg, p_device_time)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.report_sync_conflict(uuid, uuid, text, text, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.report_sync_conflict(uuid, uuid, text, text, text, timestamptz, uuid) to authenticated;

-- ---------------------------------------------------------------- resolve_sync_conflict
create function public.resolve_sync_conflict(p_id uuid, p_note text, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_note text := nullif(btrim(p_note), '');
  c public.inspection_sync_conflicts;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  select * into c from public.inspection_sync_conflicts x where x.id = p_id and x.company_id = v_company for update;
  if not found or not public.has_permission('allocation.manage', c.branch_id) then
    perform public.inspection_fail('P0002', 'that sync conflict was not found, or you cannot access it');
  end if;
  if c.resolved_at is not null then
    if c.resolved_by = v_uid and c.resolve_client_submission_id = p_client_submission_id then
      return c.id;                                              -- a retry of the same resolution
    end if;
    perform public.inspection_fail('55000', 'this sync conflict has already been resolved');
  end if;
  if c.reported_by = v_uid then
    perform public.inspection_fail('42501', 'you cannot resolve a conflict you reported yourself; ask another supervisor');
  end if;
  if v_note is null or length(v_note) > 500 then
    perform public.inspection_fail('22023', 'a note (1-500 characters) is required to resolve a sync conflict');
  end if;
  update public.inspection_sync_conflicts
     set resolved_by = v_uid, resolved_at = now(), resolution_note = v_note, resolve_client_submission_id = p_client_submission_id
   where id = c.id;
  return c.id;
end $$;
revoke all on function public.resolve_sync_conflict(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.resolve_sync_conflict(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------- list_overdue_inspections: + open sync conflicts
-- Same signature and return type as 049 (CREATE OR REPLACE keeps the ACL). Conflicts come first, then overdue inspections by minutes.
create or replace function public.list_overdue_inspections(p_branch_id uuid default null)
returns table (
  kind text, allocation_id uuid, branch_id uuid, branch_name text, vehicle_fleet_number text, vehicle_registration text,
  inspection_stage text, planned_at timestamptz, due_by timestamptz, minutes_overdue integer, allocation_status text,
  captured_offline boolean, conflict_id uuid, function_name text, refusal_code text, refusal_message text, reported_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
  st record;
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into st from public.allocation_settings(v_company);
  return query
  select q.* from (
    select 'overdue'::text as kind, a.id as allocation_id, a.branch_id as branch_id, b.name::text as branch_name,
           v.fleet_number::text as vehicle_fleet_number, v.registration_number::text as vehicle_registration,
           s.stage as inspection_stage,
           case s.stage when 'pre_shift' then a.planned_start_at else a.planned_end_at end as planned_at,
           case s.stage when 'pre_shift' then a.planned_start_at + make_interval(mins => st.pre_shift_late_minutes)
                        else a.planned_end_at + make_interval(mins => st.post_shift_late_minutes) end as due_by,
           floor(extract(epoch from (now() - case s.stage when 'pre_shift' then a.planned_start_at + make_interval(mins => st.pre_shift_late_minutes)
                                                          else a.planned_end_at + make_interval(mins => st.post_shift_late_minutes) end)) / 60)::integer as minutes_overdue,
           a.status as allocation_status,
           (select i.captured_offline from public.inspections i where i.allocation_id = a.id and i.inspection_stage = s.stage and i.status <> 'void') as captured_offline,
           null::uuid as conflict_id, null::text as function_name, null::text as refusal_code, null::text as refusal_message, null::timestamptz as reported_at
      from public.vehicle_allocations a
      cross join (values ('pre_shift'), ('post_shift')) s (stage)
      join public.branches b on b.id = a.branch_id and b.company_id = a.company_id
      join public.vehicles v on v.id = a.vehicle_id and v.company_id = a.company_id
     where a.company_id = v_company
       and (p_branch_id is null or a.branch_id = p_branch_id)
       and a.status in ('planned', 'pre_inspection_pending', 'in_use', 'post_inspection_pending')
       and (public.has_permission('allocation.manage', a.branch_id) or public.has_permission('reports.view', a.branch_id))
       and public.inspection_due_status(s.stage, a.status, a.planned_start_at, a.planned_end_at,
             (select i.submitted_at from public.inspections i where i.allocation_id = a.id and i.inspection_stage = s.stage and i.status = 'submitted'),
             now(), st.pre_shift_late_minutes, st.post_shift_late_minutes) = 'overdue'
    union all
    select 'sync_conflict'::text, c.allocation_id, c.branch_id, b.name::text, v.fleet_number::text, v.registration_number::text,
           i.inspection_stage::text, null::timestamptz, null::timestamptz, null::integer, a.status,
           (select true from public.inspections ci where ci.id = c.inspection_id and ci.captured_offline),
           c.id, c.function_name, c.refusal_code, c.refusal_message, c.reported_at
      from public.inspection_sync_conflicts c
      join public.vehicle_allocations a on a.id = c.allocation_id and a.company_id = c.company_id
      join public.branches b on b.id = c.branch_id and b.company_id = c.company_id
      join public.vehicles v on v.id = a.vehicle_id and v.company_id = a.company_id
      left join public.inspections i on i.id = c.inspection_id and i.company_id = c.company_id
     where c.company_id = v_company and c.resolved_at is null
       and (p_branch_id is null or c.branch_id = p_branch_id)
       and (public.has_permission('allocation.manage', c.branch_id) or public.has_permission('reports.view', c.branch_id))
  ) q
  order by (q.kind = 'overdue'), q.minutes_overdue desc nulls last, q.reported_at, q.branch_name, q.vehicle_fleet_number, q.inspection_stage;
end $$;
