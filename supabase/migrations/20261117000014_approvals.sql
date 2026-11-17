-- Phase 2A — generic approvals (DB §17; DEC-24 segregation of duties, DEC-31 transfers; AD-06 text + CHECK).
-- Conventions from 013: every FK has a covering index (same column order); argument-free calls in RLS
-- are wrapped once per statement as (select ...).
--
-- Writes happen ONLY through SECURITY DEFINER functions (request_* in the owning module's migration,
-- decide_approval, cancel_approval). Application roles get SELECT only. No hard deletes.
-- Deviation from DB §17 (additive, documented in the PR):
--   payload jsonb              request detail the type needs (branch_transfer: from/to branch)
--   client_submission_id uuid  idempotent requests (CLAUDE.md)
--   unique (id, company_id)    target for composite FKs (DB §2.1)
--   decided_at is also set when the requester cancels (decided_by stays NULL).

create function public.forbid_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'hard deletes are not allowed on % (void or supersede)', tg_table_name
    using errcode = '42501';
end $$;

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid,
  entity_type text not null check (length(entity_type) between 1 and 100),
  entity_id uuid not null,
  approval_type text not null check (approval_type in (
    'odometer_exception', 'odometer_correction', 'odometer_adjustment', 'no_photo_reading',
    'service_verification', 'service_config_override', 'branch_transfer', 'licence_override',
    'allocation_close_with_exceptions')),
  requested_by uuid not null,
  assigned_approver uuid,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reason text check (length(reason) <= 1000),
  decision_notes text check (length(decision_notes) <= 1000),
  decided_by uuid,
  decided_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  client_submission_id uuid,
  created_at timestamptz not null default now(),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (requested_by, company_id) references public.profiles (id, company_id),
  foreign key (assigned_approver, company_id) references public.profiles (id, company_id),
  foreign key (decided_by, company_id) references public.profiles (id, company_id),
  unique (id, company_id),
  constraint approvals_idempotent unique (company_id, requested_by, client_submission_id),
  constraint approvals_no_self_decision check (decided_by is null or decided_by <> requested_by), -- DEC-24
  constraint approvals_decision_shape check (
    (status = 'pending'                  and decided_by is null     and decided_at is null)
    or (status in ('approved', 'rejected') and decided_by is not null and decided_at is not null)
    or (status = 'cancelled'             and decided_by is null     and decided_at is not null))
);
create index approvals_company_status_idx on public.approvals (company_id, status, created_at desc);
create index approvals_branch_id_company_id_idx        on public.approvals (branch_id, company_id);
create index approvals_requested_by_company_id_idx     on public.approvals (requested_by, company_id);
create index approvals_assigned_approver_company_id_idx on public.approvals (assigned_approver, company_id);
create index approvals_decided_by_company_id_idx       on public.approvals (decided_by, company_id);
create index approvals_entity_idx                      on public.approvals (entity_type, entity_id);
-- One open transfer request per vehicle.
create unique index approvals_one_pending_transfer on public.approvals (entity_id)
  where approval_type = 'branch_transfer' and status = 'pending';

-- Identity columns never change; a decided row (approved/rejected/cancelled) never changes at all;
-- the only transition is pending -> approved | rejected | cancelled.
create trigger approvals_immutable before update on public.approvals for each row
  execute function public.prevent_column_change('id', 'company_id', 'branch_id', 'entity_type', 'entity_id',
    'approval_type', 'requested_by', 'assigned_approver', 'reason', 'payload', 'client_submission_id', 'created_at');

create function public.approvals_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'pending' then
    raise exception 'approval % is already % and cannot change', old.id, old.status using errcode = '55000';
  end if;
  if new.status not in ('approved', 'rejected', 'cancelled') then
    raise exception 'a pending approval can only become approved, rejected or cancelled' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger approvals_guard_t before update on public.approvals for each row execute function public.approvals_guard();
