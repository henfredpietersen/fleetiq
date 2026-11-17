-- Phase 1C — private evidence storage tables (ARCH §6.3, §6.6, §6.7; DB §7; DEC-23, DEC-24, DEC-29, DEC-27).
--   evidence_upload_slots : server-issued upload slots (server-chosen path) — the "upload" step's record
--   evidence_files        : insert-only evidence registry, rows created ONLY by register_evidence_file()
--   evidence_access_log   : append-only; one row for every signed read URL issued
-- Authorisation: has_permission() everywhere (+ the Own/Branch/All narrowing of DEC-23 in
-- evidence_scope_allows()). The UI is never the boundary.

-- ---------------------------------------------------------------- purposes -> permissions
-- DEC-23 has no "upload evidence" permission: uploading evidence is part of the action it supports,
-- so it needs that action's existing permission. Mirrored in the app (domain/purposes.ts, tested).
create function public.evidence_upload_permission(p_purpose text) returns text
language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'odometer'         then 'inspection.submit'
    when 'inspection'       then 'inspection.submit'
    when 'damage'           then 'inspection.submit'
    when 'incident'         then 'incident.record'
    when 'vehicle_document' then 'vehicle.manage'
    when 'licence'          then 'driver.manage'
    when 'service_record'   then 'service.record.create'
  end
$$;

-- ---------------------------------------------------------------- tables
create table public.evidence_upload_slots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid,
  bucket text not null default 'evidence',
  object_path text not null,                                  -- chosen by the server, never by the client
  purpose text not null check (purpose in
    ('odometer', 'inspection', 'damage', 'incident', 'vehicle_document', 'licence', 'service_record')),
  capture_source text not null check (capture_source in ('in_app_camera', 'gallery', 'file_upload')),
  declared_mime_type text not null check (declared_mime_type ~ '^[a-z]+/[a-z0-9.+-]+$'),
  declared_size_bytes bigint not null check (declared_size_bytes > 0),
  device_capture_at timestamptz,                              -- untrusted, optional (ARCH §6.7)
  requested_by uuid not null,
  client_submission_id uuid not null,                         -- idempotency (CLAUDE.md)
  status text not null default 'issued' check (status in ('issued', 'registered', 'abandoned')),
  expires_at timestamptz not null,
  evidence_file_id uuid,                                      -- FK added below (evidence_files comes next)
  object_removed_at timestamptz,                              -- set by the cleanup job after removing the object
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evidence_slots_path unique (bucket, object_path),
  constraint evidence_slots_idempotent unique (company_id, requested_by, client_submission_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (requested_by, company_id) references public.profiles (id, company_id),
  constraint evidence_slots_registered_has_file check ((status = 'registered') = (evidence_file_id is not null))
);

create table public.evidence_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid,
  bucket text not null,
  object_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),     -- computed by the server over the stored bytes
  perceptual_hash text,                                       -- AD-03, later
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  width integer check (width > 0),
  height integer check (height > 0),
  capture_source text not null check (capture_source in ('in_app_camera', 'gallery', 'file_upload', 'import')),
  device_capture_at timestamptz,                              -- untrusted
  server_received_at timestamptz not null default now(),      -- authoritative receipt time
  exif_gps_stripped boolean not null,                         -- DEC-29 (Proposed): true = GPS stripped/absent
  uploaded_by uuid not null,
  purpose text not null check (purpose in
    ('odometer', 'inspection', 'damage', 'incident', 'vehicle_document', 'licence', 'service_record')),
  retention_class text,                                       -- DEC-27 open: no values or periods invented
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  constraint evidence_files_path unique (bucket, object_path),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (uploaded_by, company_id) references public.profiles (id, company_id)
  -- device_id -> company_devices is omitted: DEC-35 is Proposed and that table does not exist yet.
);
create index evidence_files_company_branch_idx on public.evidence_files (company_id, branch_id);

alter table public.evidence_upload_slots
  add constraint evidence_slots_file_fk foreign key (evidence_file_id) references public.evidence_files (id);

create table public.evidence_access_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid,                                             -- copied from the file so the log can be scoped (DB §7 addition)
  evidence_file_id uuid not null references public.evidence_files (id),
  accessed_by uuid not null,
  access_type text not null check (access_type in ('signed_url_issued', 'download')),
  purpose text check (length(purpose) <= 100),
  related_entity_type text check (length(related_entity_type) <= 100),
  related_entity_id uuid,
  occurred_at timestamptz not null default now(),
  foreign key (accessed_by, company_id) references public.profiles (id, company_id)
);
create index evidence_access_log_file_idx on public.evidence_access_log (evidence_file_id, occurred_at desc);

-- ---------------------------------------------------------------- immutability (DB §2 rule 12)
-- evidence_files and evidence_access_log can only ever be inserted: blocked for every role, owner included.
create trigger evidence_files_no_change before update or delete on public.evidence_files
  for each row execute function public.append_only();
create trigger evidence_files_no_truncate before truncate on public.evidence_files
  for each statement execute function public.append_only();
create trigger evidence_access_log_no_change before update or delete on public.evidence_access_log
  for each row execute function public.append_only();
