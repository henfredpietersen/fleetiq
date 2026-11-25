-- 049 — Slice 4D (1/2): missing / late inspection detection (PRD v1.18 §5.7, §6; ARCH v1.17 §6.7, §11; DB v1.13 §6, §18; DEC-17, DEC-43).
-- Added:    inspection_due_status() (ONE pure SQL function; mirrored by src/modules/inspections-damage/domain/inspection-due-status.ts
--           and a shared fixture), inspection_watch_findings (table, guard, audit, RLS), list_overdue_inspections() (client, live),
--           run_inspection_watch() (service_role only; used by the `inspection_watch` background job).
-- Replaced: nothing. Merged migrations are untouched.
-- Rules:    the live list is worked out on every read; the job records each overdue inspection ONCE (UNIQUE allocation + stage +
--           finding) so Phase 5 exceptions and Phase 8 alerts can use the records. NO exceptions and NO notifications here.
--           No driver names anywhere (DEC-41). Cancelled and no-show allocations are not_applicable.

-- ---------------------------------------------------------------- the one due-status rule (pure, immutable)
-- p_submitted_at = the server submit time of the allocation's non-void SUBMITTED inspection for the stage (NULL = none).
-- Windows come from allocation_settings() (DEC-17): pre-shift = planned START + p_pre_minutes, post-shift = planned END + p_post_minutes;
-- both strict (30 min after the start is still due_now, 31 is overdue). The allocation's own planned times are used, not the shift's.
create function public.inspection_due_status(
  p_stage text, p_allocation_status text, p_planned_start_at timestamptz, p_planned_end_at timestamptz,
  p_submitted_at timestamptz, p_now timestamptz, p_pre_minutes integer, p_post_minutes integer)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_stage not in ('pre_shift', 'post_shift') then null
    when p_allocation_status in ('cancelled', 'no_show') then 'not_applicable'
    when p_submitted_at is not null then
      case when public.inspection_is_late(p_stage, p_submitted_at, p_planned_start_at, p_planned_end_at, p_pre_minutes, p_post_minutes)
           then 'submitted_late' else 'submitted' end
    when p_stage = 'pre_shift' then
      case
        when p_allocation_status in ('planned', 'pre_inspection_pending') then
          case when p_now > p_planned_start_at + make_interval(mins => p_pre_minutes) then 'overdue'
               when p_now >= p_planned_start_at then 'due_now'
               else 'not_due' end
        else 'not_applicable'
      end
    else
      case
        when p_allocation_status in ('planned', 'pre_inspection_pending') then 'not_due'
        when p_allocation_status in ('in_use', 'post_inspection_pending') then
          case when p_now > p_planned_end_at + make_interval(mins => p_post_minutes) then 'overdue'
               when p_now >= p_planned_end_at then 'due_now'
               else 'not_due' end
        else 'not_applicable'
      end
  end
$$;
revoke all on function public.inspection_due_status(text, text, timestamptz, timestamptz, timestamptz, timestamptz, integer, integer)
  from public, anon, authenticated;
comment on function public.inspection_due_status(text, text, timestamptz, timestamptz, timestamptz, timestamptz, integer, integer) is
  'DEC-17/DEC-43: not_due | due_now | overdue | submitted | submitted_late | not_applicable. Pre-shift overdue = no submitted pre-shift inspection after planned start + pre_shift_late_minutes while planned/pre_inspection_pending; post-shift overdue = none after planned end + post_shift_late_minutes while in_use/post_inspection_pending. Strict. Mirrored in TypeScript with a shared fixture.';

-- ---------------------------------------------------------------- inspection_watch_findings (DB §6, §18)
create table public.inspection_watch_findings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  allocation_id uuid not null,
  inspection_stage text not null check (inspection_stage in ('pre_shift', 'post_shift')),
  finding text not null check (finding in ('overdue')),
  detected_at timestamptz not null default now(),                 -- server time
  resolved_at timestamptz,
  resolution text check (resolution in ('submitted', 'submitted_late', 'not_applicable')),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (allocation_id, company_id) references public.vehicle_allocations (id, company_id),
  constraint inspection_watch_findings_once unique (allocation_id, inspection_stage, finding),
  constraint inspection_watch_findings_resolved_together check ((resolved_at is null) = (resolution is null)),
  constraint inspection_watch_findings_resolved_after check (resolved_at is null or resolved_at >= detected_at)
);
create index inspection_watch_findings_branch_company_idx     on public.inspection_watch_findings (branch_id, company_id);
create index inspection_watch_findings_allocation_company_idx on public.inspection_watch_findings (allocation_id, company_id);
create index inspection_watch_findings_company_idx            on public.inspection_watch_findings (company_id, detected_at desc);
create index inspection_watch_findings_open_idx               on public.inspection_watch_findings (company_id) where resolved_at is null;
comment on table public.inspection_watch_findings is
  'DEC-43: one row per overdue inspection (allocation + stage), recorded ONCE by run_inspection_watch() and resolved when the inspection is submitted or the allocation is cancelled / no-show. Phase 5 exceptions and Phase 8 alerts read this; 4D creates neither. No client writes, no delete.';

-- only the resolution may be written, once, never reopened; nothing else changes
create function public.inspection_watch_findings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'resolved_at' - 'resolution') is distinct from (to_jsonb(old) - 'resolved_at' - 'resolution') then
    raise exception 'an inspection watch finding can only be resolved' using errcode = '23514';
  end if;
  if old.resolved_at is not null then
    raise exception 'this finding is already resolved' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger inspection_watch_findings_guard_t before update on public.inspection_watch_findings
  for each row execute function public.inspection_watch_findings_guard();