create trigger approvals_no_delete before delete on public.approvals for each row execute function public.forbid_delete();
create trigger approvals_no_truncate before truncate on public.approvals for each statement execute function public.forbid_delete();
create trigger approvals_audit after insert or update or delete on public.approvals
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- approval type -> deciding permission
-- Fail closed: a type with no entry cannot be decided yet (later phases add their types here, with
-- their DEC-23 permission). Only branch_transfer (vehicle.transfer.approve, DEC-31) exists in Phase 2A.
create function public.approval_decide_permission(p_type text) returns text
language sql immutable set search_path = '' as $$
  select case p_type when 'branch_transfer' then 'vehicle.transfer.approve' end
$$;

-- ---------------------------------------------------------------- RLS
alter table public.approvals enable row level security;
revoke all on public.approvals from public, anon, authenticated;
grant select on public.approvals to authenticated;

-- Requester, or a user holding the type's approve permission for the approval's branch.
create policy approvals_select on public.approvals for select to authenticated
  using (company_id = (select public.current_company_id())
         and (requested_by = (select auth.uid())
              or public.has_permission(public.approval_decide_permission(approval_type), branch_id)));

-- ---------------------------------------------------------------- decide / cancel
-- Type-specific effect, called only from decide_approval (defined with the owning table, 015).
-- Declared here so decide_approval can dispatch to it.
create function public.apply_approved_effect(p_approval_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_type text;
begin
  select approval_type into v_type from public.approvals where id = p_approval_id and status = 'approved';
  if v_type is null then
    raise exception 'not an approved approval' using errcode = '55000';
  elsif v_type = 'branch_transfer' then
    perform public.apply_branch_transfer(p_approval_id);
  else
    raise exception 'approval type % has no effect handler yet', v_type using errcode = '0A000';
  end if;
end $$;

create function public.decide_approval(p_approval_id uuid, p_decision text, p_notes text default null)
returns public.approvals
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  a public.approvals;
  v_perm text;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;

  select * into a from public.approvals where id = p_approval_id and company_id = v_company for update;
  if not found then
    raise exception 'approval not found' using errcode = 'P0002';
  end if;
  if a.status <> 'pending' then
    raise exception 'approval is already %', a.status using errcode = '55000';
  end if;
  if a.requested_by = v_uid then
    raise exception 'segregation of duties (DEC-24): you cannot decide your own request' using errcode = '42501';
  end if;
  v_perm := public.approval_decide_permission(a.approval_type);
  if v_perm is null then
    raise exception 'approval type % cannot be decided yet', a.approval_type using errcode = '0A000';
  end if;
  if not public.has_permission(v_perm, a.branch_id) then
    raise exception 'missing permission % for this branch', v_perm using errcode = '42501';
  end if;

  update public.approvals
     set status = p_decision, decided_by = v_uid, decided_at = clock_timestamp(),
         decision_notes = nullif(btrim(p_notes), '')
   where id = a.id
   returning * into a;

  -- Same transaction: if the effect fails, the decision rolls back with it.
  if p_decision = 'approved' then
    perform public.apply_approved_effect(a.id);
  end if;
  return a;
end $$;

-- The requester may withdraw their own pending request.
create function public.cancel_approval(p_approval_id uuid)
returns public.approvals
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  a public.approvals;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into a from public.approvals where id = p_approval_id and company_id = v_company for update;
  if not found then
    raise exception 'approval not found' using errcode = 'P0002';
  end if;
  if a.requested_by <> v_uid then
    raise exception 'only the requester can cancel a request' using errcode = '42501';
  end if;
  if a.status <> 'pending' then
    raise exception 'approval is already %', a.status using errcode = '55000';
  end if;
  update public.approvals set status = 'cancelled', decided_at = clock_timestamp()
   where id = a.id returning * into a;
  return a;
end $$;

revoke all on function public.apply_approved_effect(uuid) from public, anon, authenticated;
revoke all on function public.approval_decide_permission(text) from public, anon;
revoke all on function public.decide_approval(uuid, text, text) from public, anon;
revoke all on function public.cancel_approval(uuid) from public, anon;
revoke all on function public.forbid_delete() from public, anon, authenticated;
grant execute on function public.approval_decide_permission(text) to authenticated, service_role;
grant execute on function public.decide_approval(uuid, text, text) to authenticated;
grant execute on function public.cancel_approval(uuid) to authenticated;
