-- 023 — Slice 2C: service records (DB §10 service_records; PRD §4.3, §5.10.6, §5.10.7; DEC-20 baseline evidence,
-- DEC-24 segregation of duties; ARCH §8.1, §8.4, §10).
-- Conventions: FK covering indexes (same column order); (select ...) around argument-free calls in RLS; explicit
-- REVOKE on every function, trigger functions granted to nobody; no INSERT/UPDATE/DELETE grants; no hard deletes.
--
-- Write model (nothing is writable by a client directly):
--   create_service_record()           service.record.create on the vehicle's branch; sources workshop | manual
--   (import path, 024)                 historical_import records only through attach_import_row_evidence()
--   verify_service_record()           service.record.verify; verifier <> creator (CHECK + function); verified | rejected
--   reverse_service_verification()    service.record.verify + reason; the ONLY way a verified row changes (audited)
-- Only a VERIFIED record sets a baseline (vehicle_service_status, 025). recorded and rejected rows never do.
-- Deviations from DB §10 (additive, listed in the PR): client_submission_id (idempotency); rejected_by/rejected_at
-- (the decider of a rejection, so verified_by stays "who verified"); a reversed record keeps verified_by/verified_at
-- as history and becomes `rejected`; one evidence file belongs to exactly one record; supplier_id, work_order_id
-- ([Later] FKs) are not added yet; actual_service_lifetime_km stays NULL until odometer segments exist (Phase 5).

create table public.service_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,                         -- the vehicle's branch when the record was made
  vehicle_id uuid not null,
  service_date date not null,
  actual_service_odometer_km integer not null check (actual_service_odometer_km >= 0),   -- whole km (DEC-12)
  actual_service_lifetime_km integer check (actual_service_lifetime_km >= 0),
  service_type text not null check (service_type = btrim(service_type) and length(service_type) between 1 and 100),
  source text not null check (source in ('workshop', 'historical_import', 'manual')),
  supplier_name text check (supplier_name = btrim(supplier_name) and length(supplier_name) between 1 and 200),
  job_reference text check (job_reference = btrim(job_reference) and length(job_reference) between 1 and 100),
  invoice_reference text check (invoice_reference = btrim(invoice_reference) and length(invoice_reference) between 1 and 100),
  labour_cost numeric(12, 2) check (labour_cost >= 0),
  parts_cost numeric(12, 2) check (parts_cost >= 0),
  total_cost numeric(12, 2) check (total_cost >= 0),
  evidence_file_id uuid references public.evidence_files (id),   -- purpose service_record, same company (trigger)
  verification_status text not null default 'recorded' check (verification_status in ('recorded', 'verified', 'rejected')),
  verified_by uuid,
  verified_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  rejection_reason text check (length(btrim(rejection_reason)) between 1 and 500),
  client_submission_id uuid not null,              -- idempotency (CLAUDE.md)
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  foreign key (verified_by, company_id) references public.profiles (id, company_id),
  foreign key (rejected_by, company_id) references public.profiles (id, company_id),
  unique (id, company_id),
  constraint service_records_idempotent unique (company_id, created_by, client_submission_id),
  -- DEC-20: a historical baseline needs its invoice / job card / service-book photo
  constraint service_records_import_evidence check (source <> 'historical_import' or evidence_file_id is not null),
  -- DEC-24: nobody verifies or rejects a record they created
  constraint service_records_no_self_verify check (verified_by is null or verified_by <> created_by),
  constraint service_records_no_self_reject check (rejected_by is null or rejected_by <> created_by),
  constraint service_records_state check (
    (verification_status = 'recorded' and verified_by is null and verified_at is null
       and rejected_by is null and rejected_at is null and rejection_reason is null)
    or (verification_status = 'verified' and verified_by is not null and verified_at is not null
       and rejected_by is null and rejected_at is null and rejection_reason is null)
    or (verification_status = 'rejected' and rejected_by is not null and rejected_at is not null and rejection_reason is not null
       and (verified_by is null) = (verified_at is null)))
);
-- baseline lookup: latest verified record per vehicle (leading columns are the vehicle FK)
create index service_records_vehicle_id_company_id_idx on public.service_records
  (vehicle_id, company_id, verification_status, service_date desc, actual_service_odometer_km desc);
create index service_records_branch_id_company_id_idx       on public.service_records (branch_id, company_id, verification_status);
create index service_records_created_by_company_id_idx      on public.service_records (created_by, company_id);
create index service_records_verified_by_company_id_idx     on public.service_records (verified_by, company_id);
create index service_records_rejected_by_company_id_idx     on public.service_records (rejected_by, company_id);
-- one photo belongs to exactly one record (also covers the evidence_file_id FK)
create unique index service_records_evidence_file_id_uq on public.service_records (evidence_file_id) where evidence_file_id is not null;

