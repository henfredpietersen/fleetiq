-- 024 — Slice 2C: reviewed baseline import (PRD §5.10.7; DEC-20 baseline evidence + verifier; DEC-24; ARCH §8.4, §10).
-- Flow: CSV (parsed by the app) -> stage_service_import() -> staging rows with a validation report (unknown vehicle,
-- bad dates or odometers, duplicates) -> for each VALID row the importer attaches the evidence photo
-- (attach_import_row_evidence()) which creates a service_record with source historical_import, status recorded ->
-- a maintenance administrator who is NOT the importer verifies each record separately (verify_service_record, 023).
-- Nothing here sets a baseline: staging rows and `recorded` records never do.
-- Conventions: FK covering indexes (same column order); (select ...) around argument-free calls in RLS; explicit
-- REVOKE on every function; no INSERT/UPDATE/DELETE grants; no hard deletes; audit triggers.

create table public.service_import_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  filename text not null check (length(btrim(filename)) between 1 and 200),
  client_submission_id uuid not null,              -- idempotency
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  unique (id, company_id),
  constraint service_import_batches_idempotent unique (company_id, created_by, client_submission_id)
);
create index service_import_batches_created_by_company_id_idx on public.service_import_batches (created_by, company_id);

create table public.service_import_rows (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  batch_id uuid not null,
  row_number integer not null check (row_number >= 1),
  created_by uuid not null,                        -- the importer (copied from the batch)
  -- as uploaded (text, length-limited) ...
  registration_number text check (length(registration_number) <= 60),
  service_date_raw text check (length(service_date_raw) <= 60),
  odometer_raw text check (length(odometer_raw) <= 60),
  service_type text check (length(service_type) <= 120),
  supplier_name text check (length(supplier_name) <= 220),
  job_reference text check (length(job_reference) <= 120),
  invoice_reference text check (length(invoice_reference) <= 120),
  -- ... and as parsed by the database
  vehicle_id uuid,
  service_date date,
  odometer_km integer check (odometer_km >= 0),
  row_status text not null check (row_status in ('invalid', 'valid', 'imported')),
  errors text[] not null default '{}',             -- machine codes, see stage_service_import()
  service_record_id uuid,
  created_at timestamptz not null default now(),
  foreign key (batch_id, company_id) references public.service_import_batches (id, company_id),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  foreign key (service_record_id, company_id) references public.service_records (id, company_id),
  constraint service_import_rows_row_uq unique (batch_id, row_number),
  constraint service_import_rows_shape check (
    (row_status = 'invalid'  and cardinality(errors) > 0 and service_record_id is null)
    or (row_status = 'valid' and cardinality(errors) = 0 and service_record_id is null
        and vehicle_id is not null and service_date is not null and odometer_km is not null and service_type is not null)
    or (row_status = 'imported' and cardinality(errors) = 0 and service_record_id is not null))
);
create index service_import_rows_company_id_batch_idx          on public.service_import_rows (company_id, batch_id);
create index service_import_rows_created_by_company_id_idx     on public.service_import_rows (created_by, company_id);
create index service_import_rows_vehicle_id_company_id_idx     on public.service_import_rows (vehicle_id, company_id);
create unique index service_import_rows_service_record_id_uq   on public.service_import_rows (service_record_id, company_id) where service_record_id is not null;

create trigger service_import_batches_immutable before update on public.service_import_batches for each row
  execute function public.prevent_column_change('id', 'company_id', 'filename', 'client_submission_id', 'created_by', 'created_at');
-- staging content never changes; a valid row becomes imported exactly once
create trigger service_import_rows_immutable before update on public.service_import_rows for each row
  execute function public.prevent_column_change('id', 'company_id', 'batch_id', 'row_number', 'created_by', 'registration_number',
    'service_date_raw', 'odometer_raw', 'service_type', 'supplier_name', 'job_reference', 'invoice_reference', 'vehicle_id',
    'service_date', 'odometer_km', 'errors', 'created_at');
create function public.service_import_rows_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not (old.row_status = 'valid' and new.row_status = 'imported') then
    raise exception 'a staging row can only move from valid to imported' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger service_import_rows_guard_t before update on public.service_import_rows for each row execute function public.service_import_rows_guard();