create trigger evidence_access_log_no_truncate before truncate on public.evidence_access_log
  for each statement execute function public.append_only();

create trigger evidence_files_audit after insert or update or delete on public.evidence_files
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- view scope (DEC-23: evidence.view)
-- Matrix: Driver = Own · Supervisor = Branch · Fleet admin = All · Maintenance admin = All (service
-- evidence only) · Branch manager = Branch · Senior management = All · System admin = none.
-- "Branch/All" comes from user_roles.branch_id (AD-05); "Own" and "service evidence" are the row-level
-- narrowing done here. This function can only NARROW: it is always combined with
-- has_permission('evidence.view', branch). Unknown/custom roles fail closed to "own uploads only".
create function public.evidence_scope_allows(p_branch_id uuid, p_uploaded_by uuid, p_purpose text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.company_id = p.company_id
    join public.roles r on r.id = ur.role_id and (r.company_id is null or r.company_id = p.company_id)
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions pm on pm.id = rp.permission_id and pm.permission_key = 'evidence.view'
    where p.id = auth.uid()
      and public.access_cleared(p.id)
      and ur.effective_from <= now()
      and (ur.effective_to is null or ur.effective_to > now())
      and (ur.branch_id is null or ur.branch_id = p_branch_id)
      and case
            when r.company_id is null and r.name in ('supervisor', 'fleet_admin', 'branch_manager', 'senior_management')
              then true
            when r.company_id is null and r.name = 'maintenance_admin'
              then p_purpose = 'service_record'
            else p_uploaded_by = auth.uid()
          end
    limit 1
  ), false)
$$;

create function public.can_view_evidence(p_company_id uuid, p_branch_id uuid, p_uploaded_by uuid, p_purpose text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select p_company_id is not distinct from public.current_company_id()
     and public.has_permission('evidence.view', p_branch_id)
     and public.evidence_scope_allows(p_branch_id, p_uploaded_by, p_purpose)
$$;

-- ---------------------------------------------------------------- RLS
alter table public.evidence_upload_slots enable row level security;
alter table public.evidence_files        enable row level security;
alter table public.evidence_access_log   enable row level security;

revoke all on public.evidence_upload_slots, public.evidence_files, public.evidence_access_log
  from public, anon, authenticated, service_role;
grant select on public.evidence_upload_slots, public.evidence_files, public.evidence_access_log
  to authenticated, service_role;
-- All writes go through the SECURITY DEFINER functions below; clients have no INSERT/UPDATE/DELETE.

create policy evidence_slots_select on public.evidence_upload_slots for select to authenticated
  using (requested_by = auth.uid() and company_id = public.current_company_id());

create policy evidence_files_select on public.evidence_files for select to authenticated
  using (public.can_view_evidence(company_id, branch_id, uploaded_by, purpose));

-- The access log is audit material: readable with audit.view for the file's branch (NULL = company-wide).
create policy evidence_access_log_select on public.evidence_access_log for select to authenticated
  using (company_id = public.current_company_id() and public.has_permission('audit.view', branch_id));

-- ---------------------------------------------------------------- step 1: request an upload slot
-- Permission check, then a SERVER-CHOSEN path. Idempotent on (company, user, client_submission_id):
-- a retry returns the same slot (re-opened with a fresh expiry if it lapsed or was cleaned up).
create function public.request_evidence_upload_slot(
  p_purpose text, p_branch_id uuid, p_capture_source text, p_mime_type text, p_size_bytes bigint,
  p_client_submission_id uuid, p_device_capture_at timestamptz default null, p_ttl_minutes integer default 15
) returns public.evidence_upload_slots
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_perm text := public.evidence_upload_permission(p_purpose);
  v_ttl integer := least(greatest(coalesce(p_ttl_minutes, 15), 1), 120);
  v_ext text;
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
       device_capture_at, requested_by, client_submission_id, expires_at)
    values
      (v_company, p_branch_id,
       v_company || '/' || coalesce(p_branch_id::text, 'company') || '/' || p_purpose || '/' || gen_random_uuid() || '.' || v_ext,
       p_purpose, p_capture_source, p_mime_type, p_size_bytes,
       p_device_capture_at, v_uid, p_client_submission_id, now() + v_ttl * interval '1 minute')
    on conflict (company_id, requested_by, client_submission_id) do nothing
    returning * into s;
    if found then
      return s;
    end if;
  end loop;
  raise exception 'could not allocate an upload slot' using errcode = '55P03';
end $$;

-- ---------------------------------------------------------------- step 4: register (service role only)
-- Called by the reviewed server registration step AFTER it verified the object, MIME, size, computed
-- the SHA-256 and stripped EXIF GPS. Inserts the evidence_files row exactly once per slot.
create function public.register_evidence_file(
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
     capture_source, device_capture_at, server_received_at, exif_gps_stripped, uploaded_by, purpose)
  values
    (s.company_id, s.branch_id, s.bucket, s.object_path, p_sha256, p_mime_type, p_size_bytes, p_width, p_height,
     s.capture_source, s.device_capture_at, now(), p_exif_gps_stripped, s.requested_by, s.purpose)
  returning id into v_file;
  update public.evidence_upload_slots
     set status = 'registered', evidence_file_id = v_file, updated_at = now()
   where id = s.id;
  return v_file;