-- Content is history: only the decision columns may ever change.
create trigger service_records_immutable before update on public.service_records for each row
  execute function public.prevent_column_change('id', 'company_id', 'branch_id', 'vehicle_id', 'service_date',
    'actual_service_odometer_km', 'actual_service_lifetime_km', 'service_type', 'source', 'supplier_name', 'job_reference',
    'invoice_reference', 'labour_cost', 'parts_cost', 'total_cost', 'evidence_file_id', 'client_submission_id', 'created_by', 'created_at');

-- recorded -> verified | rejected is the decision; verified -> rejected only through the audited reversal function
-- (it sets a transaction-local flag; a client session has no UPDATE grant at all, so this is the second lock).
create function public.service_records_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.verification_status = 'recorded' then
    return new;
  elsif old.verification_status = 'verified' then
    if new.verification_status = 'rejected'
       and current_setting('app.service_reversal', true) = 'on'
       and current_user not in ('authenticated', 'anon')
       and new.verified_by is not distinct from old.verified_by
       and new.verified_at is not distinct from old.verified_at then
      return new;
    end if;
    raise exception 'a verified service record is immutable; use reverse_service_verification() with a reason' using errcode = '55000';
  end if;
  raise exception 'a rejected service record cannot change; record a new one instead' using errcode = '55000';
end $$;
create trigger service_records_guard_t before update on public.service_records for each row execute function public.service_records_guard();

-- New records start `recorded`; the vehicle must be in the company and the record carries the vehicle's current
-- branch; the evidence must be service_record evidence of the same company (like vehicle_documents_validate).
create function public.service_records_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.vehicles;
begin
  if new.verification_status <> 'recorded' then
    raise exception 'a service record is created as recorded and verified separately (DEC-24)' using errcode = '23514';
  end if;
  select * into v from public.vehicles where id = new.vehicle_id and company_id = new.company_id;
  if not found then
    raise exception 'vehicle not found in this company' using errcode = '23514';
  end if;
  if new.branch_id <> v.current_branch_id then
    raise exception 'the record''s branch must be the vehicle''s current branch' using errcode = '23514';
  end if;
  if new.evidence_file_id is not null and not exists (
       select 1 from public.evidence_files f
       where f.id = new.evidence_file_id and f.company_id = new.company_id and f.purpose = 'service_record') then
    raise exception 'evidence file must be service_record evidence of the same company' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger service_records_validate_t before insert on public.service_records for each row execute function public.service_records_validate();
create trigger service_records_no_delete   before delete   on public.service_records for each row       execute function public.forbid_delete();
create trigger service_records_no_truncate before truncate on public.service_records for each statement execute function public.forbid_delete();
create trigger service_records_audit after insert or update or delete on public.service_records
  for each row execute function public.audit_row_change();
revoke execute on function public.service_records_guard(), public.service_records_validate() from public, anon, authenticated;

