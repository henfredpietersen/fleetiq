-- 046 — Slice 4C (1/3): the known-damage register (PRD v1.18 §4.2, §5.7, §5.12, §6; ARCH v1.17 §6.2–§6.4; DB v1.13 §6, §7, §20;
-- DEC-04/41 in-app camera only, DEC-06, DEC-23 (no new permission keys), DEC-24, DEC-29, DEC-37, DEC-42).
-- Added:    damage_zones(), damage_zone_label() (the ONE zone list); vehicle_damage_items; vehicle_damage_evidence; damage_requests
--           (idempotency ledger for review / repair); evidence_check_attachable() (the ONE evidence rule); damage_driver_has_live_allocation();
--           triggers (validate, guard, no delete/truncate, audit, updated_at, "at least one photo", evidence append-only); RLS (reads only).
-- Replaced (CREATE OR REPLACE, same signature, ACL unchanged):
--           inspection_check_evidence (now delegates to evidence_check_attachable; same messages and SQLSTATEs);
--           request_evidence_upload_slot (ONE change: purpose 'damage' may also be requested by allocation.manage holders for the branch,
--           because onboarding (DEC-42) is done by managers who do not all hold inspection.submit; every other purpose is unchanged).
-- Added constraint: inspections UNIQUE (id, vehicle_id, inspection_stage) — target so a damage item can never point at another vehicle's inspection.
-- Write model: NO client INSERT/UPDATE/DELETE grants. Rows are written only by the SECURITY DEFINER functions in 047.
-- Statuses: reported -> verified | disputed; verified -> repaired. disputed and repaired are final (DEC-42). Nothing is deleted.
-- Refusals added: DM001 not found/not allowed   DM002 wrong status for that step   DM003 own report (DEC-24)   DM004 a reason/note is required
--                 DM005 bad zone/severity/description   DM006 a report needs at least one photo   DM007 inspection not open for damage

-- ---------------------------------------------------------------- zones: ONE list (mirrored in src/modules/inspections-damage/domain/damage-zones.ts, tested)
create function public.damage_zones() returns text[]
language sql immutable set search_path = '' as $$
  select array['front_bumper', 'bonnet', 'windscreen', 'roof', 'rear_bumper', 'rear_boot_load_area', 'left_front', 'left_rear',
               'right_front', 'right_rear', 'wheels_tyres', 'interior', 'other']
$$;
create function public.damage_zone_label(p_zone text) returns text
language sql immutable set search_path = '' as $$
  select case p_zone
    when 'front_bumper'        then 'Front bumper'
    when 'bonnet'              then 'Bonnet'
    when 'windscreen'          then 'Windscreen'
    when 'roof'                then 'Roof'
    when 'rear_bumper'         then 'Rear bumper'
    when 'rear_boot_load_area' then 'Rear (boot or load area)'
    when 'left_front'          then 'Left front (door and wing)'
    when 'left_rear'           then 'Left rear (door and wing)'
    when 'right_front'         then 'Right front (door and wing)'
    when 'right_rear'          then 'Right rear (door and wing)'
    when 'wheels_tyres'        then 'Wheels and tyres'
    when 'interior'            then 'Interior'
    when 'other'               then 'Other'
  end
$$;
revoke all on function public.damage_zones(), public.damage_zone_label(text) from public, anon;
grant execute on function public.damage_zones(), public.damage_zone_label(text) to authenticated, service_role;

alter table public.inspections add constraint inspections_id_vehicle_stage_uq unique (id, vehicle_id, inspection_stage);

