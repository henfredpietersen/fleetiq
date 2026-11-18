-- 032 — Slice 3C (1/3): allocation lifecycle — columns, settings, the transition table and the guard trigger
-- (PRD v1.13 §5.5, §4.2, §4.3; ARCH v1.13 §5.2, §6.1; DB v1.8 §5, §20, §21; DEC-39, DEC-40, DEC-24).
-- One transition table, one place: allocation_transition_allowed(). Nothing else encodes the statuses' graph.
-- The trigger below replaces the 3B guard (same trigger name, va_status_guard_t, so tools that name it keep working):
--   * a status change is refused unless the pair is in the table, the row is not terminal, AND it is made inside
--     transition_allocation() (033), which sets and clears the transaction-local flag app.allocation_transition;
--   * opened_at / opened_by / opened_on_behalf are written together by the start transition only, then immutable;
--   * planned_start_at / planned_end_at change only inside amend_allocation_times() (flag app.allocation_amend), only while
--     the allocation is planned or pre_inspection_pending;
--   * started_at, released_at and closed_by stay closed until Phases 4/5 (as in 3B).
-- Identity columns stay immutable (prevent_column_change, now without the planned times, which the guard protects instead).

-- ---------------------------------------------------------------- opened_* columns (DEC-40)
alter table public.vehicle_allocations
  add column opened_at timestamptz,
  add column opened_by uuid,
  add column opened_on_behalf boolean not null default false,
  add constraint va_opened_pair check ((opened_at is null) = (opened_by is null)),
  add constraint va_opened_on_behalf_has_opener check (not opened_on_behalf or opened_by is not null),
  add constraint va_opened_by_fk foreign key (opened_by, company_id) references public.profiles (id, company_id);
create index va_opened_by_company_id_idx on public.vehicle_allocations (opened_by, company_id);
comment on column public.vehicle_allocations.opened_on_behalf is
  'DEC-40: true when a manager (allocation.manage for the branch) started the allocation on the driver''s behalf. Permanent; shown as "Started by supervisor".';

-- ---------------------------------------------------------------- settings: ONE place (DEC-40 configurable defaults)
-- Every rule below reads this function; nothing hard-codes 60 or 30. It moves to the company settings table when Phase 4/5
-- adds one (TypeScript mirror: allocation-settings.ts). Internal: not granted to any client role.
create function public.allocation_settings(p_company_id uuid)
returns table (open_before_start_minutes integer, no_show_grace_minutes integer)
language sql stable set search_path = '' as $$
  select 60, 30
$$;
revoke all on function public.allocation_settings(uuid) from public, anon, authenticated;

-- The two time rules as pure functions of explicit settings, so tests (and the TypeScript mirror) can vary the numbers.
-- Start window: [planned start - open_before, planned end). No-show: from planned start + grace (inclusive).
create function public.allocation_start_window_open(
  p_planned_start timestamptz, p_planned_end timestamptz, p_now timestamptz, p_open_before_minutes integer)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_now >= p_planned_start - make_interval(mins => p_open_before_minutes) and p_now < p_planned_end, false)
$$;
create function public.allocation_no_show_allowed(
  p_planned_start timestamptz, p_now timestamptz, p_grace_minutes integer)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_now >= p_planned_start + make_interval(mins => p_grace_minutes), false)