-- ---------------------------------------------------------------- internal insert (callers have authorised)
create function public.service_record_insert(
  p_company_id uuid, p_user uuid, p_vehicle_id uuid, p_service_date date, p_odometer_km integer, p_service_type text,
  p_source text, p_supplier_name text, p_job_reference text, p_invoice_reference text,
  p_labour_cost numeric, p_parts_cost numeric, p_total_cost numeric, p_evidence_file_id uuid, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.vehicles; v_id uuid;
begin
  select * into v from public.vehicles where id = p_vehicle_id and company_id = p_company_id;
  if not found then
    raise exception 'vehicle not found' using errcode = 'P0002';
  end if;
  if p_service_date is null or p_service_date > (now() at time zone 'Africa/Johannesburg')::date then
    raise exception 'the service date is required and cannot be in the future' using errcode = '22023';
  end if;
  if p_odometer_km is null or p_odometer_km < 0 then
    raise exception 'the service odometer must be a whole number of km, 0 or more' using errcode = '22023';
  end if;
  if p_service_type is null or btrim(p_service_type) = '' or length(btrim(p_service_type)) > 100 then
    raise exception 'a service type (1-100 characters) is required' using errcode = '22023';
  end if;
  insert into public.service_records (company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source,
    supplier_name, job_reference, invoice_reference, labour_cost, parts_cost, total_cost, evidence_file_id, client_submission_id, created_by)
  values (p_company_id, v.current_branch_id, v.id, p_service_date, p_odometer_km, btrim(p_service_type), p_source,
    nullif(btrim(p_supplier_name), ''), nullif(btrim(p_job_reference), ''), nullif(btrim(p_invoice_reference), ''),
    p_labour_cost, p_parts_cost, p_total_cost, p_evidence_file_id, p_client_submission_id, p_user)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.service_record_insert(uuid, uuid, uuid, date, integer, text, text, text, text, text, numeric, numeric, numeric, uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- create (workshop | manual)
create function public.create_service_record(
  p_vehicle_id uuid, p_service_date date, p_odometer_km integer, p_service_type text, p_source text,
  p_supplier_name text, p_job_reference text, p_invoice_reference text,
  p_labour_cost numeric, p_parts_cost numeric, p_total_cost numeric, p_evidence_file_id uuid, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v public.vehicles;
  v_id uuid;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;
  select id into v_id from public.service_records
   where company_id = v_company and created_by = v_uid and client_submission_id = p_client_submission_id;
  if found then
    return v_id;                                   -- idempotent retry
  end if;
  if p_source is null or p_source not in ('workshop', 'manual') then
    raise exception 'source must be workshop or manual; historical baselines come through the reviewed import (DEC-20)' using errcode = '22023';
  end if;
  select * into v from public.vehicles where id = p_vehicle_id and company_id = v_company;
  if not found then
    raise exception 'vehicle not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('service.record.create', v.current_branch_id) then
    raise exception 'missing permission service.record.create for this vehicle''s branch' using errcode = '42501';
  end if;
  return public.service_record_insert(v_company, v_uid, p_vehicle_id, p_service_date, p_odometer_km, p_service_type, p_source,
    p_supplier_name, p_job_reference, p_invoice_reference, p_labour_cost, p_parts_cost, p_total_cost, p_evidence_file_id, p_client_submission_id);
end $$;

-- ---------------------------------------------------------------- verify / reject (a different person, DEC-24)
create function public.verify_service_record(p_record_id uuid, p_decision text, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  r public.service_records;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('verified', 'rejected') then
    raise exception 'decision must be verified or rejected' using errcode = '22023';
  end if;
  if p_decision = 'rejected' and (p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500) then
    raise exception 'a reason (1-500 characters) is required to reject a service record' using errcode = '22023';
  end if;
  select * into r from public.service_records where id = p_record_id and company_id = v_company for update;
  if not found then
    raise exception 'service record not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('service.record.verify', r.branch_id) then
    raise exception 'missing permission service.record.verify for this branch' using errcode = '42501';
  end if;
  if r.created_by = v_uid then
    raise exception 'nobody verifies or rejects a record they created (DEC-24)' using errcode = '42501';
  end if;
  if r.verification_status <> 'recorded' then
    raise exception 'this service record has already been decided' using errcode = '55000';
  end if;
  perform set_config('app.audit_reason',
    case p_decision when 'verified' then 'service record verified' else 'service record rejected: ' || btrim(p_reason) end, true);
  if p_decision = 'verified' then
    update public.service_records set verification_status = 'verified', verified_by = v_uid, verified_at = clock_timestamp() where id = r.id;
  else
    update public.service_records
       set verification_status = 'rejected', rejected_by = v_uid, rejected_at = clock_timestamp(), rejection_reason = btrim(p_reason)
     where id = r.id;
  end if;
  perform set_config('app.audit_reason', '', true);
end $$;

-- ---------------------------------------------------------------- audited reversal of a verification
-- The record becomes `rejected` (so it stops being a baseline), keeps who verified it and when, and the audit row
-- carries the reason. Needs service.record.verify; not the creator (DEC-24).
create function public.reverse_service_verification(p_record_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  r public.service_records;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'a reason (1-500 characters) is required to reverse a verification' using errcode = '22023';
  end if;
  select * into r from public.service_records where id = p_record_id and company_id = v_company for update;
  if not found then
    raise exception 'service record not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('service.record.verify', r.branch_id) then
    raise exception 'missing permission service.record.verify for this branch' using errcode = '42501';
  end if;
  if r.created_by = v_uid then
    raise exception 'nobody corrects a record they created (DEC-24)' using errcode = '42501';
  end if;
  if r.verification_status <> 'verified' then
    raise exception 'only a verified service record can be reversed' using errcode = '55000';
  end if;
  perform set_config('app.audit_reason', 'service record verification reversed: ' || btrim(p_reason), true);
  perform set_config('app.service_reversal', 'on', true);
  update public.service_records
     set verification_status = 'rejected', rejected_by = v_uid, rejected_at = clock_timestamp(),
         rejection_reason = 'Verification reversed: ' || btrim(p_reason)
   where id = r.id;
  perform set_config('app.service_reversal', '', true);
  perform set_config('app.audit_reason', '', true);
end $$;

revoke all on function
  public.create_service_record(uuid, date, integer, text, text, text, text, text, numeric, numeric, numeric, uuid, uuid),
  public.verify_service_record(uuid, text, text),
  public.reverse_service_verification(uuid, text)
  from public, anon;
grant execute on function
  public.create_service_record(uuid, date, integer, text, text, text, text, text, numeric, numeric, numeric, uuid, uuid),
  public.verify_service_record(uuid, text, text),
  public.reverse_service_verification(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------- RLS + grants (deny by default)
alter table public.service_records enable row level security;
revoke all on public.service_records from public, anon, authenticated;
grant select on public.service_records to authenticated;
-- Visible to those who record or verify services for the record's branch (company-wide grants cover every branch).
-- Everyone else reads the derived baseline through vehicle_service_status, never the raw record (costs, references).
create policy service_records_select on public.service_records for select to authenticated
  using (company_id = (select public.current_company_id())
         and (public.has_permission('service.record.create', branch_id) or public.has_permission('service.record.verify', branch_id)));