-- ---------------------------------------------------------------- vehicle_damage_items (DB §6)
create table public.vehicle_damage_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  vehicle_id uuid not null,
  zone text not null check (zone = any (public.damage_zones())),
  severity text not null check (severity in ('minor', 'moderate', 'major')),
  description text not null check (length(description) between 1 and 500),
  status text not null default 'reported' check (status in ('reported', 'verified', 'disputed', 'repaired')),
  source text not null check (source in ('inspection', 'onboarding')),
  reported_in_inspection_id uuid,
  reported_stage text check (reported_stage in ('pre_shift', 'post_shift')),
  reported_by uuid not null,
  reported_at timestamptz not null default now(),                 -- server time
  device_reported_at timestamptz,                                 -- untrusted (DEC-06)
  captured_offline boolean not null default false,
  interval_previous_allocation_id uuid,                           -- pre-shift reports only: the vehicle's previous allocation (by chronology)
  interval_previous_inspection_id uuid,                           -- ... and its submitted post-shift inspection, if any
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text check (length(review_reason) between 1 and 500),
  repaired_by uuid,
  repaired_at timestamptz,
  repair_note text check (length(repair_note) between 1 and 500),
  incident_id uuid,                                               -- reserved for Phase 9; no FK yet
  client_submission_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  foreign key (reported_in_inspection_id, vehicle_id, reported_stage) references public.inspections (id, vehicle_id, inspection_stage),
  foreign key (reported_by, company_id) references public.profiles (id, company_id),
  foreign key (reviewed_by, company_id) references public.profiles (id, company_id),
  foreign key (repaired_by, company_id) references public.profiles (id, company_id),
  foreign key (interval_previous_allocation_id, company_id) references public.vehicle_allocations (id, company_id),
  foreign key (interval_previous_inspection_id, company_id) references public.inspections (id, company_id),
  unique (id, company_id),
  constraint vdi_idempotent unique (company_id, reported_by, client_submission_id),
  constraint vdi_source_inspection check ((source = 'inspection') = (reported_in_inspection_id is not null)
                                          and (reported_in_inspection_id is null) = (reported_stage is null)),
  constraint vdi_interval_pre_only check ((interval_previous_allocation_id is null and interval_previous_inspection_id is null) or reported_stage = 'pre_shift'),
  constraint vdi_interval_inspection_needs_allocation check (interval_previous_inspection_id is null or interval_previous_allocation_id is not null),
  constraint vdi_review_fields check (
    (status = 'reported') = (reviewed_by is null and reviewed_at is null)
    and (reviewed_by is null) = (reviewed_at is null)
    and (status <> 'disputed' or review_reason is not null)
    and (status <> 'repaired' or reviewed_by is not null)),
  constraint vdi_repair_fields check ((status = 'repaired') = (repaired_by is not null)
                                      and (repaired_by is null) = (repaired_at is null)
                                      and (repaired_by is null) = (repair_note is null)),
  constraint vdi_dec24_review check (reviewed_by is null or reviewed_by <> reported_by),
  constraint vdi_dec24_repair check (repaired_by is null or repaired_by <> reported_by)
);
create index vdi_branch_company_idx    on public.vehicle_damage_items (branch_id, company_id);
create index vdi_vehicle_company_idx   on public.vehicle_damage_items (vehicle_id, company_id);
create index vdi_inspection_fk_idx     on public.vehicle_damage_items (reported_in_inspection_id, vehicle_id, reported_stage);
create index vdi_reported_by_idx       on public.vehicle_damage_items (reported_by, company_id);
create index vdi_reviewed_by_idx       on public.vehicle_damage_items (reviewed_by, company_id);
create index vdi_repaired_by_idx       on public.vehicle_damage_items (repaired_by, company_id);
create index vdi_prev_allocation_idx   on public.vehicle_damage_items (interval_previous_allocation_id, company_id);
create index vdi_prev_inspection_idx   on public.vehicle_damage_items (interval_previous_inspection_id, company_id);
create index vdi_vehicle_status_idx    on public.vehicle_damage_items (vehicle_id, status);
comment on column public.vehicle_damage_items.interval_previous_allocation_id is 'DEC-42: for damage first reported in a PRE-shift inspection — the vehicle''s previous allocation (by allocation chronology, not by highest value or device time). Lets the interval be investigated; assigns no fault or liability to anyone.';
comment on column public.vehicle_damage_items.incident_id is 'Reserved for Phase 9 (incidents). No foreign key yet.';
comment on table public.vehicle_damage_items is 'DEC-42 known-damage register. reported -> verified | disputed; verified -> repaired; disputed and repaired are final (a wrongly closed item is corrected by reporting a new one). Nobody reviews an item they reported (DEC-24, also CHECKs). Onboarding items count as known at once but still need a different reviewer.';

-- ---------------------------------------------------------------- vehicle_damage_evidence
create table public.vehicle_damage_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  damage_item_id uuid not null,
  evidence_file_id uuid not null references public.evidence_files (id),
  added_by uuid not null,
  added_at timestamptz not null default now(),
  foreign key (damage_item_id, company_id) references public.vehicle_damage_items (id, company_id),
  foreign key (added_by, company_id) references public.profiles (id, company_id),
  constraint vde_file_uq unique (evidence_file_id)
);
create index vde_company_item_idx   on public.vehicle_damage_evidence (company_id, damage_item_id);
create index vde_item_company_idx   on public.vehicle_damage_evidence (damage_item_id, company_id);
create index vde_added_by_idx       on public.vehicle_damage_evidence (added_by, company_id);

