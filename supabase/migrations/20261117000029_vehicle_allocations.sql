-- 029 — Slice 3B (2/3): vehicle_allocations and allocation_events (DB v1.7 §5, §17, §20, §21, §22; PRD v1.12 §4.2, §4.3,
-- §5.3, §5.5; ARCH v1.12 §5.2, §6.1; DEC-01, DEC-02, DEC-22, DEC-23, DEC-24; AD-05, AD-06).
-- Write model: no INSERT/UPDATE/DELETE grants. Rows are written only by the SECURITY DEFINER functions in 030.
-- Overlap rule (DEC-01): the database refuses overlapping allocations for the same vehicle AND for the same driver
-- (exclusion constraints over active_period). A driver may use more than one vehicle per shift, one at a time.
-- DEC-02: no handover in the MVP. allocation_type exists ('standard' | 'handover_segment') but 3B only writes 'standard'.
-- Deviations from DB v1.7 §5 (listed in the PR): client_submission_id (+ idempotency unique); shifts UNIQUE (id, branch_id,
-- company_id); a guard trigger that refuses any status/lifecycle change until slice 3C; planned_* are immutable in 3B.
-- Conventions: FK covering indexes in FK column order; (select ...) around argument-free calls in RLS.

-- target for the composite FK shift_id + branch_id + company_id (an allocation's shift is in the allocation's branch)
alter table public.shifts add constraint shifts_id_branch_id_company_id_uq unique (id, branch_id, company_id);

-- ---------------------------------------------------------------- vehicle_allocations
create table public.vehicle_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  vehicle_id uuid not null,
  driver_id uuid not null,
  shift_id uuid not null,
  planned_start_at timestamptz not null,
  planned_end_at timestamptz not null,
  started_at timestamptz,                              -- NOT written in 3B (3C)
  released_at timestamptz,                             -- NOT written in 3B (3C); ends the active period early
  active_period tstzrange generated always as (tstzrange(planned_start_at, coalesce(released_at, planned_end_at), '[)')) stored,
  status text not null default 'planned' check (status in (
    'planned', 'pre_inspection_pending', 'in_use', 'post_inspection_pending',
    'closed', 'closed_with_exceptions', 'cancelled', 'no_show')),       -- DB §20; 3B only writes 'planned'
  allocation_type text not null default 'standard' check (allocation_type in ('standard', 'handover_segment')), -- DEC-02
  previous_allocation_id uuid,
  licence_class_check text not null check (licence_class_check in ('matched', 'override_approved', 'not_configured')),
  licence_override_approval_id uuid,
  client_submission_id uuid not null,
  created_by uuid not null,
  closed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  foreign key (driver_id, company_id) references public.drivers (id, company_id),
  foreign key (shift_id, branch_id, company_id) references public.shifts (id, branch_id, company_id),
  foreign key (previous_allocation_id, company_id) references public.vehicle_allocations (id, company_id),
  foreign key (licence_override_approval_id, company_id) references public.approvals (id, company_id),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  foreign key (closed_by, company_id) references public.profiles (id, company_id),
  unique (id, company_id),
  unique (id, vehicle_id, driver_id, shift_id, branch_id),                -- target for inspections (Phase 4)
  constraint va_idempotent unique (company_id, created_by, client_submission_id),
  constraint va_end_after_start check (planned_end_at > planned_start_at),
  constraint va_released_not_before_start check (released_at is null or released_at >= planned_start_at),
  constraint va_override_linked check ((licence_class_check = 'override_approved') = (licence_override_approval_id is not null)),
  constraint va_vehicle_no_overlap exclude using gist (vehicle_id with =, active_period with &&)
    where (status not in ('cancelled', 'no_show')),
  constraint va_driver_no_overlap exclude using gist (driver_id with =, active_period with &&)
    where (status not in ('cancelled', 'no_show'))
);
-- FK covers, in FK column order. company_id (the companies FK) is covered by the leading column of va_idempotent.
create index va_branch_id_company_id_idx            on public.vehicle_allocations (branch_id, company_id);
create index va_vehicle_id_company_id_idx           on public.vehicle_allocations (vehicle_id, company_id);
create index va_driver_id_company_id_idx            on public.vehicle_allocations (driver_id, company_id);
create index va_shift_branch_company_idx            on public.vehicle_allocations (shift_id, branch_id, company_id);
create index va_previous_allocation_company_idx     on public.vehicle_allocations (previous_allocation_id, company_id);
create index va_override_approval_company_idx       on public.vehicle_allocations (licence_override_approval_id, company_id);
create index va_created_by_company_id_idx           on public.vehicle_allocations (created_by, company_id);
create index va_closed_by_company_id_idx            on public.vehicle_allocations (closed_by, company_id);
-- DB §22
create index va_vehicle_planned_start_idx           on public.vehicle_allocations (vehicle_id, planned_start_at desc);
create index va_branch_status_planned_start_idx     on public.vehicle_allocations (branch_id, status, planned_start_at);

create trigger va_updated_at before update on public.vehicle_allocations for each row execute function public.set_updated_at();
create trigger va_immutable before update on public.vehicle_allocations for each row
  execute function public.prevent_column_change('id', 'company_id', 'branch_id', 'vehicle_id', 'driver_id', 'shift_id',
    'planned_start_at', 'planned_end_at', 'allocation_type', 'previous_allocation_id', 'licence_class_check',
    'licence_override_approval_id', 'client_submission_id', 'created_by', 'created_at');

