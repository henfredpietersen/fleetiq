-- Phase 2A — vehicle register (DB §4; PRD §4.2 vehicle.manage / vehicle.transfer.approve, §5.3;
-- ARCH §5.4, §10; DEC-23, DEC-24, DEC-31; AD-05, AD-06).
-- Conventions from 013: FK covering indexes (same column order); (select ...) around argument-free
-- calls in RLS. Statuses are text + CHECK.
--
-- Write model: application roles never INSERT vehicles/assignments directly.
--   create_vehicle()           -> vehicle + FIRST assignment, needs vehicle.manage on the branch
--   request_vehicle_transfer() -> an `approvals` row only; NOTHING moves
--   decide_approval()          -> (014) on approval, apply_branch_transfer() closes the open row, opens
--                                 the new one and the cache follows, in the same transaction
-- vehicles gets column-level UPDATE for editable fields only; current_branch_id and
-- current_odometer_* are caches, maintained by the assignment trigger / the future reading service.
-- Deviations from DB §4 (additive, in the PR): vehicle_documents.created_by/verified_by/verified_at
-- (DEC-24 for later verification); vehicle_documents.verification_status values mirror the
-- service_record catalogue (recorded, verified, rejected); current_odometer_reading_id has no FK yet
-- (odometer_readings arrives in Phase 5).

-- departments lacked the (id, company_id) target needed for a composite FK (DB §2.1).
alter table public.departments add constraint departments_id_company_id_uq unique (id, company_id);

-- ---------------------------------------------------------------- access helper
-- "Any active grant on this branch" (branch role, or company-wide role). Used for READ on the register,
-- which has no DEC-23 permission key of its own; writes use has_permission('vehicle.manage', branch).
create function public.has_branch_access(p_branch_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.company_id = p.company_id
    join public.roles r on r.id = ur.role_id and (r.company_id is null or r.company_id = p.company_id)
    where p.id = auth.uid()
      and public.access_cleared(p.id)
      and ur.effective_from <= now()
      and (ur.effective_to is null or ur.effective_to > now())
      and (ur.branch_id is null or ur.branch_id = p_branch_id)
      and exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = p.company_id)
    limit 1
  ), false)
$$;
revoke all on function public.has_branch_access(uuid) from public, anon;
grant execute on function public.has_branch_access(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- vehicles
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  current_branch_id uuid not null,                 -- CACHE of the open assignment
  department_id uuid,
  fleet_number text not null check (fleet_number = btrim(fleet_number) and length(fleet_number) between 1 and 50),
  registration_number text not null check (registration_number = upper(btrim(registration_number))
                                           and length(registration_number) between 1 and 20),
  make text not null check (make = btrim(make) and length(make) between 1 and 100),
  model text not null check (model = btrim(model) and length(model) between 1 and 100),
  variant text check (variant = btrim(variant) and length(variant) between 1 and 100),
  model_year integer check (model_year between 1900 and 2100),
  vehicle_category text not null check (vehicle_category = btrim(vehicle_category) and length(vehicle_category) between 1 and 100),
  vin text check (vin = upper(btrim(vin)) and length(vin) between 5 and 30),
  engine_number text check (engine_number = btrim(engine_number) and length(engine_number) between 1 and 50),
  fuel_type text check (fuel_type = btrim(fuel_type) and length(fuel_type) between 1 and 50),
  transmission text check (transmission = btrim(transmission) and length(transmission) between 1 and 50),
  administrative_status text not null default 'available'
    check (administrative_status in ('available', 'in_maintenance', 'out_of_service', 'retired')), -- AD-06, DB §20
  current_odometer_km integer not null default 0 check (current_odometer_km >= 0), -- CACHE only
  current_odometer_reading_id uuid,                -- CACHE; FK to odometer_readings in Phase 5
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  foreign key (current_branch_id, company_id) references public.branches (id, company_id),
  foreign key (department_id, company_id) references public.departments (id, company_id),
  constraint vehicles_registration_uq unique (company_id, registration_number),
  constraint vehicles_fleet_number_uq unique (company_id, fleet_number),
  unique (id, company_id)                          -- target for composite FKs (DB §2.1)
);
create unique index vehicles_vin_uq on public.vehicles (company_id, vin) where vin is not null;
create index vehicles_current_branch_id_company_id_idx on public.vehicles (current_branch_id, company_id);
create index vehicles_department_id_company_id_idx     on public.vehicles (department_id, company_id);