-- ---------------------------------------------------------------- idempotency ledger for review / repair (DEC-06)
create table public.damage_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  actor_id uuid not null,
  client_submission_id uuid not null,
  function_name text not null check (function_name in ('review', 'repair')),
  request_hash text not null,
  damage_item_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (actor_id, company_id) references public.profiles (id, company_id),
  foreign key (damage_item_id, company_id) references public.vehicle_damage_items (id, company_id),
  constraint damage_requests_idempotent unique (company_id, actor_id, client_submission_id)
);
create index damage_requests_actor_idx on public.damage_requests (actor_id, company_id);
create index damage_requests_item_idx  on public.damage_requests (damage_item_id, company_id);
create trigger damage_requests_no_change before update or delete on public.damage_requests for each row execute function public.append_only();
create trigger damage_requests_no_truncate before truncate on public.damage_requests for each statement execute function public.append_only();

-- inspection_requests (the inspection ledger) learns the two new inspection-level writes of 047 / 048
alter table public.inspection_requests drop constraint inspection_requests_function_name_check;
alter table public.inspection_requests add constraint inspection_requests_function_name_check
  check (function_name in ('begin', 'save_responses', 'attach_odometer', 'attach_photo', 'submit', 'void',
                           'report_damage', 'confirm_known_damage', 'begin_on_behalf'));

