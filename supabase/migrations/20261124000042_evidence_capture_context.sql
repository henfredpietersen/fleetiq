-- 042 — Slice 4B (2/4): evidence capture context — restricted capture location, captured_offline, device (DEC-06, DEC-29, DEC-35).
-- evidence_upload_slots and evidence_files gain: capture_latitude numeric(9,6), capture_longitude numeric(9,6),
--   capture_location_accuracy_m numeric(8,1) (all nullable, range CHECKs), captured_offline boolean not null default false,
--   device_id uuid (nullable; composite FK to company_devices; covering index). exif_gps_stripped is kept: the stored FILE still
--   never carries EXIF/XMP GPS — the location lives only in these columns.
-- DROP + CREATE (no overload): request_evidence_upload_slot gains p_capture_latitude, p_capture_longitude,
--   p_capture_location_accuracy_m, p_captured_offline, p_device_key (all defaulted: every Phase 1 call still works). Same ACLs.
-- CREATE OR REPLACE (same signature, ACL unchanged): register_evidence_file copies the slot's context to evidence_files.
--   It needs no new parameter: the slot already holds everything the client sent when it asked for it.
-- Replaced: audit_row_change (location columns never copied into audit_logs, which system administrators can read).
-- Column-level SELECT grants replace the table-wide ones on both tables: capture_latitude / capture_longitude /
--   capture_location_accuracy_m are readable through the table by NO role (authenticated, service_role, anyone).
-- Added: evidence_capture_location(evidence_file_id) — odometer.exception.review holders for the file's branch only (supervisor,
--   fleet administrator, branch manager), never the uploader, every call logged in evidence_access_log as 'location_viewed'.
--   The reviewer rule is a DEFAULT to confirm (DEC-29: "visible only to authorised reviewers").
-- A refused, missing or implausible location never blocks capture: out-of-range or half-supplied values are stored as null.

-- ---------------------------------------------------------------- audit: never copy a capture location into audit_logs
create or replace function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pk text := coalesce(tg_argv[0], 'id');
  -- never store secrets, full licence numbers (DB §17) or a photo's capture location (DEC-29: reviewers only)
  strip text[] := array['pin', 'pin_hash', 'password', 'encrypted_password', 'secret', 'token', 'licence_number',
                  'capture_latitude', 'capture_longitude', 'capture_location_accuracy_m'];
  o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - strip end;
  n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - strip end;
  j jsonb := coalesce(n, o);
  v_company uuid;
  v_branch uuid;
begin
  if tg_table_name = 'companies' then
    v_company := (j ->> 'id')::uuid;
  elsif tg_table_name = 'role_permissions' then
    -- no company_id column: resolve through the role (NULL for system roles)
    select r.company_id into v_company from public.roles r where r.id = (j ->> 'role_id')::uuid;
  else
    v_company := (j ->> 'company_id')::uuid;
  end if;
  if tg_table_name = 'branches' then
    v_branch := (j ->> 'id')::uuid;
  else
    v_branch := (j ->> 'branch_id')::uuid;
  end if;

  insert into public.audit_logs
    (company_id, branch_id, actor_id, action, entity_type, entity_id,
     before_values, after_values, reason, request_reference, metadata)
  values
    (v_company, v_branch,
     -- app.actor_id is honoured only when there is no authenticated user (service-role admin functions)
     coalesce(auth.uid(), nullif(current_setting('app.actor_id', true), '')::uuid),
     lower(tg_op), tg_table_name, (j ->> pk)::uuid,
     o, n,
     nullif(current_setting('app.audit_reason', true), ''),
     nullif(current_setting('app.request_reference', true), ''),
     jsonb_build_object('session_user', session_user)
       || case when tg_table_name = 'role_permissions'
               then jsonb_build_object('permission_id', j ->> 'permission_id') else '{}'::jsonb end);
  return null;
end $$;

revoke all on function public.audit_row_change() from public, anon, authenticated;

-- ---------------------------------------------------------------- columns
alter table public.evidence_upload_slots
  add column capture_latitude numeric(9, 6) check (capture_latitude between -90 and 90),
  add column capture_longitude numeric(9, 6) check (capture_longitude between -180 and 180),
  add column capture_location_accuracy_m numeric(8, 1) check (capture_location_accuracy_m >= 0),
  add column captured_offline boolean not null default false,
  add column device_id uuid,
  add constraint evidence_slots_location_pair check ((capture_latitude is null) = (capture_longitude is null)),
  add constraint evidence_slots_device_fk foreign key (device_id, company_id) references public.company_devices (id, company_id);
alter table public.evidence_files
  add column capture_latitude numeric(9, 6) check (capture_latitude between -90 and 90),
  add column capture_longitude numeric(9, 6) check (capture_longitude between -180 and 180),
  add column capture_location_accuracy_m numeric(8, 1) check (capture_location_accuracy_m >= 0),
  add column captured_offline boolean not null default false,
  add column device_id uuid,
  add constraint evidence_files_location_pair check ((capture_latitude is null) = (capture_longitude is null)),
  add constraint evidence_files_device_fk foreign key (device_id, company_id) references public.company_devices (id, company_id);