revoke execute on function public.service_import_rows_guard() from public, anon, authenticated;
create trigger service_import_batches_no_delete   before delete   on public.service_import_batches for each row       execute function public.forbid_delete();
create trigger service_import_batches_no_truncate before truncate on public.service_import_batches for each statement execute function public.forbid_delete();
create trigger service_import_rows_no_delete      before delete   on public.service_import_rows    for each row       execute function public.forbid_delete();
create trigger service_import_rows_no_truncate    before truncate on public.service_import_rows    for each statement execute function public.forbid_delete();
create trigger service_import_batches_audit after insert or update or delete on public.service_import_batches
  for each row execute function public.audit_row_change();
create trigger service_import_rows_audit after insert or update or delete on public.service_import_rows
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- stage + validate
-- p_rows: a JSON array (max 500) of objects with string values: registration_number, service_date (YYYY-MM-DD),
-- odometer_km (whole km, digits only), service_type, supplier_name, job_reference, invoice_reference.
-- Error codes per row: missing_registration, unknown_vehicle (also used when the caller may not record services for the
-- vehicle's branch, so existence is not leaked), invalid_date, future_date, invalid_odometer, missing_service_type,
-- field_too_long, duplicate_in_file, duplicate_existing.
create function public.stage_service_import(p_filename text, p_rows jsonb, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_batch uuid;
  e record;
  v public.vehicles;
  v_errors text[];
  v_reg text; v_date_raw text; v_odo_raw text; v_type text; v_sup text; v_job text; v_inv text;
  v_date date; v_odo integer;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_seen text[] := '{}';
  v_key text;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;
  select id into v_batch from public.service_import_batches
   where company_id = v_company and created_by = v_uid and client_submission_id = p_client_submission_id;
  if found then
    return v_batch;                                -- idempotent retry
  end if;
  if not exists (select 1 from public.branches b where b.company_id = v_company and public.has_permission('service.record.create', b.id)) then
    raise exception 'missing permission service.record.create' using errcode = '42501';
  end if;
  if p_filename is null or btrim(p_filename) = '' or length(p_filename) > 200 then
    raise exception 'a file name (1-200 characters) is required' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 500 then
    raise exception 'the import needs between 1 and 500 rows' using errcode = '22023';
  end if;

  insert into public.service_import_batches (company_id, filename, client_submission_id, created_by)
  values (v_company, btrim(p_filename), p_client_submission_id, v_uid) returning id into v_batch;

  for e in select value, ordinality from jsonb_array_elements(p_rows) with ordinality loop
    v_errors := '{}'; v := null; v_date := null; v_odo := null;
    if jsonb_typeof(e.value) <> 'object' then
      raise exception 'row % is not an object', e.ordinality using errcode = '22023';
    end if;
    v_reg      := nullif(btrim(e.value ->> 'registration_number'), '');
    v_date_raw := nullif(btrim(e.value ->> 'service_date'), '');
    v_odo_raw  := nullif(btrim(e.value ->> 'odometer_km'), '');
    v_type     := nullif(btrim(e.value ->> 'service_type'), '');
    v_sup      := nullif(btrim(e.value ->> 'supplier_name'), '');
    v_job      := nullif(btrim(e.value ->> 'job_reference'), '');
    v_inv      := nullif(btrim(e.value ->> 'invoice_reference'), '');

    if length(coalesce(v_reg, '')) > 60 or length(coalesce(v_date_raw, '')) > 60 or length(coalesce(v_odo_raw, '')) > 60
       or length(coalesce(v_type, '')) > 100 or length(coalesce(v_sup, '')) > 200
       or length(coalesce(v_job, '')) > 100 or length(coalesce(v_inv, '')) > 100 then
      v_errors := array_append(v_errors, 'field_too_long');
    end if;

    if v_reg is null then
      v_errors := array_append(v_errors, 'missing_registration');
    else
      select * into v from public.vehicles where company_id = v_company and registration_number = upper(v_reg);
      if not found or not public.has_permission('service.record.create', v.current_branch_id) then
        v := null;
        v_errors := array_append(v_errors, 'unknown_vehicle');
      end if;
    end if;

    if v_date_raw is null or v_date_raw !~ '^\d{4}-\d{2}-\d{2}$' then
      v_errors := array_append(v_errors, 'invalid_date');
    else
      begin
        v_date := v_date_raw::date;
        if to_char(v_date, 'YYYY-MM-DD') <> v_date_raw then
          v_date := null; v_errors := array_append(v_errors, 'invalid_date');
        elsif v_date > v_today then
          v_errors := array_append(v_errors, 'future_date');
        end if;
      exception when others then
        v_date := null; v_errors := array_append(v_errors, 'invalid_date');
      end;
    end if;

    if v_odo_raw is null or v_odo_raw !~ '^\d{1,9}$' or v_odo_raw::bigint > 2147483647 then
      v_errors := array_append(v_errors, 'invalid_odometer');
    else
      v_odo := v_odo_raw::integer;
    end if;

    if v_type is null then
      v_errors := array_append(v_errors, 'missing_service_type');
    end if;

    if v.id is not null and v_date is not null and v_odo is not null then
      v_key := v.id::text || '|' || v_date::text || '|' || v_odo::text;
      if v_key = any (v_seen) then
        v_errors := array_append(v_errors, 'duplicate_in_file');
      end if;
      v_seen := v_seen || v_key;
      if exists (select 1 from public.service_records r
                  where r.company_id = v_company and r.vehicle_id = v.id and r.service_date = v_date
                    and r.actual_service_odometer_km = v_odo and r.verification_status <> 'rejected') then
        v_errors := array_append(v_errors, 'duplicate_existing');
      end if;
    end if;

    insert into public.service_import_rows (company_id, batch_id, row_number, created_by, registration_number, service_date_raw,
      odometer_raw, service_type, supplier_name, job_reference, invoice_reference, vehicle_id, service_date, odometer_km,
      row_status, errors)
    values (v_company, v_batch, e.ordinality, v_uid, left(v_reg, 60), left(v_date_raw, 60), left(v_odo_raw, 60), left(v_type, 120),
      left(v_sup, 220), left(v_job, 120), left(v_inv, 120), v.id, v_date, v_odo,
      case when cardinality(v_errors) = 0 then 'valid' else 'invalid' end, v_errors);
  end loop;
  return v_batch;
end $$;

-- ---------------------------------------------------------------- attach the evidence -> a `recorded` historical_import record
-- Only the importer, only for a valid row, once (a retry returns the same record). DEC-20: no evidence, no record.
create function public.attach_import_row_evidence(p_row_id uuid, p_evidence_file_id uuid, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  r public.service_import_rows;
  v public.vehicles;
  v_record uuid;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_evidence_file_id is null then
    raise exception 'evidence (invoice, job card or service-book photo) is required for a historical baseline (DEC-20)' using errcode = '22023';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;
  select * into r from public.service_import_rows where id = p_row_id and company_id = v_company for update;
  if not found or r.created_by <> v_uid then
    raise exception 'import row not found' using errcode = 'P0002';
  end if;
  if r.row_status = 'imported' then
    return r.service_record_id;                    -- idempotent retry
  end if;
  if r.row_status <> 'valid' then
    raise exception 'this row failed validation and cannot be imported' using errcode = '55000';
  end if;
  select * into v from public.vehicles where id = r.vehicle_id and company_id = v_company;
  if not found or not public.has_permission('service.record.create', v.current_branch_id) then
    raise exception 'missing permission service.record.create for this vehicle''s branch' using errcode = '42501';
  end if;
  v_record := public.service_record_insert(v_company, v_uid, r.vehicle_id, r.service_date, r.odometer_km, r.service_type,
    'historical_import', r.supplier_name, r.job_reference, r.invoice_reference, null, null, null, p_evidence_file_id, p_client_submission_id);
  update public.service_import_rows set row_status = 'imported', service_record_id = v_record where id = r.id;
  return v_record;
end $$;

revoke all on function public.stage_service_import(text, jsonb, uuid), public.attach_import_row_evidence(uuid, uuid, uuid) from public, anon;
grant execute on function public.stage_service_import(text, jsonb, uuid), public.attach_import_row_evidence(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- RLS + grants (deny by default)
alter table public.service_import_batches enable row level security;
alter table public.service_import_rows    enable row level security;
revoke all on public.service_import_batches, public.service_import_rows from public, anon, authenticated;
grant select on public.service_import_batches, public.service_import_rows to authenticated;
-- The importer sees their own staging; holders of a company-wide service.record.verify grant can review any batch.
create policy service_import_batches_select on public.service_import_batches for select to authenticated
  using (company_id = (select public.current_company_id())
         and (created_by = (select auth.uid()) or (select public.has_permission('service.record.verify', null))));
create policy service_import_rows_select on public.service_import_rows for select to authenticated
  using (company_id = (select public.current_company_id())
         and (created_by = (select auth.uid()) or (select public.has_permission('service.record.verify', null))));
