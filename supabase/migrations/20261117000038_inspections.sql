-- 038 — Slice 4A (2/3): inspections, answers, the odometer photo and condition photos, the idempotency ledger
-- (PRD v1.15 §5.5–§5.8.3, §6; ARCH v1.14 §6.1–§6.4, §6.7, §6.9; DB v1.10 §2.1, §5, §6, §7, §8 odometer_evidence, §20, §21;
--  DEC-04 in-app camera only, DEC-06 offline-ready writes, DEC-24, DEC-27).
-- Added:  inspections, inspection_requests (idempotency ledger), inspection_responses, odometer_evidence, inspection_photos;
--         their validation / guard / audit triggers; RLS (read: the allocation's driver, allocation.manage, reports.view);
--         inspection_fail(), inspection_response_valid(), inspection_check_evidence() (internal).
-- Write model: NO client INSERT/UPDATE/DELETE grants. Rows are written only by the SECURITY DEFINER functions in 039.
-- Nothing is ever deleted (void instead). Submitted inspections are immutable except voiding.
-- OCR, driver and accepted odometer readings are three separate values (CLAUDE.md): this slice stores NONE of them — only the
-- photo (odometer_evidence). processing_status stays 'not_required' until Phase 6.
--
-- Stable refusals (SQLSTATE; HINT = 'user_message': shown as is):
--   42501 not allowed      P0002 not found       55000 wrong state       22023 invalid input        23514 rule broken
--   IN001 vehicle not confirmed      IN002 a required item is not answered   IN003 a defect has no comment
--   IN004 a defect has no photo      IN005 a "yes" has no detail             IN006 no odometer photo
--   IN010 photo not from the in-app camera (DEC-04)   IN011 wrong photo purpose   IN012 photo taken by someone else
--   IN013 photo not found / other branch              IN014 photo already used

-- ---------------------------------------------------------------- one way to refuse with a user-facing message
create function public.inspection_fail(p_sqlstate text, p_message text, p_detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%', p_message using errcode = p_sqlstate, hint = 'user_message', detail = coalesce(p_detail, '');
end $$;
revoke all on function public.inspection_fail(text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- answer values per response type (ONE place)
-- ok_defect: ok | defect | na (na only where the item allows it); fuel_quarter: E | 1/4 | 1/2 | 3/4 | F; yes_no_detail: yes | no.
create function public.inspection_response_valid(p_response_type text, p_value text, p_allow_na boolean) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(case p_response_type
    when 'ok_defect'     then p_value in ('ok', 'defect') or (p_value = 'na' and coalesce(p_allow_na, false))
    when 'fuel_quarter'  then p_value in ('E', '1/4', '1/2', '3/4', 'F')
    when 'yes_no_detail' then p_value in ('yes', 'no')
    else false
  end, false)
$$;
revoke all on function public.inspection_response_valid(text, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------- inspections (DB §6)
create table public.inspections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  vehicle_id uuid not null,
  driver_id uuid not null,
  shift_id uuid not null,
  allocation_id uuid not null,
  template_id uuid not null,
  inspection_stage text not null check (inspection_stage in ('pre_shift', 'post_shift')),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'void')),
  vehicle_confirmed boolean not null default false,
  started_at timestamptz not null default now(),                 -- server time
  device_started_at timestamptz,                                 -- untrusted (DEC-06)
  device_submitted_at timestamptz,                               -- untrusted (DEC-06)
  submitted_at timestamptz,                                      -- server time
  captured_offline boolean not null default false,               -- DEC-06: stays visible
  late_flag boolean not null default false,                      -- DEC-17
  safety_defect_flag boolean not null default false,
  submitted_by uuid not null,                                    -- the person completing it; fixed when the draft is begun
  completed_by_role text not null default 'driver' check (completed_by_role in ('driver', 'supervisor_on_behalf')),
  on_behalf_reason text check (length(on_behalf_reason) between 1 and 500),   -- 4C (DEC-09) writes it; 4A never does
  voided_at timestamptz,
  void_reason text check (length(void_reason) between 1 and 500),
  voided_by uuid,
  client_submission_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (allocation_id, vehicle_id, driver_id, shift_id, branch_id)
    references public.vehicle_allocations (id, vehicle_id, driver_id, shift_id, branch_id),
  foreign key (template_id, company_id) references public.inspection_templates (id, company_id),
  foreign key (submitted_by, company_id) references public.profiles (id, company_id),
  foreign key (voided_by, company_id) references public.profiles (id, company_id),
  unique (id, company_id),
  unique (id, allocation_id, inspection_stage),                  -- target for odometer_evidence
  constraint inspections_idempotent unique (company_id, submitted_by, client_submission_id),
  constraint inspections_submitted_fields check (status <> 'submitted' or (submitted_at is not null and submitted_by is not null)),
  constraint inspections_draft_unsubmitted check (status <> 'draft' or (submitted_at is null and not late_flag and not safety_defect_flag)),
  constraint inspections_void_fields check ((status = 'void') = (voided_at is not null)
                                            and (status <> 'void' or (void_reason is not null and voided_by is not null))),
  constraint inspections_on_behalf check ((completed_by_role = 'supervisor_on_behalf') = (on_behalf_reason is not null))
);
-- one live (non-void) inspection per allocation and stage (PRD §5.5)
create unique index inspections_one_live_per_stage_uq on public.inspections (allocation_id, inspection_stage) where status <> 'void';
-- FK covers, in FK column order (company_id is covered by the leading column of inspections_idempotent)
create index inspections_branch_company_idx    on public.inspections (branch_id, company_id);
create index inspections_allocation_fk_idx     on public.inspections (allocation_id, vehicle_id, driver_id, shift_id, branch_id);
create index inspections_template_company_idx  on public.inspections (template_id, company_id);
create index inspections_submitted_by_company_idx on public.inspections (submitted_by, company_id);
create index inspections_voided_by_company_idx on public.inspections (voided_by, company_id);
create index inspections_branch_started_idx    on public.inspections (branch_id, started_at desc);
comment on column public.inspections.submitted_by is 'The person completing the inspection (the driver; from 4C a supervisor on the driver''s behalf). Set when the draft is begun and fixed; idempotency is per (company, submitted_by, client_submission_id).';
comment on column public.inspections.late_flag is 'DEC-17: submitted after the shift start + pre_shift_late_minutes (pre-shift) or the planned end + post_shift_late_minutes (post-shift). Set even when captured_offline. Never blocks submission.';
comment on column public.inspections.device_submitted_at is 'Untrusted device clock (DEC-06). submitted_at is the server time and is what the late rule uses.';

-- ---------------------------------------------------------------- idempotency ledger (every write function, DEC-06)
-- One row per processed client_submission_id (per company and actor). A retry with the same id and the same request returns the
-- recorded outcome; the same id with a different request is refused. Append-only; not readable by clients.
create table public.inspection_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  actor_id uuid not null,
  client_submission_id uuid not null,
  function_name text not null check (function_name in ('begin', 'save_responses', 'attach_odometer', 'attach_photo', 'submit', 'void')),
  request_hash text not null,
  inspection_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (actor_id, company_id) references public.profiles (id, company_id),
  foreign key (inspection_id, company_id) references public.inspections (id, company_id),
  constraint inspection_requests_idempotent unique (company_id, actor_id, client_submission_id)
);
create index inspection_requests_actor_company_idx      on public.inspection_requests (actor_id, company_id);
create index inspection_requests_inspection_company_idx on public.inspection_requests (inspection_id, company_id);
create trigger inspection_requests_no_change before update or delete on public.inspection_requests for each row execute function public.append_only();
create trigger inspection_requests_no_truncate before truncate on public.inspection_requests for each statement execute function public.append_only();