create index evidence_slots_device_company_idx on public.evidence_upload_slots (device_id, company_id);
create index evidence_files_device_company_idx on public.evidence_files (device_id, company_id);
comment on column public.evidence_files.capture_latitude is 'DEC-29: restricted. Not readable through the table by any role; see evidence_capture_location().';
comment on column public.evidence_files.capture_longitude is 'DEC-29: restricted. Not readable through the table by any role; see evidence_capture_location().';
comment on column public.evidence_files.capture_location_accuracy_m is 'DEC-29: restricted. Not readable through the table by any role; see evidence_capture_location().';
comment on column public.evidence_files.captured_offline is 'DEC-06: the phone had no connection when the photo was taken (as it reported). Untrusted.';
comment on column public.evidence_files.device_id is 'DEC-35: the registered company device the upload came from, resolved from the phone''s untrusted device key; null when the key is unknown or absent.';

-- ---------------------------------------------------------------- column-level grants (replace the table-wide SELECT)
revoke select on public.evidence_upload_slots, public.evidence_files from authenticated, service_role;
grant select (id, company_id, branch_id, bucket, object_path, purpose, capture_source, declared_mime_type, declared_size_bytes,
              device_capture_at, requested_by, client_submission_id, status, expires_at, evidence_file_id, object_removed_at,
              created_at, updated_at, captured_offline, device_id)
  on public.evidence_upload_slots to authenticated, service_role;
grant select (id, company_id, branch_id, bucket, object_path, sha256, perceptual_hash, mime_type, size_bytes, width, height,
              capture_source, device_capture_at, server_received_at, exif_gps_stripped, uploaded_by, purpose, retention_class,
              legal_hold, created_at, captured_offline, device_id)
  on public.evidence_files to authenticated, service_role;

-- ---------------------------------------------------------------- access log: location views
alter table public.evidence_access_log drop constraint evidence_access_log_access_type_check;
alter table public.evidence_access_log add constraint evidence_access_log_access_type_check
  check (access_type in ('signed_url_issued', 'download', 'location_viewed'));

-- ---------------------------------------------------------------- step 1 (replaced): request an upload slot
drop function public.request_evidence_upload_slot(text, uuid, text, text, bigint, uuid, timestamptz, integer);
create function public.request_evidence_upload_slot(
  p_purpose text, p_branch_id uuid, p_capture_source text, p_mime_type text, p_size_bytes bigint,
  p_client_submission_id uuid, p_device_capture_at timestamptz default null, p_ttl_minutes integer default 15,
  p_capture_latitude numeric default null, p_capture_longitude numeric default null,
  p_capture_location_accuracy_m numeric default null, p_captured_offline boolean default false, p_device_key uuid default null
) returns public.evidence_upload_slots
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_perm text := public.evidence_upload_permission(p_purpose);
  v_ttl integer := least(greatest(coalesce(p_ttl_minutes, 15), 1), 120);
  v_ext text;
  v_lat numeric(9, 6);
  v_lon numeric(9, 6);
  v_acc numeric(8, 1);
  v_device uuid;
  s public.evidence_upload_slots;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if v_perm is null then
    raise exception 'unknown evidence purpose' using errcode = '22023';
  end if;
  if p_capture_source is null or p_capture_source not in ('in_app_camera', 'gallery', 'file_upload') then
    raise exception 'invalid capture source' using errcode = '22023';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;
  if not public.has_permission(v_perm, p_branch_id) then
    raise exception 'not permitted to upload % evidence here', p_purpose using errcode = '42501';
  end if;

  v_ext := case p_mime_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' else 'bin' end;
  -- location is optional and never blocks: a missing, half-supplied or out-of-range value is simply not stored (DEC-29)
  if p_capture_latitude between -90 and 90 and p_capture_longitude between -180 and 180 then
    v_lat := p_capture_latitude; v_lon := p_capture_longitude;
    v_acc := case when p_capture_location_accuracy_m >= 0 and p_capture_location_accuracy_m < 1000000 then p_capture_location_accuracy_m end;
  end if;
  -- the device key is untrusted: unknown = null (flagged later, never refused)
  if p_device_key is not null then
    select d.id into v_device from public.company_devices d where d.company_id = v_company and d.device_key = p_device_key;
  end if;

  for i in 1..2 loop
    select * into s from public.evidence_upload_slots
     where company_id = v_company and requested_by = v_uid and client_submission_id = p_client_submission_id
     for update;
    if found then
      if s.purpose <> p_purpose or s.branch_id is distinct from p_branch_id or s.declared_mime_type <> p_mime_type then
        raise exception 'client_submission_id was already used for a different upload' using errcode = '22023';
      end if;
      if s.status <> 'registered' then
        update public.evidence_upload_slots
           set status = 'issued', object_removed_at = null, updated_at = now(),
               expires_at = now() + v_ttl * interval '1 minute'
         where id = s.id
         returning * into s;
      end if;
      return s;
    end if;

    insert into public.evidence_upload_slots
      (company_id, branch_id, object_path, purpose, capture_source, declared_mime_type, declared_size_bytes,
       device_capture_at, requested_by, client_submission_id, expires_at,
       capture_latitude, capture_longitude, capture_location_accuracy_m, captured_offline, device_id)
    values
      (v_company, p_branch_id,
       v_company || '/' || coalesce(p_branch_id::text, 'company') || '/' || p_purpose || '/' || gen_random_uuid() || '.' || v_ext,
       p_purpose, p_capture_source, p_mime_type, p_size_bytes,
       p_device_capture_at, v_uid, p_client_submission_id, now() + v_ttl * interval '1 minute',
       v_lat, v_lon, v_acc, coalesce(p_captured_offline, false), v_device)
    on conflict (company_id, requested_by, client_submission_id) do nothing
    returning * into s;
    if found then
      return s;
    end if;
  end loop;
  raise exception 'could not allocate an upload slot' using errcode = '55P03';