create trigger vehicles_updated   before update on public.vehicles for each row execute function public.set_updated_at();
create trigger vehicles_immutable before update on public.vehicles for each row
  execute function public.prevent_column_change('id', 'company_id', 'created_at');

-- Belt and braces on top of the column grants: a user session can never change the caches, and an
-- archived vehicle cannot be edited (it can only be un-archived). Definer functions, jobs and the
-- service role run as other roles and are not affected.
create function public.vehicles_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.current_branch_id is distinct from old.current_branch_id
       or new.current_odometer_km is distinct from old.current_odometer_km
       or new.current_odometer_reading_id is distinct from old.current_odometer_reading_id then
      raise exception 'current_branch_id and current_odometer_* are caches and cannot be written' using errcode = '42501';
    end if;
    if old.archived_at is not null and new.archived_at is not null
       and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
      raise exception 'an archived vehicle cannot be edited; un-archive it first' using errcode = '55000';
    end if;
  end if;
  return new;
end $$;
create trigger vehicles_guard_t before update on public.vehicles for each row execute function public.vehicles_guard();
create trigger vehicles_no_delete   before delete   on public.vehicles for each row       execute function public.forbid_delete();
create trigger vehicles_no_truncate before truncate on public.vehicles for each statement execute function public.forbid_delete();
create trigger vehicles_audit after insert or update or delete on public.vehicles
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- vehicle_branch_assignments
create table public.vehicle_branch_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  vehicle_id uuid not null,
  branch_id uuid not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  approval_id uuid,                                -- required for every transfer after the first assignment (DEC-31)
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (approval_id, company_id) references public.approvals (id, company_id),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  constraint vba_dates check (effective_to is null or effective_to > effective_from),
  -- no overlapping ranges per vehicle (also guarantees at most one open row)
  constraint vba_no_overlap exclude using gist (
    vehicle_id with =, tstzrange(effective_from, effective_to, '[)') with &&)
);
create index vba_company_id_idx                on public.vehicle_branch_assignments (company_id);
create index vba_vehicle_id_company_id_idx     on public.vehicle_branch_assignments (vehicle_id, company_id);
create index vba_branch_id_company_id_idx      on public.vehicle_branch_assignments (branch_id, company_id);
create index vba_approval_id_company_id_idx    on public.vehicle_branch_assignments (approval_id, company_id);
create index vba_created_by_company_id_idx     on public.vehicle_branch_assignments (created_by, company_id);

-- History is never edited: only an open row's effective_to may be set, once.
create trigger vba_immutable before update on public.vehicle_branch_assignments for each row
  execute function public.prevent_column_change('id', 'company_id', 'vehicle_id', 'branch_id', 'effective_from',
    'approval_id', 'created_by', 'created_at');
create function public.vba_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_has_prior boolean;
  ap public.approvals;
begin
  if tg_op = 'UPDATE' then
    if old.effective_to is not null then
      raise exception 'assignment history is immutable' using errcode = '55000';
    end if;
    return new;
  end if;

  -- INSERT
  select exists (select 1 from public.vehicle_branch_assignments x where x.vehicle_id = new.vehicle_id) into v_has_prior;
  if not v_has_prior then
    if new.approval_id is not null then
      raise exception 'the first assignment has no approval' using errcode = '23514';
    end if;
  else
    -- Every later assignment is a transfer: needs an APPROVED branch_transfer for this vehicle and branch (DEC-31).
    select * into ap from public.approvals where id = new.approval_id and company_id = new.company_id;
    if not found
       or ap.approval_type <> 'branch_transfer' or ap.status <> 'approved'
       or ap.entity_type <> 'vehicle' or ap.entity_id <> new.vehicle_id
       or (ap.payload ->> 'to_branch_id')::uuid is distinct from new.branch_id then
      raise exception 'a branch transfer needs an approved matching branch_transfer approval (DEC-31)' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger vba_guard_t before insert or update on public.vehicle_branch_assignments for each row execute function public.vba_guard();

-- The vehicle's current_branch_id cache follows the open assignment.
create function public.vba_sync_cache() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.effective_to is null then
    update public.vehicles set current_branch_id = new.branch_id where id = new.vehicle_id and company_id = new.company_id;
  end if;
  return null;
end $$;
create trigger vba_sync_cache_t after insert on public.vehicle_branch_assignments for each row execute function public.vba_sync_cache();