-- ---------------------------------------------------------------- inspection_responses (DB §6)
create table public.inspection_responses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  inspection_id uuid not null,
  template_item_id uuid not null,
  response_value text not null check (response_value in ('ok', 'defect', 'na', 'E', '1/4', '1/2', '3/4', 'F', 'yes', 'no')),
  comment text check (length(comment) between 1 and 1000),
  device_answered_at timestamptz,                                -- untrusted (DEC-06)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (inspection_id, company_id) references public.inspections (id, company_id),
  foreign key (template_item_id, company_id) references public.inspection_template_items (id, company_id),
  unique (inspection_id, template_item_id)
);
create index inspection_responses_inspection_company_idx    on public.inspection_responses (inspection_id, company_id);
create index inspection_responses_template_item_company_idx on public.inspection_responses (template_item_id, company_id);
create index inspection_responses_company_idx               on public.inspection_responses (company_id);

-- ---------------------------------------------------------------- odometer_evidence (DB §8)
create table public.odometer_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  vehicle_id uuid not null,
  driver_id uuid not null,
  shift_id uuid not null,
  allocation_id uuid not null,
  inspection_id uuid not null,
  inspection_stage text not null check (inspection_stage in ('pre_shift', 'post_shift')),
  evidence_file_id uuid not null references public.evidence_files (id),
  is_current boolean not null default true,
  retake_of_id uuid,
  processing_status text not null default 'not_required' check (processing_status in ('pending_ocr', 'ocr_complete', 'ocr_failed', 'not_required')),
  created_at timestamptz not null default now(),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (allocation_id, vehicle_id, driver_id, shift_id, branch_id)
    references public.vehicle_allocations (id, vehicle_id, driver_id, shift_id, branch_id),
  foreign key (inspection_id, allocation_id, inspection_stage) references public.inspections (id, allocation_id, inspection_stage),
  foreign key (retake_of_id, company_id) references public.odometer_evidence (id, company_id),
  unique (id, company_id),
  constraint odometer_evidence_file_uq unique (evidence_file_id),
  constraint odometer_evidence_retake_not_self check (retake_of_id is distinct from id)
);
create unique index odometer_evidence_one_current_uq on public.odometer_evidence (inspection_id) where is_current;
create index odometer_evidence_company_inspection_idx on public.odometer_evidence (company_id, inspection_id);
create index odometer_evidence_branch_company_idx     on public.odometer_evidence (branch_id, company_id);
create index odometer_evidence_allocation_fk_idx      on public.odometer_evidence (allocation_id, vehicle_id, driver_id, shift_id, branch_id);
create index odometer_evidence_inspection_fk_idx      on public.odometer_evidence (inspection_id, allocation_id, inspection_stage);
create index odometer_evidence_retake_company_idx     on public.odometer_evidence (retake_of_id, company_id);