-- Slice 3B refuses every lifecycle change. Slice 3C replaces this trigger with the status transition table.
create function public.va_status_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status
     or new.started_at is distinct from old.started_at
     or new.released_at is distinct from old.released_at
     or new.closed_by is distinct from old.closed_by then
    raise exception 'allocation status and lifecycle changes are not available yet (slice 3C)' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger va_status_guard_t before update on public.vehicle_allocations for each row execute function public.va_status_guard();

-- On insert: the vehicle and the driver are at the allocation's branch, the shift is scheduled (its branch is enforced
-- by the composite FK), and the vehicle is not archived. Availability and licence rules live in the functions (030).
create function public.va_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v public.vehicles;
  d public.drivers;
  s public.shifts;
begin
  select * into v from public.vehicles where id = new.vehicle_id and company_id = new.company_id;
  if not found or v.current_branch_id <> new.branch_id then
    raise exception 'the vehicle is not at the allocation''s branch' using errcode = '23514';
  end if;
  if v.archived_at is not null then
    raise exception 'an archived vehicle cannot be allocated' using errcode = '23514';
  end if;
  select * into d from public.drivers where id = new.driver_id and company_id = new.company_id;
  if not found or d.branch_id <> new.branch_id then
    raise exception 'the driver is not at the allocation''s branch' using errcode = '23514';
  end if;
  select * into s from public.shifts where id = new.shift_id and company_id = new.company_id;
  if not found or s.branch_id <> new.branch_id or s.status <> 'scheduled' then
    raise exception 'the shift must be a scheduled shift of the allocation''s branch' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger va_validate_t before insert on public.vehicle_allocations for each row execute function public.va_validate();

create trigger va_no_delete   before delete   on public.vehicle_allocations for each row       execute function public.forbid_delete();
create trigger va_no_truncate before truncate on public.vehicle_allocations for each statement execute function public.forbid_delete();
create trigger va_audit after insert or update or delete on public.vehicle_allocations
  for each row execute function public.audit_row_change();
revoke execute on function public.va_status_guard(), public.va_validate() from public, anon, authenticated;

-- ---------------------------------------------------------------- allocation_events (append-only, DB §5)
create table public.allocation_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  allocation_id uuid not null,
  event_type text not null check (event_type in ('created', 'status_changed', 'amended', 'released', 'handover', 'cancelled')),
  previous_value jsonb,
  new_value jsonb,
  reason text check (length(reason) <= 1000),
  actor_id uuid not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  foreign key (allocation_id, company_id) references public.vehicle_allocations (id, company_id),
  foreign key (actor_id, company_id) references public.profiles (id, company_id)
);
create index allocation_events_company_id_idx           on public.allocation_events (company_id);
create index allocation_events_allocation_company_idx   on public.allocation_events (allocation_id, company_id, occurred_at);
create index allocation_events_actor_company_idx        on public.allocation_events (actor_id, company_id);

create function public.allocation_events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'allocation_events is append-only (% refused)', tg_op using errcode = '42501';
end $$;
create trigger allocation_events_no_update   before update   on public.allocation_events for each row       execute function public.allocation_events_append_only();
create trigger allocation_events_no_delete   before delete   on public.allocation_events for each row       execute function public.allocation_events_append_only();
create trigger allocation_events_no_truncate before truncate on public.allocation_events for each statement execute function public.allocation_events_append_only();
revoke execute on function public.allocation_events_append_only() from public, anon, authenticated;

-- ---------------------------------------------------------------- is this driver me?
-- Definer so a driver can read their own allocation rows without depending on the register's row visibility.
create function public.driver_is_self(p_driver_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true from public.drivers d
     where d.id = p_driver_id and d.profile_id = auth.uid() and public.access_cleared(d.profile_id)
       and d.company_id = public.current_company_id()
  ), false)
$$;
revoke all on function public.driver_is_self(uuid) from public, anon;
grant execute on function public.driver_is_self(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- RLS + grants (deny by default)
alter table public.vehicle_allocations enable row level security;
alter table public.allocation_events   enable row level security;
revoke all on public.vehicle_allocations, public.allocation_events from public, anon, authenticated;
grant select on public.vehicle_allocations, public.allocation_events to authenticated;

-- Managers and report viewers for the allocation's branch (company-wide grants cover every branch), and the allocation's
-- own driver. Everyone else, including maintenance and system administrators and other companies, sees nothing.
create policy va_select on public.vehicle_allocations for select to authenticated
  using (company_id = (select public.current_company_id())
         and (public.has_permission('allocation.manage', branch_id)
              or public.has_permission('reports.view', branch_id)
              or public.driver_is_self(driver_id)));

-- An event is visible exactly when its allocation is (the subquery runs under the caller's own RLS).
create policy allocation_events_select on public.allocation_events for select to authenticated
  using (company_id = (select public.current_company_id())
         and exists (select 1 from public.vehicle_allocations a
                      where a.id = allocation_events.allocation_id and a.company_id = allocation_events.company_id));