create trigger vba_no_delete   before delete   on public.vehicle_branch_assignments for each row       execute function public.forbid_delete();
create trigger vba_no_truncate before truncate on public.vehicle_branch_assignments for each statement execute function public.forbid_delete();
create trigger vba_audit after insert or update or delete on public.vehicle_branch_assignments
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- vehicle_documents
create table public.vehicle_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  vehicle_id uuid not null,
  document_type text not null check (document_type = btrim(document_type) and length(document_type) between 1 and 100),
  document_number text check (document_number = btrim(document_number) and length(document_number) between 1 and 100),
  issue_date date,
  expiry_date date,
  evidence_file_id uuid not null references public.evidence_files (id), -- purpose must be vehicle_document (trigger)
  verification_status text not null default 'recorded' check (verification_status in ('recorded', 'verified', 'rejected')),
  created_by uuid not null,
  verified_by uuid,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  foreign key (verified_by, company_id) references public.profiles (id, company_id),
  constraint vehicle_documents_dates check (issue_date is null or expiry_date is null or expiry_date >= issue_date),
  constraint vehicle_documents_verified check (
    verification_status <> 'verified' or (verified_by is not null and verified_at is not null)),
  constraint vehicle_documents_no_self_verify check (verified_by is null or verified_by <> created_by) -- DEC-24
);
create index vehicle_documents_company_id_idx            on public.vehicle_documents (company_id);
create index vehicle_documents_vehicle_id_company_id_idx on public.vehicle_documents (vehicle_id, company_id);
create index vehicle_documents_evidence_file_id_idx      on public.vehicle_documents (evidence_file_id);
create index vehicle_documents_created_by_company_id_idx on public.vehicle_documents (created_by, company_id);
create index vehicle_documents_verified_by_company_id_idx on public.vehicle_documents (verified_by, company_id);

create trigger vehicle_documents_immutable before update on public.vehicle_documents for each row
  execute function public.prevent_column_change('id', 'company_id', 'vehicle_id', 'evidence_file_id', 'created_by', 'created_at');

-- The linked file must be vehicle_document evidence in the same company.
create function public.vehicle_documents_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.evidence_files f
                 where f.id = new.evidence_file_id and f.company_id = new.company_id and f.purpose = 'vehicle_document') then
    raise exception 'evidence file must be vehicle_document evidence of the same company' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger vehicle_documents_validate_t before insert on public.vehicle_documents for each row execute function public.vehicle_documents_validate();
create trigger vehicle_documents_no_delete   before delete   on public.vehicle_documents for each row       execute function public.forbid_delete();
create trigger vehicle_documents_no_truncate before truncate on public.vehicle_documents for each statement execute function public.forbid_delete();
create trigger vehicle_documents_audit after insert or update or delete on public.vehicle_documents
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- write functions
create function public.create_vehicle(
  p_branch_id uuid, p_fleet_number text, p_registration_number text, p_make text, p_model text,
  p_vehicle_category text, p_variant text default null, p_model_year integer default null,
  p_vin text default null, p_engine_number text default null, p_fuel_type text default null,
  p_transmission text default null, p_department_id uuid default null,
  p_administrative_status text default 'available')
returns public.vehicles
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v public.vehicles;
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_branch_id is null or not public.has_permission('vehicle.manage', p_branch_id) then
    raise exception 'missing permission vehicle.manage for this branch' using errcode = '42501';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = v_company and b.status = 'active') then
    raise exception 'branch is not an active branch of your company' using errcode = '23514';
  end if;

  insert into public.vehicles (company_id, current_branch_id, department_id, fleet_number, registration_number, make, model,
    variant, model_year, vehicle_category, vin, engine_number, fuel_type, transmission, administrative_status)
  values (v_company, p_branch_id, p_department_id, p_fleet_number, p_registration_number, p_make, p_model,
    p_variant, p_model_year, p_vehicle_category, p_vin, p_engine_number, p_fuel_type, p_transmission,
    coalesce(p_administrative_status, 'available'))
  returning * into v;

  insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, created_by)
  values (v_company, v.id, p_branch_id, v_now, v_uid);

  select * into v from public.vehicles where id = v.id;
  return v;
end $$;

-- Requests a transfer. Nothing moves until a fleet administrator approves it (DEC-31).
create function public.request_vehicle_transfer(
  p_vehicle_id uuid, p_to_branch_id uuid, p_reason text, p_client_submission_id uuid)