-- ---------------------------------------------------------------- inspection_photos (DB §6)
create table public.inspection_photos (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  inspection_id uuid not null,
  vehicle_id uuid not null,
  evidence_file_id uuid not null references public.evidence_files (id),
  photo_category text not null check (photo_category in ('condition', 'damage', 'other')),
  template_item_id uuid,
  created_at timestamptz not null default now(),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (inspection_id, company_id) references public.inspections (id, company_id),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  foreign key (template_item_id, company_id) references public.inspection_template_items (id, company_id),
  constraint inspection_photos_file_uq unique (evidence_file_id)
);
create index inspection_photos_company_inspection_idx  on public.inspection_photos (company_id, inspection_id);
create index inspection_photos_branch_company_idx      on public.inspection_photos (branch_id, company_id);
create index inspection_photos_inspection_company_idx  on public.inspection_photos (inspection_id, company_id);
create index inspection_photos_vehicle_company_idx     on public.inspection_photos (vehicle_id, company_id);
create index inspection_photos_item_company_idx        on public.inspection_photos (template_item_id, company_id);

-- ---------------------------------------------------------------- evidence rules, ONE place (DEC-04, ARCH §6.7)
-- The file is a registered evidence_files row (rows exist only after register_evidence_file), taken with the in-app camera,
-- of the right purpose, uploaded by the person completing the inspection, in the inspection's company and branch, and not
-- already attached anywhere. Called by the insert triggers below, so no path can skip it.
create function public.inspection_check_evidence(p_inspection_id uuid, p_evidence_file_id uuid, p_purposes text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.inspections;
  f public.evidence_files;
begin
  select * into i from public.inspections where id = p_inspection_id;
  if not found then
    perform public.inspection_fail('P0002', 'that inspection was not found');
  end if;
  select * into f from public.evidence_files where id = p_evidence_file_id and company_id = i.company_id;
  if not found then
    perform public.inspection_fail('IN013', 'that photo was not found, or it has not finished uploading');
  end if;
  if f.capture_source <> 'in_app_camera' then
    perform public.inspection_fail('IN010', 'Photos for an inspection must be taken with the in-app camera; gallery, file and imported images are not accepted.');
  end if;
  if f.purpose <> all (p_purposes) then
    perform public.inspection_fail('IN011', format('that photo was uploaded for a different purpose (%s); it cannot be used here', f.purpose));
  end if;
  if f.uploaded_by <> i.submitted_by then
    perform public.inspection_fail('IN012', 'that photo was taken by someone else; only the person completing the inspection can attach their own photos');
  end if;
  if f.branch_id is distinct from i.branch_id then
    perform public.inspection_fail('IN013', 'that photo belongs to a different branch');
  end if;
  if exists (select 1 from public.odometer_evidence o where o.evidence_file_id = f.id)
     or exists (select 1 from public.inspection_photos p where p.evidence_file_id = f.id) then
    perform public.inspection_fail('IN014', 'that photo is already attached to an inspection');
  end if;
end $$;
revoke all on function public.inspection_check_evidence(uuid, uuid, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------- triggers: inspections
create function public.inspections_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'draft' then
    raise exception 'an inspection is created as a draft' using errcode = '23514';
  end if;
  if new.completed_by_role = 'driver' and not exists (
       select 1 from public.drivers d where d.id = new.driver_id and d.company_id = new.company_id and d.profile_id = new.submitted_by) then
    raise exception 'a driver inspection is completed by the allocation''s own driver' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger inspections_validate_t before insert on public.inspections for each row execute function public.inspections_validate();

-- Submitted rows are immutable except voiding; void is final; a draft changes only its working columns, or becomes
-- submitted (submitted_at must be the server's now()) or void.
create function public.inspections_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c text;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  v_void text[] := array['status', 'voided_at', 'void_reason', 'voided_by', 'updated_at'];
begin
  foreach c in array array['id', 'company_id', 'branch_id', 'vehicle_id', 'driver_id', 'shift_id', 'allocation_id', 'template_id',
                           'inspection_stage', 'started_at', 'submitted_by', 'completed_by_role', 'on_behalf_reason',
                           'client_submission_id', 'created_at'] loop
    if o -> c is distinct from n -> c then
      raise exception 'column inspections.% is immutable', c using errcode = '23514';
    end if;
  end loop;
  if old.status = 'void' then
    raise exception 'a voided inspection cannot change' using errcode = '55000';
  elsif old.status = 'submitted' then
    if new.status <> 'void' or (o - v_void) is distinct from (n - v_void) then
      raise exception 'a submitted inspection cannot change; it can only be voided' using errcode = '55000';
    end if;
  else  -- draft
    if new.status = 'submitted' then
      if new.submitted_at is distinct from now() then
        raise exception 'submitted_at is the server time' using errcode = '23514';
      end if;
    elsif new.status = 'void' then
      if new.voided_at is distinct from now() then
        raise exception 'voided_at is the server time' using errcode = '23514';
      end if;
    elsif new.submitted_at is not null or new.late_flag or new.safety_defect_flag then
      raise exception 'the submission fields are set by submit_inspection()' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger inspections_updated_at before update on public.inspections for each row execute function public.set_updated_at();
create trigger inspections_guard_t before update on public.inspections for each row execute function public.inspections_guard();
create trigger inspections_no_delete   before delete   on public.inspections for each row       execute function public.forbid_delete();
create trigger inspections_no_truncate before truncate on public.inspections for each statement execute function public.forbid_delete();
create trigger inspections_audit after insert or update or delete on public.inspections for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- triggers: inspection_responses
create function public.inspection_responses_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.inspections;
  it public.inspection_template_items;
begin
  if tg_op = 'UPDATE' and (new.inspection_id is distinct from old.inspection_id or new.template_item_id is distinct from old.template_item_id
                           or new.company_id is distinct from old.company_id) then
    raise exception 'an answer cannot move to another inspection or question' using errcode = '23514';
  end if;
  select * into i from public.inspections where id = new.inspection_id and company_id = new.company_id;
  if not found then
    perform public.inspection_fail('P0002', 'that inspection was not found');
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is %s: its answers can no longer be changed', i.status));
  end if;
  select * into it from public.inspection_template_items where id = new.template_item_id and company_id = new.company_id;
  if not found or it.template_id <> i.template_id then
    perform public.inspection_fail('22023', 'that question does not belong to this inspection''s checklist');
  end if;
  if it.applies_to_stage not in (i.inspection_stage, 'both') then
    perform public.inspection_fail('22023', format('that question is not part of the %s inspection', replace(i.inspection_stage, '_', '-')));
  end if;
  if not public.inspection_response_valid(it.response_type, new.response_value, coalesce((it.configuration ->> 'allow_na')::boolean, false)) then
    if new.response_value = 'na' then
      perform public.inspection_fail('22023', format('"N/A" is not an accepted answer for: %s', it.question));
    end if;
    perform public.inspection_fail('22023', format('that answer is not valid for: %s', it.question));
  end if;
  new.comment := nullif(btrim(new.comment), '');
  return new;
end $$;
create trigger inspection_responses_updated_at before update on public.inspection_responses for each row execute function public.set_updated_at();
create trigger inspection_responses_validate_t before insert or update on public.inspection_responses for each row execute function public.inspection_responses_validate();
create trigger inspection_responses_no_delete   before delete   on public.inspection_responses for each row       execute function public.forbid_delete();
create trigger inspection_responses_no_truncate before truncate on public.inspection_responses for each statement execute function public.forbid_delete();
create trigger inspection_responses_audit after insert or update or delete on public.inspection_responses for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- triggers: odometer_evidence
create function public.odometer_evidence_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.inspections;
begin
  select * into i from public.inspections where id = new.inspection_id and company_id = new.company_id;
  if not found then
    perform public.inspection_fail('P0002', 'that inspection was not found');
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is %s: its photos can no longer be changed', i.status));
  end if;
  perform public.inspection_check_evidence(new.inspection_id, new.evidence_file_id, array['odometer']);
  if new.retake_of_id is not null and not exists (
       select 1 from public.odometer_evidence p where p.id = new.retake_of_id and p.inspection_id = new.inspection_id and not p.is_current) then
    raise exception 'a retake replaces an earlier photo of the same inspection' using errcode = '23514';
  end if;
  if new.processing_status <> 'not_required' then
    raise exception 'OCR processing belongs to Phase 6' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger odometer_evidence_validate_t before insert on public.odometer_evidence for each row execute function public.odometer_evidence_validate();

-- the only change an odometer photo ever gets: current -> not current (a retake replaced it); the file is kept
create function public.odometer_evidence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare i public.inspections;
begin
  if (to_jsonb(new) - 'is_current') is distinct from (to_jsonb(old) - 'is_current') or not (old.is_current and not new.is_current) then
    raise exception 'an odometer photo can only be replaced by a retake (it is kept, no longer current)' using errcode = '23514';
  end if;
  select * into i from public.inspections where id = old.inspection_id;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is %s: its photos can no longer be changed', i.status));
  end if;
  return new;
end $$;
create trigger odometer_evidence_guard_t before update on public.odometer_evidence for each row execute function public.odometer_evidence_guard();
create trigger odometer_evidence_no_delete   before delete   on public.odometer_evidence for each row       execute function public.forbid_delete();
create trigger odometer_evidence_no_truncate before truncate on public.odometer_evidence for each statement execute function public.forbid_delete();
create trigger odometer_evidence_audit after insert or update or delete on public.odometer_evidence for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- triggers: inspection_photos
create function public.inspection_photos_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.inspections;
  it public.inspection_template_items;
begin
  select * into i from public.inspections where id = new.inspection_id and company_id = new.company_id;
  if not found then
    perform public.inspection_fail('P0002', 'that inspection was not found');
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is %s: its photos can no longer be changed', i.status));
  end if;
  if new.vehicle_id <> i.vehicle_id or new.branch_id <> i.branch_id then
    raise exception 'a photo belongs to the inspection''s vehicle and branch' using errcode = '23514';
  end if;
  perform public.inspection_check_evidence(new.inspection_id, new.evidence_file_id, array['inspection', 'damage']);
  if new.template_item_id is not null then
    select * into it from public.inspection_template_items where id = new.template_item_id and company_id = new.company_id;
    if not found or it.template_id <> i.template_id or it.applies_to_stage not in (i.inspection_stage, 'both') then
      perform public.inspection_fail('22023', 'that question is not part of this inspection');
    end if;
  end if;
  return new;
end $$;
create trigger inspection_photos_validate_t before insert on public.inspection_photos for each row execute function public.inspection_photos_validate();
create trigger inspection_photos_no_change before update or delete on public.inspection_photos for each row execute function public.append_only();
create trigger inspection_photos_no_truncate before truncate on public.inspection_photos for each statement execute function public.append_only();
create trigger inspection_photos_audit after insert on public.inspection_photos for each row execute function public.audit_row_change();

revoke execute on function
  public.inspections_validate(), public.inspections_guard(), public.inspection_responses_validate(),
  public.odometer_evidence_validate(), public.odometer_evidence_guard(), public.inspection_photos_validate()
  from public, anon, authenticated;

-- ---------------------------------------------------------------- RLS + grants (deny by default; reads only)
alter table public.inspections          enable row level security;
alter table public.inspection_requests  enable row level security;
alter table public.inspection_responses enable row level security;
alter table public.odometer_evidence    enable row level security;
alter table public.inspection_photos    enable row level security;
revoke all on public.inspections, public.inspection_requests, public.inspection_responses, public.odometer_evidence, public.inspection_photos
  from public, anon, authenticated;
grant select on public.inspections, public.inspection_responses, public.odometer_evidence, public.inspection_photos to authenticated;
-- inspection_requests: no policy and no grant: internal bookkeeping for the idempotent functions

-- the allocation's own driver, and holders of allocation.manage or reports.view for the inspection's branch (company-wide grants
-- cover every branch). Everyone else — other drivers, other branches, other companies, system administrators — sees nothing.
create policy inspections_select on public.inspections for select to authenticated
  using (company_id = (select public.current_company_id())
         and (public.has_permission('allocation.manage', branch_id)
              or public.has_permission('reports.view', branch_id)
              or public.driver_is_self(driver_id)));
-- a child row is visible exactly when its inspection is (the subquery runs under the caller's own RLS)
create policy inspection_responses_select on public.inspection_responses for select to authenticated
  using (company_id = (select public.current_company_id())
         and exists (select 1 from public.inspections i where i.id = inspection_responses.inspection_id and i.company_id = inspection_responses.company_id));
create policy odometer_evidence_select on public.odometer_evidence for select to authenticated
  using (company_id = (select public.current_company_id())
         and exists (select 1 from public.inspections i where i.id = odometer_evidence.inspection_id and i.company_id = odometer_evidence.company_id));
create policy inspection_photos_select on public.inspection_photos for select to authenticated
  using (company_id = (select public.current_company_id())
         and exists (select 1 from public.inspections i where i.id = inspection_photos.inspection_id and i.company_id = inspection_photos.company_id));
comment on policy inspections_select on public.inspections is
  'Own (the allocation''s driver), or allocation.manage / reports.view for the branch. Maintenance administrators and senior management read through reports.view and cannot write; system administrators have neither permission and see nothing (DEC-23). The photos themselves stay behind can_view_evidence and signed URLs.';