-- ---------------------------------------------------------------- the evidence rule, ONE place (DEC-04, ARCH §6.7)
-- A registered evidence_files row, in-app camera, of one of the purposes, uploaded by p_actor, in p_company and p_branch,
-- not already used by an odometer photo, an inspection photo or damage evidence. The one allowed double use: inside report_damage(),
-- a damage photo of THIS inspection is both the report's evidence and an inspection_photos row (p_allow_inspection + the file named in
-- the transaction-local setting app.damage_report_file).
create function public.evidence_check_attachable(
  p_company uuid, p_branch uuid, p_actor uuid, p_evidence_file_id uuid, p_purposes text[], p_allow_inspection uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  f public.evidence_files;
  v_dbl boolean;
begin
  select * into f from public.evidence_files where id = p_evidence_file_id and company_id = p_company;
  if not found then
    perform public.inspection_fail('IN013', 'that photo was not found, or it has not finished uploading');
  end if;
  if f.capture_source <> 'in_app_camera' then
    perform public.inspection_fail('IN010', 'Photos for an inspection must be taken with the in-app camera; gallery, file and imported images are not accepted.');
  end if;
  if f.purpose <> all (p_purposes) then
    perform public.inspection_fail('IN011', format('that photo was uploaded for a different purpose (%s); it cannot be used here', f.purpose));
  end if;
  if f.uploaded_by <> p_actor then
    perform public.inspection_fail('IN012', 'that photo was taken by someone else; only the person completing the inspection can attach their own photos');
  end if;
  if f.branch_id is distinct from p_branch then
    perform public.inspection_fail('IN013', 'that photo belongs to a different branch');
  end if;
  -- the one allowed double use: inside report_damage() (it names the file in a transaction-local setting) a damage photo of THIS
  -- inspection is both the report's evidence and an inspection_photos row; nowhere else
  v_dbl := p_allow_inspection is not null and coalesce(current_setting('app.damage_report_file', true), '') = f.id::text;
  if exists (select 1 from public.odometer_evidence o where o.evidence_file_id = f.id)
     or exists (select 1 from public.inspection_photos p
                 where p.evidence_file_id = f.id
                   and not (v_dbl and p.inspection_id = p_allow_inspection and p.photo_category = 'damage' and p.template_item_id is null))
     or exists (select 1 from public.vehicle_damage_evidence e join public.vehicle_damage_items d on d.id = e.damage_item_id
                 where e.evidence_file_id = f.id
                   and not (v_dbl and d.reported_in_inspection_id = p_allow_inspection)) then
    perform public.inspection_fail('IN014', 'that photo is already attached to an inspection');
  end if;
end $$;
revoke all on function public.evidence_check_attachable(uuid, uuid, uuid, uuid, text[], uuid) from public, anon, authenticated;

create or replace function public.inspection_check_evidence(p_inspection_id uuid, p_evidence_file_id uuid, p_purposes text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.inspections;
begin
  select * into i from public.inspections where id = p_inspection_id;
  if not found then
    perform public.inspection_fail('P0002', 'that inspection was not found');
  end if;
  perform public.evidence_check_attachable(i.company_id, i.branch_id, i.submitted_by, p_evidence_file_id, p_purposes, i.id);
end $$;

-- ---------------------------------------------------------------- live-allocation helper for the driver's read access (DEC-42)
create function public.damage_driver_has_live_allocation(p_vehicle_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true from public.vehicle_allocations a
     where a.vehicle_id = p_vehicle_id and a.company_id = public.current_company_id()
       and a.status in ('pre_inspection_pending', 'in_use', 'post_inspection_pending')
       and public.driver_is_self(a.driver_id)
     limit 1), false)
$$;
revoke all on function public.damage_driver_has_live_allocation(uuid) from public, anon;
grant execute on function public.damage_driver_has_live_allocation(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- triggers: items
create function public.vdi_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.inspections;
  v public.vehicles;
begin
  if new.status <> 'reported' then
    raise exception 'a damage item is created as reported' using errcode = '23514';
  end if;
  select * into v from public.vehicles where id = new.vehicle_id and company_id = new.company_id;
  if not found or v.current_branch_id is distinct from new.branch_id then
    raise exception 'a damage item belongs to its vehicle''s branch' using errcode = '23514';
  end if;
  new.description := btrim(new.description);
  if new.source = 'inspection' then
    select * into i from public.inspections where id = new.reported_in_inspection_id and company_id = new.company_id;
    if not found then
      perform public.inspection_fail('P0002', 'that inspection was not found');
    end if;
    if i.status <> 'draft' then
      perform public.inspection_fail('DM007', format('this inspection is %s: damage can no longer be reported in it', i.status));
    end if;
    if i.vehicle_id <> new.vehicle_id or i.branch_id <> new.branch_id or i.submitted_by <> new.reported_by then
      raise exception 'damage is reported by the person completing the inspection, on its vehicle' using errcode = '23514';
    end if;
  end if;
  if new.interval_previous_allocation_id is not null and not exists (
       select 1 from public.vehicle_allocations a where a.id = new.interval_previous_allocation_id and a.vehicle_id = new.vehicle_id and a.company_id = new.company_id) then
    raise exception 'the interval allocation must be of the same vehicle' using errcode = '23514';
  end if;
  if new.interval_previous_inspection_id is not null and not exists (
       select 1 from public.inspections x where x.id = new.interval_previous_inspection_id and x.vehicle_id = new.vehicle_id
          and x.allocation_id = new.interval_previous_allocation_id and x.inspection_stage = 'post_shift' and x.status = 'submitted') then
    raise exception 'the interval inspection must be the submitted post-shift inspection of the interval allocation' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger vdi_validate_t before insert on public.vehicle_damage_items for each row execute function public.vdi_validate();

-- Only the functions of 047 change an item, and only along reported -> verified | disputed and verified -> repaired; everything else is fixed.
create function public.vdi_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c text;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  v_mode text := coalesce(current_setting('app.damage_write', true), '');
begin
  foreach c in array array['id', 'company_id', 'branch_id', 'vehicle_id', 'zone', 'severity', 'description', 'source', 'reported_in_inspection_id',
                           'reported_stage', 'reported_by', 'reported_at', 'device_reported_at', 'captured_offline',
                           'interval_previous_allocation_id', 'interval_previous_inspection_id', 'incident_id',
                           'client_submission_id', 'created_at'] loop
    if o -> c is distinct from n -> c then
      raise exception 'column vehicle_damage_items.% is immutable', c using errcode = '23514';
    end if;
  end loop;
  if new.status is not distinct from old.status then
    raise exception 'a damage item changes only by being reviewed or marked repaired' using errcode = '55000';
  end if;
  if old.status = 'reported' and new.status in ('verified', 'disputed') then
    if v_mode <> 'review' then
      raise exception 'a damage item is reviewed only through review_damage()' using errcode = '55000';
    end if;
    if new.reviewed_at is distinct from now() or new.repaired_by is not null then
      raise exception 'reviewed_at is the server time' using errcode = '23514';
    end if;
  elsif old.status = 'verified' and new.status = 'repaired' then
    if v_mode <> 'repair' then
      raise exception 'a damage item is marked repaired only through mark_damage_repaired()' using errcode = '55000';
    end if;
    if new.repaired_at is distinct from now()
       or (to_jsonb(new) - array['status', 'repaired_by', 'repaired_at', 'repair_note', 'updated_at'])
          is distinct from (to_jsonb(old) - array['status', 'repaired_by', 'repaired_at', 'repair_note', 'updated_at']) then
      raise exception 'repairing an item sets only the repair fields' using errcode = '23514';
    end if;
  else
    raise exception 'a damage item cannot move from % to %', old.status, new.status using errcode = '55000';
  end if;
  return new;
end $$;
create trigger vdi_updated_at before update on public.vehicle_damage_items for each row execute function public.set_updated_at();
create trigger vdi_guard_t before update on public.vehicle_damage_items for each row execute function public.vdi_guard();
create trigger vdi_no_delete   before delete   on public.vehicle_damage_items for each row       execute function public.forbid_delete();
create trigger vdi_no_truncate before truncate on public.vehicle_damage_items for each statement execute function public.forbid_delete();
create trigger vdi_audit after insert or update or delete on public.vehicle_damage_items for each row execute function public.audit_row_change();

-- every report carries at least one photo, checked at commit (the function adds the evidence in the same transaction)
create function public.vdi_requires_photo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.vehicle_damage_evidence e where e.damage_item_id = new.id) then
    perform public.inspection_fail('DM006', 'A damage report needs at least one photo taken with the in-app camera.');
  end if;
  return null;
end $$;
create constraint trigger vdi_requires_photo_t after insert on public.vehicle_damage_items
  deferrable initially deferred for each row execute function public.vdi_requires_photo();

-- ---------------------------------------------------------------- triggers: evidence (append-only; added only in the transaction that created the item)
create function public.vde_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d public.vehicle_damage_items;
begin
  select * into d from public.vehicle_damage_items where id = new.damage_item_id and company_id = new.company_id;
  if not found then
    perform public.inspection_fail('P0002', 'that damage item was not found');
  end if;
  if d.created_at <> now() or d.status <> 'reported' then
    raise exception 'photos are added when the damage is reported; a later change is a new report' using errcode = '55000';
  end if;
  if new.added_by <> d.reported_by then
    raise exception 'the photos are added by the person reporting the damage' using errcode = '23514';
  end if;
  perform public.evidence_check_attachable(d.company_id, d.branch_id, new.added_by, new.evidence_file_id, array['damage'], d.reported_in_inspection_id);
  return new;
end $$;
create trigger vde_validate_t before insert on public.vehicle_damage_evidence for each row execute function public.vde_validate();
create trigger vde_no_change before update or delete on public.vehicle_damage_evidence for each row execute function public.append_only();
create trigger vde_no_truncate before truncate on public.vehicle_damage_evidence for each statement execute function public.append_only();
create trigger vde_audit after insert on public.vehicle_damage_evidence for each row execute function public.audit_row_change();

revoke execute on function public.vdi_validate(), public.vdi_guard(), public.vdi_requires_photo(), public.vde_validate() from public, anon, authenticated;

-- inspection_photos: the same file may also be this report's damage evidence (see evidence_check_attachable) — nothing else changes there.

-- ---------------------------------------------------------------- RLS + grants (deny by default; reads only)
alter table public.vehicle_damage_items    enable row level security;
alter table public.vehicle_damage_evidence enable row level security;
alter table public.damage_requests         enable row level security;
revoke all on public.vehicle_damage_items, public.vehicle_damage_evidence, public.damage_requests from public, anon, authenticated;
grant select on public.vehicle_damage_items, public.vehicle_damage_evidence to authenticated;
-- damage_requests: no policy and no grant (internal bookkeeping)

create policy vdi_select on public.vehicle_damage_items for select to authenticated
  using (company_id = (select public.current_company_id())
         and (public.has_permission('allocation.manage', branch_id)
              or public.has_permission('reports.view', branch_id)
              or public.damage_driver_has_live_allocation(vehicle_id)));
create policy vde_select on public.vehicle_damage_evidence for select to authenticated
  using (company_id = (select public.current_company_id())
         and exists (select 1 from public.vehicle_damage_items d where d.id = vehicle_damage_evidence.damage_item_id and d.company_id = vehicle_damage_evidence.company_id));
comment on policy vdi_select on public.vehicle_damage_items is
  'DEC-42: allocation.manage or reports.view for the vehicle''s branch (supervisor, branch manager, fleet administrator, maintenance administrator, senior management read; DEC-23), and a driver for a vehicle while they hold a live allocation for it (pre_inspection_pending, in_use, post_inspection_pending). System administrators see nothing. The PHOTOS stay behind can_view_evidence and signed URLs: a driver sees the list, not other people''s photos (default to confirm).';


-- ---------------------------------------------------------------- request_evidence_upload_slot: damage photos for onboarding (see header)
create or replace function public.request_evidence_upload_slot(
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
  if not (public.has_permission(v_perm, p_branch_id)
          or (p_purpose = 'damage' and public.has_permission('allocation.manage', p_branch_id))) then
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