returns public.approvals
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v public.vehicles;
  a public.approvals;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;

  -- idempotent retry: same submission returns the same request
  select * into a from public.approvals
   where company_id = v_company and requested_by = v_uid and client_submission_id = p_client_submission_id;
  if found then
    return a;
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 1000 then
    raise exception 'a reason (1-1000 characters) is required' using errcode = '22023';
  end if;
  select * into v from public.vehicles where id = p_vehicle_id and company_id = v_company for update;
  if not found then
    raise exception 'vehicle not found' using errcode = 'P0002';
  end if;
  if v.archived_at is not null then
    raise exception 'an archived vehicle cannot be transferred' using errcode = '55000';
  end if;
  if p_to_branch_id is null or p_to_branch_id = v.current_branch_id then
    raise exception 'choose a different destination branch' using errcode = '22023';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_to_branch_id and b.company_id = v_company and b.status = 'active') then
    raise exception 'destination is not an active branch of your company' using errcode = '23514';
  end if;
  if not public.has_permission('vehicle.manage', v.current_branch_id)
     or not public.has_permission('vehicle.manage', p_to_branch_id) then
    raise exception 'missing permission vehicle.manage for the source and destination branch' using errcode = '42501';
  end if;

  insert into public.approvals (company_id, branch_id, entity_type, entity_id, approval_type, requested_by, reason,
                                payload, client_submission_id)
  values (v_company, v.current_branch_id, 'vehicle', v.id, 'branch_transfer', v_uid, btrim(p_reason),
          jsonb_build_object('from_branch_id', v.current_branch_id, 'to_branch_id', p_to_branch_id),
          p_client_submission_id)
  returning * into a;
  return a;
end $$;

-- Internal: the transfer itself. Reachable only through decide_approval (approval already 'approved').
create function public.apply_branch_transfer(p_approval_id uuid) returns void
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

revoke all on function public.create_vehicle(uuid, text, text, text, text, text, text, integer, text, text, text, text, uuid, text) from public, anon;
revoke all on function public.request_vehicle_transfer(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.apply_branch_transfer(uuid) from public, anon, authenticated;
grant execute on function public.create_vehicle(uuid, text, text, text, text, text, text, integer, text, text, text, text, uuid, text) to authenticated;
grant execute on function public.request_vehicle_transfer(uuid, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------- RLS + grants (deny by default)
alter table public.vehicles                 enable row level security;
alter table public.vehicle_branch_assignments enable row level security;
alter table public.vehicle_documents        enable row level security;

revoke all on public.vehicles, public.vehicle_branch_assignments, public.vehicle_documents from public, anon, authenticated;
grant select on public.vehicles, public.vehicle_branch_assignments, public.vehicle_documents to authenticated;
-- Editable register fields only. Caches, status of history and ids are not writable. No INSERT, no DELETE.
grant update (department_id, fleet_number, registration_number, make, model, variant, model_year, vehicle_category,
              vin, engine_number, fuel_type, transmission, administrative_status, archived_at)
  on public.vehicles to authenticated;
grant insert (company_id, vehicle_id, document_type, document_number, issue_date, expiry_date, evidence_file_id, created_by)
  on public.vehicle_documents to authenticated;
grant update (document_type, document_number, issue_date, expiry_date) on public.vehicle_documents to authenticated;

create policy vehicles_select on public.vehicles for select to authenticated
  using (company_id = (select public.current_company_id()) and public.has_branch_access(current_branch_id));
create policy vehicles_update on public.vehicles for update to authenticated
  using (company_id = (select public.current_company_id()) and public.has_permission('vehicle.manage', current_branch_id))
  with check (company_id = (select public.current_company_id()) and public.has_permission('vehicle.manage', current_branch_id));

create policy vba_select on public.vehicle_branch_assignments for select to authenticated
  using (company_id = (select public.current_company_id()) and public.has_branch_access(branch_id));

create policy vehicle_documents_select on public.vehicle_documents for select to authenticated
  using (company_id = (select public.current_company_id())
         and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.company_id = vehicle_documents.company_id));
create policy vehicle_documents_insert on public.vehicle_documents for insert to authenticated
  with check (company_id = (select public.current_company_id())
              and created_by = (select auth.uid())
              and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.company_id = vehicle_documents.company_id
                          and public.has_permission('vehicle.manage', v.current_branch_id)));
create policy vehicle_documents_update on public.vehicle_documents for update to authenticated
  using (company_id = (select public.current_company_id())
         and verification_status = 'recorded'
         and exists (select 1 from public.vehicles v where v.id = vehicle_id and v.company_id = vehicle_documents.company_id
                     and public.has_permission('vehicle.manage', v.current_branch_id)))
  with check (company_id = (select public.current_company_id()) and verification_status = 'recorded');