end $$;

-- ---------------------------------------------------------------- step 4 (replaced body, same signature): register
create or replace function public.register_evidence_file(
  p_slot_id uuid, p_user_id uuid, p_sha256 text, p_mime_type text, p_size_bytes bigint,
  p_width integer, p_height integer, p_exif_gps_stripped boolean
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.evidence_upload_slots;
  v_file uuid;
begin
  select * into s from public.evidence_upload_slots where id = p_slot_id for update;
  if not found or s.requested_by <> p_user_id then
    raise exception 'upload slot not found' using errcode = 'EV001';
  end if;
  if s.status = 'registered' then
    return s.evidence_file_id;                                -- idempotent retry
  end if;
  if s.status <> 'issued' then
    raise exception 'upload slot is %', s.status using errcode = 'EV003';
  end if;
  if s.expires_at <= now() then
    raise exception 'upload slot expired' using errcode = 'EV002';
  end if;

  perform set_config('app.actor_id', p_user_id::text, true);  -- audit trigger actor (no auth.uid() here)
  insert into public.evidence_files
    (company_id, branch_id, bucket, object_path, sha256, mime_type, size_bytes, width, height,
     capture_source, device_capture_at, server_received_at, exif_gps_stripped, uploaded_by, purpose,
     capture_latitude, capture_longitude, capture_location_accuracy_m, captured_offline, device_id)
  values
    (s.company_id, s.branch_id, s.bucket, s.object_path, p_sha256, p_mime_type, p_size_bytes, p_width, p_height,
     s.capture_source, s.device_capture_at, now(), p_exif_gps_stripped, s.requested_by, s.purpose,
     s.capture_latitude, s.capture_longitude, s.capture_location_accuracy_m, s.captured_offline, s.device_id)
  returning id into v_file;
  update public.evidence_upload_slots
     set status = 'registered', evidence_file_id = v_file, updated_at = now()
   where id = s.id;
  return v_file;
end $$;

-- ---------------------------------------------------------------- the photo's location (DEC-29): reviewers only, always logged
create function public.evidence_capture_location(p_evidence_file_id uuid)
returns table (latitude numeric, longitude numeric, accuracy_m numeric)
language plpgsql security definer set search_path = '' as $$
declare
  f public.evidence_files;
begin
  select * into f from public.evidence_files x where x.id = p_evidence_file_id;
  -- fail closed with one message: not found, wrong company, no permission, own file and non-reviewer look the same
  if not found or auth.uid() is null
     or f.company_id is distinct from public.current_company_id()
     or f.uploaded_by = auth.uid()
     or not public.has_permission('odometer.exception.review', f.branch_id)
     or not public.can_view_evidence(f.company_id, f.branch_id, f.uploaded_by, f.purpose) then
    raise exception 'location not available' using errcode = '42501';
  end if;
  insert into public.evidence_access_log
    (company_id, branch_id, evidence_file_id, accessed_by, access_type, purpose)
  values (f.company_id, f.branch_id, f.id, auth.uid(), 'location_viewed', 'capture location');
  return query select f.capture_latitude::numeric, f.capture_longitude::numeric, f.capture_location_accuracy_m::numeric;
end $$;
comment on function public.evidence_capture_location(uuid) is
  'DEC-29 (reviewer rule is a default to confirm): odometer.exception.review for the file''s branch and evidence view scope; never the uploader; every successful call is written to evidence_access_log as location_viewed.';

-- ---------------------------------------------------------------- function privileges
revoke all on function
  public.request_evidence_upload_slot(text, uuid, text, text, bigint, uuid, timestamptz, integer, numeric, numeric, numeric, boolean, uuid),
  public.evidence_capture_location(uuid)
  from public, anon, authenticated;
grant execute on function
  public.request_evidence_upload_slot(text, uuid, text, text, bigint, uuid, timestamptz, integer, numeric, numeric, numeric, boolean, uuid),
  public.evidence_capture_location(uuid)
  to authenticated, service_role;