$$;
revoke all on function public.allocation_start_window_open(timestamptz, timestamptz, timestamptz, integer),
                       public.allocation_no_show_allowed(timestamptz, timestamptz, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------- the transition table (DB §20; PRD §5.5)
create function public.allocation_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(case p_from
    when 'planned'                 then p_to in ('pre_inspection_pending', 'cancelled')
    when 'pre_inspection_pending'  then p_to in ('in_use', 'no_show', 'cancelled')
    when 'in_use'                  then p_to = 'post_inspection_pending'
    when 'post_inspection_pending' then p_to in ('closed', 'closed_with_exceptions')
    when 'closed_with_exceptions'  then p_to = 'closed'
    else false                                            -- closed, cancelled, no_show are terminal; unknown statuses allow nothing
  end, false)
$$;
revoke all on function public.allocation_transition_allowed(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- closure (Phase 5 fills this in)
-- The one place the closure decision lives. Phase 5: both stages have an accepted reading and no open exceptions;
-- closed_with_exceptions needs closed_by with permission. Until then closing is never possible.
create function public.allocation_closure_blockers(p_allocation_id uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array['closure_not_available']::text[]
$$;
revoke all on function public.allocation_closure_blockers(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- idempotency: one event per (allocation, actor, submission)
create unique index allocation_events_csid_uq on public.allocation_events
  (allocation_id, actor_id, (metadata ->> 'client_submission_id'))
  where metadata ? 'client_submission_id';

-- ---------------------------------------------------------------- the guard trigger (replaces va_status_guard, 029)
drop trigger va_status_guard_t on public.vehicle_allocations;
drop function public.va_status_guard();

drop trigger va_immutable on public.vehicle_allocations;
create trigger va_immutable before update on public.vehicle_allocations for each row
  execute function public.prevent_column_change('id', 'company_id', 'branch_id', 'vehicle_id', 'driver_id', 'shift_id',
    'allocation_type', 'previous_allocation_id', 'licence_class_check', 'licence_override_approval_id',
    'client_submission_id', 'created_by', 'created_at');

create function public.va_lifecycle_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_transition boolean := coalesce(current_setting('app.allocation_transition', true), '') = 'on';
  v_amend boolean := coalesce(current_setting('app.allocation_amend', true), '') = 'on';
begin
  -- not opened until their phases (as in 3B)
  if new.started_at is distinct from old.started_at or new.released_at is distinct from old.released_at then
    raise exception 'started_at and released_at belong to the in-use flow, available from Phase 4' using errcode = '55000';
  end if;
  if new.closed_by is distinct from old.closed_by then
    raise exception 'closed_by belongs to the closure rules, available from Phase 5' using errcode = '55000';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('closed', 'cancelled', 'no_show') then
      raise exception 'a % allocation is final and its status cannot change', replace(old.status, '_', ' ') using errcode = '55000';
    end if;
    if not public.allocation_transition_allowed(old.status, new.status) then
      raise exception 'an allocation cannot move from % to %', old.status, new.status using errcode = '55000';
    end if;
    if not v_transition then
      raise exception 'allocation status changes only through transition_allocation()' using errcode = '55000';
    end if;
    if new.status = 'pre_inspection_pending' and new.opened_at is null then
      raise exception 'starting an allocation records who opened it (opened_at / opened_by)' using errcode = '55000';
    end if;
  end if;

  -- opened_*: set together by the start transition only, immutable once set (DEC-40)
  if new.opened_at is distinct from old.opened_at or new.opened_by is distinct from old.opened_by
     or new.opened_on_behalf is distinct from old.opened_on_behalf then
    if old.opened_at is not null then
      raise exception 'who started the allocation is permanent and cannot be changed' using errcode = '23514';
    end if;
    if not v_transition or old.status <> 'planned' or new.status <> 'pre_inspection_pending' then
      raise exception 'opened_at / opened_by / opened_on_behalf are written only by the start transition' using errcode = '55000';
    end if;
  end if;

  -- planned times: amend_allocation_times() only, while planned or pre_inspection_pending, inside the shift window (DEC-39)
  if new.planned_start_at is distinct from old.planned_start_at or new.planned_end_at is distinct from old.planned_end_at then
    if not v_amend or old.status not in ('planned', 'pre_inspection_pending') or new.status <> old.status then
      raise exception 'planned times change only through amend_allocation_times(), while the allocation is planned or pre-inspection pending'
        using errcode = '55000';
    end if;
    if not exists (select 1 from public.shifts s
                    where s.id = new.shift_id and s.company_id = new.company_id
                      and new.planned_start_at >= s.scheduled_start_at and new.planned_end_at <= s.scheduled_end_at) then
      raise exception 'the planned times must lie within the shift''s scheduled window' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger va_status_guard_t before update on public.vehicle_allocations for each row execute function public.va_lifecycle_guard();
revoke execute on function public.va_lifecycle_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- DEC-39: the creation rules stand (comments on the existing checks)
comment on function public.va_validate() is
  'DEC-39 (3B creation rules stand): vehicle, driver and shift are in the allocation''s branch; the shift is scheduled; the vehicle is not archived.';
comment on function public.allocation_eligibility_core(uuid, uuid, uuid, uuid, timestamptz, timestamptz) is
  'DEC-39 / DEC-22: the one set of creation rules: planned times inside the shift window; vehicle, driver and shift in one branch; only available vehicles; eligible licence for the planned period; no vehicle or driver overlap. 3C re-uses it (7-argument form) for starting and amending.';
comment on function public.apply_branch_transfer(uuid) is
  'DEC-31 + DEC-39: no branch transfer while the vehicle has open allocations at the old branch that end in the future.';
comment on function public.set_driver_status(uuid, text, text) is
  'DEC-24 + DEC-39: no driver deactivation while the driver has open allocations that end in the future.';