end $$;

-- ---------------------------------------------------------------- signed read URL: check + log
-- The caller (server) then creates the signed URL with the USER's client (storage policy below).
-- Fail-closed: no permission -> exception, no log row, no path. Every success writes the log row.
create function public.issue_evidence_access(
  p_evidence_file_id uuid, p_purpose text default 'view',
  p_related_entity_type text default null, p_related_entity_id uuid default null
) returns table (bucket text, object_path text)
language plpgsql security definer set search_path = '' as $$
declare f public.evidence_files;
begin
  select * into f from public.evidence_files where id = p_evidence_file_id;
  if not found or auth.uid() is null
     or not public.can_view_evidence(f.company_id, f.branch_id, f.uploaded_by, f.purpose) then
    raise exception 'evidence not available' using errcode = '42501';
  end if;
  insert into public.evidence_access_log
    (company_id, branch_id, evidence_file_id, accessed_by, access_type, purpose, related_entity_type, related_entity_id)
  values
    (f.company_id, f.branch_id, f.id, auth.uid(), 'signed_url_issued',
     left(coalesce(p_purpose, 'view'), 100), left(p_related_entity_type, 100), p_related_entity_id);
  return query select f.bucket, f.object_path;
end $$;

-- ---------------------------------------------------------------- cleanup of unregistered uploads (service role)
-- Slots never registered within expiry + grace are flipped to 'abandoned' and returned (together with
-- earlier abandoned slots whose object is still to be removed). Registered evidence is never touched.
create function public.claim_abandoned_evidence_slots(p_grace_minutes integer, p_limit integer default 100)
returns table (id uuid, bucket text, object_path text)
language plpgsql security definer set search_path = '' as $$
begin
  update public.evidence_upload_slots s
     set status = 'abandoned', updated_at = now()
   where s.id in (
     select s2.id from public.evidence_upload_slots s2
      where s2.status = 'issued'
        and s2.expires_at < now() - make_interval(mins => greatest(coalesce(p_grace_minutes, 0), 0))
        and not exists (select 1 from public.evidence_files f
                         where f.bucket = s2.bucket and f.object_path = s2.object_path)
      order by s2.expires_at
      limit greatest(coalesce(p_limit, 100), 1)
      for update skip locked);
  return query
    select s.id, s.bucket, s.object_path from public.evidence_upload_slots s
     where s.status = 'abandoned' and s.object_removed_at is null
     order by s.updated_at
     limit greatest(coalesce(p_limit, 100), 1);
end $$;

create function public.mark_evidence_slots_object_removed(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.evidence_upload_slots
     set object_removed_at = now(), updated_at = now()
   where id = any (p_ids) and status = 'abandoned';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- storage helpers (used by storage policies)
create function public.evidence_slot_open_for_upload(p_bucket text, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.evidence_upload_slots s
    where s.bucket = p_bucket and s.object_path = p_path
      and s.requested_by = auth.uid()
      and s.company_id = public.current_company_id()
      and s.status = 'issued'
      and s.expires_at > now()
      and public.has_permission(public.evidence_upload_permission(s.purpose), s.branch_id)
  )
$$;

create function public.evidence_object_readable(p_bucket text, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.evidence_files f
    where f.bucket = p_bucket and f.object_path = p_path
      and public.can_view_evidence(f.company_id, f.branch_id, f.uploaded_by, f.purpose)
  )
$$;

-- ---------------------------------------------------------------- function privileges
revoke all on function
  public.evidence_upload_permission(text),
  public.evidence_scope_allows(uuid, uuid, text),
  public.can_view_evidence(uuid, uuid, uuid, text),
  public.request_evidence_upload_slot(text, uuid, text, text, bigint, uuid, timestamptz, integer),
  public.register_evidence_file(uuid, uuid, text, text, bigint, integer, integer, boolean),
  public.issue_evidence_access(uuid, text, text, uuid),
  public.claim_abandoned_evidence_slots(integer, integer),
  public.mark_evidence_slots_object_removed(uuid[]),
  public.evidence_slot_open_for_upload(text, text),
  public.evidence_object_readable(text, text)
  from public, anon, authenticated;

-- user-facing (RLS policies and storage policies run these as the caller)
grant execute on function
  public.evidence_upload_permission(text),
  public.evidence_scope_allows(uuid, uuid, text),
  public.can_view_evidence(uuid, uuid, uuid, text),
  public.request_evidence_upload_slot(text, uuid, text, text, bigint, uuid, timestamptz, integer),
  public.issue_evidence_access(uuid, text, text, uuid),
  public.evidence_slot_open_for_upload(text, text),
  public.evidence_object_readable(text, text)
  to authenticated, service_role;
-- service-role only (reviewed server paths / jobs, ARCH §5.3)
grant execute on function
  public.register_evidence_file(uuid, uuid, text, text, bigint, integer, integer, boolean),
  public.claim_abandoned_evidence_slots(integer, integer),
  public.mark_evidence_slots_object_removed(uuid[])
  to service_role;