create trigger inspection_watch_findings_no_delete   before delete   on public.inspection_watch_findings for each row       execute function public.forbid_delete();
create trigger inspection_watch_findings_no_truncate before truncate on public.inspection_watch_findings for each statement execute function public.forbid_delete();
create trigger inspection_watch_findings_audit after insert or update or delete on public.inspection_watch_findings
  for each row execute function public.audit_row_change();
revoke execute on function public.inspection_watch_findings_guard() from public, anon, authenticated;

alter table public.inspection_watch_findings enable row level security;
revoke all on public.inspection_watch_findings from public, anon, authenticated;
grant select on public.inspection_watch_findings to authenticated;
create policy inspection_watch_findings_select on public.inspection_watch_findings for select to authenticated
  using (company_id = (select public.current_company_id())
         and (public.has_permission('allocation.manage', branch_id) or public.has_permission('reports.view', branch_id)));
comment on policy inspection_watch_findings_select on public.inspection_watch_findings is
  'allocation.manage or reports.view for the branch (maintenance administrators and senior management read, never write). Drivers and system administrators see nothing (DEC-23).';

-- ---------------------------------------------------------------- run_inspection_watch (service role only)
-- Idempotent: inserts a finding for every allocation + stage that is overdue at p_now and has none yet; resolves open findings whose
-- inspection has been submitted or whose allocation is cancelled / no-show. Running it again changes nothing.
create function public.run_inspection_watch(p_company_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  st record;
  v_now timestamptz := coalesce(p_now, now());
  v_inserted integer := 0;
  v_resolved integer := 0;
begin
  if p_company_id is null then
    raise exception 'company id is required' using errcode = '22023';
  end if;
  select * into st from public.allocation_settings(p_company_id);

  with due as (
    select a.id as allocation_id, a.company_id, a.branch_id, s.stage,
           public.inspection_due_status(s.stage, a.status, a.planned_start_at, a.planned_end_at,
             (select i.submitted_at from public.inspections i
               where i.allocation_id = a.id and i.inspection_stage = s.stage and i.status = 'submitted'),
             v_now, st.pre_shift_late_minutes, st.post_shift_late_minutes) as due_status
      from public.vehicle_allocations a
     cross join (values ('pre_shift'), ('post_shift')) s (stage)
     where a.company_id = p_company_id
       and a.status in ('planned', 'pre_inspection_pending', 'in_use', 'post_inspection_pending')
  ), ins as (
    insert into public.inspection_watch_findings (company_id, branch_id, allocation_id, inspection_stage, finding, detected_at)
    select d.company_id, d.branch_id, d.allocation_id, d.stage, 'overdue', v_now from due d where d.due_status = 'overdue'
    on conflict (allocation_id, inspection_stage, finding) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  with open_f as (
    select f.id, f.detected_at,
           public.inspection_due_status(f.inspection_stage, a.status, a.planned_start_at, a.planned_end_at,
             (select i.submitted_at from public.inspections i
               where i.allocation_id = a.id and i.inspection_stage = f.inspection_stage and i.status = 'submitted'),
             v_now, st.pre_shift_late_minutes, st.post_shift_late_minutes) as due_status
      from public.inspection_watch_findings f
      join public.vehicle_allocations a on a.id = f.allocation_id and a.company_id = f.company_id
     where f.company_id = p_company_id and f.resolved_at is null
  ), res as (
    update public.inspection_watch_findings f
       set resolved_at = greatest(v_now, f.detected_at), resolution = o.due_status
      from open_f o
     where f.id = o.id and o.due_status in ('submitted', 'submitted_late', 'not_applicable')
    returning 1
  )
  select count(*) into v_resolved from res;

  return jsonb_build_object('inserted', v_inserted, 'resolved', v_resolved);
end $$;
revoke all on function public.run_inspection_watch(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.run_inspection_watch(uuid, timestamptz) to service_role;
comment on function public.run_inspection_watch(uuid, timestamptz) is
  'DEC-43: background job body (job type inspection_watch). service_role only. Idempotent; creates findings only: no exceptions, no notifications.';

-- ---------------------------------------------------------------- list_overdue_inspections (live, every read)
-- kind = 'overdue' (computed now; the findings table is not needed for it) or 'sync_conflict' (open, from 050). Rows only for branches
-- where the caller holds allocation.manage or reports.view. NO driver names (DEC-41). minutes_overdue = whole minutes past the late
-- threshold (planned time + window); due_by is that threshold.
-- The conflict columns are NULL for overdue rows and vice versa. 050 adds the conflict branch by replacing this function.
create function public.list_overdue_inspections(p_branch_id uuid default null)
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
  select 'overdue'::text, a.id, a.branch_id, b.name::text, v.fleet_number::text, v.registration_number::text,
         s.stage,
         case s.stage when 'pre_shift' then a.planned_start_at else a.planned_end_at end,
         case s.stage when 'pre_shift' then a.planned_start_at + make_interval(mins => st.pre_shift_late_minutes)
                      else a.planned_end_at + make_interval(mins => st.post_shift_late_minutes) end,
         floor(extract(epoch from (now() - case s.stage when 'pre_shift' then a.planned_start_at + make_interval(mins => st.pre_shift_late_minutes)
                                                        else a.planned_end_at + make_interval(mins => st.post_shift_late_minutes) end)) / 60)::integer,
         a.status,
         (select i.captured_offline from public.inspections i where i.allocation_id = a.id and i.inspection_stage = s.stage and i.status <> 'void'),
         null::uuid, null::text, null::text, null::text, null::timestamptz
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
   order by 10 desc, 4, 5, 7;
end $$;
revoke all on function public.list_overdue_inspections(uuid) from public, anon, authenticated;
grant execute on function public.list_overdue_inspections(uuid) to authenticated;
