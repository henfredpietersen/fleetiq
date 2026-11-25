-- 052 — Slice 5A (2/4): odometer readings, their events, exceptions and the review ledger
-- (PRD v1.20 §5.8, §5.9; ARCH v1.19 §6.5, §6.6, §7.1; DB v1.15 §8 odometer_readings, odometer_reading_events, odometer_exceptions, §17, §20;
--  DEC-05 blind entry, DEC-12, DEC-23, DEC-24, DEC-37 / DEC-41, DEC-44).
-- Added:    odometer_readings, odometer_reading_events, odometer_exceptions, odometer_requests (+ guards, audit, RLS, indexes),
--           odometer_messages() / odometer_fail_code() (the OD error catalogue, ONE place), odometer_stage_rank(), odometer_can_read(),
--           vehicles.current_odometer_reading_id foreign key.
-- Replaced: approval_decide_permission(text) — 030's three types unchanged, plus odometer_exception -> odometer.exception.approve (CREATE OR REPLACE, same signature),
--           so the approvals_select policy lets the approvers of a branch read the decision record. decide_approval() still cannot act on
--           it: no pending odometer_exception approval is ever created (the review functions insert the DECIDED approval).
-- Altered:  inspection_requests.function_name learns 'record_reading'; approvals_select no longer lets the requester read an odometer_exception
--           decision (the requester is the reading's submitter).
-- Write model: NO client INSERT/UPDATE/DELETE grants on any of these tables. Rows are written by the SECURITY DEFINER functions in 053 / 054.
-- OCR (Phase 6): ocr_result_id and ocr_reading_km exist but are ALWAYS NULL in this slice (CHECK). There is no odometer_ocr_results table
-- yet, so ocr_result_id has no foreign key; Phase 6 adds the table, the key and replaces the CHECK. DEC-05: nothing OCR-shaped is ever sent
-- to the driver's phone.
--
-- Error catalogue (SQLSTATE = code, HINT = 'user_message'; the message is shown as is; see odometer_messages()):
--   OD001 not allowed to check / decide this reading   OD002 reading not found   OD003 no longer waiting for review
--   OD004 changed since the list was loaded            OD005 wrong queue for this action   OD006 DEC-24: your own reading
--   OD007 a reason / note is required                  OD008 invalid accepted value        OD009 value equals the driver's value
--   OD010 invalid request                              OD011 an accepted reading already exists for this stage

-- ---------------------------------------------------------------- the error catalogue: ONE place (TypeScript mirror: odometer-errors.ts)
create function public.odometer_messages() returns table (code text, message text)
language sql immutable set search_path = '' as $$
  select * from (values
    ('OD001', 'You are not allowed to check this reading.'),
    ('OD002', 'That reading was not found, or you cannot access it.'),
    ('OD003', 'This reading is no longer waiting for review.'),
    ('OD004', 'This reading changed after you opened the list. Reload the list and check it again.'),
    ('OD005', 'This reading belongs in the other review queue.'),
    ('OD006', 'You cannot check or decide a reading you entered, from an inspection you completed, or on an allocation where you are the driver. Ask another supervisor.'),
    ('OD007', 'Add a note (1-500 characters) saying why.'),
    ('OD008', 'Enter the reading shown in the photo as whole kilometres, using digits only (0 to 9,999,999).'),
    ('OD009', 'That is the same as the reading the driver typed. Choose "Accept the driver''s reading" instead.'),
    ('OD010', 'That request could not be understood. Reload the page and try again.'),
    ('OD011', 'An accepted reading already exists for this stage of the allocation.')
  ) as t (code, message)
$$;
revoke all on function public.odometer_messages() from public, anon, authenticated;

create function public.odometer_fail_code(p_code text) returns void
language plpgsql set search_path = '' as $$
declare v_message text;
begin
  select m.message into v_message from public.odometer_messages() m where m.code = p_code;
  perform public.odometer_fail(p_code, coalesce(v_message, 'That could not be done.'));
end $$;
revoke all on function public.odometer_fail_code(text) from public, anon, authenticated;

-- pre-shift is earlier than post-shift of the same allocation (PRD §5.8.8: by allocation start, then post after pre)
create function public.odometer_stage_rank(p_stage text) returns integer
language sql immutable set search_path = '' as $$
  select case p_stage when 'pre_shift' then 0 when 'post_shift' then 1 end
$$;
revoke all on function public.odometer_stage_rank(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- odometer_readings (DB §8)
create table public.odometer_readings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  vehicle_id uuid not null,
  driver_id uuid not null,
  shift_id uuid not null,
  allocation_id uuid not null,
  inspection_id uuid not null,
  inspection_stage text not null check (inspection_stage in ('pre_shift', 'post_shift')),
  odometer_evidence_id uuid,                                   -- the CURRENT photo; null only for the no-photo exception (DEC-03, 5C)
  segment_id uuid not null,
  -- three separate values, never one editable field (CLAUDE.md)
  ocr_result_id uuid,                                          -- Phase 6: no table, no foreign key yet
  ocr_reading_km integer check (ocr_reading_km between 0 and 9999999),
  driver_reading_km integer check (driver_reading_km between 0 and 9999999),         -- DEC-12; never edited after entry closes
  accepted_reading_km integer check (accepted_reading_km between 0 and 9999999),
  accepted_lifetime_km integer check (accepted_lifetime_km >= 0),
  reading_status text not null default 'submitted' check (reading_status in ('submitted', 'awaiting_review', 'accepted', 'rejected', 'superseded')),
  review_status text not null default 'not_required' check (review_status in ('not_required', 'pending', 'approved', 'rejected')),
  review_kind text check (review_kind in ('quick_check', 'full')),                   -- DEC-44: which queue; kept when accepted
  acceptance_method text check (acceptance_method in ('auto_rule', 'reviewer', 'no_photo_exception')),
  validation_settings_id uuid,
  validation_settings_version integer,
  validation jsonb,                                            -- { settings: {id, version}, checks: [{key, result, values, note}], failed: [...], route }
  validated_at timestamptz,
  supersedes_reading_id uuid,                                  -- 5B corrections
  exception_summary text check (length(exception_summary) <= 1000),
  full_review_requested_by uuid,                               -- "doesn't match the photo" in the quick check (DEC-44)
  full_review_note text check (length(full_review_note) between 1 and 500),
  entered_by uuid not null,                                    -- who typed it = inspections.submitted_by (DEC-24)
  driver_profile_id uuid not null,                             -- the allocation's driver (DEC-24)
  device_entered_at timestamptz,                               -- untrusted (DEC-06)
  captured_offline boolean not null default false,
  client_submission_id uuid not null,
  submitted_at timestamptz not null default now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid,                                            -- null for auto_rule (no system user exists)
  approval_id uuid,
  row_version integer not null default 1,                      -- bumped by every change: the quick-check concurrency token
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (allocation_id, vehicle_id, driver_id, shift_id, branch_id)
    references public.vehicle_allocations (id, vehicle_id, driver_id, shift_id, branch_id),
  foreign key (inspection_id, allocation_id, inspection_stage) references public.inspections (id, allocation_id, inspection_stage),
  foreign key (odometer_evidence_id, company_id) references public.odometer_evidence (id, company_id),
  foreign key (segment_id, vehicle_id) references public.odometer_segments (id, vehicle_id),
  foreign key (validation_settings_id, company_id) references public.odometer_validation_settings (id, company_id),
  foreign key (supersedes_reading_id, company_id) references public.odometer_readings (id, company_id),
  foreign key (full_review_requested_by, company_id) references public.profiles (id, company_id),
  foreign key (entered_by, company_id) references public.profiles (id, company_id),
  foreign key (driver_profile_id, company_id) references public.profiles (id, company_id),
  foreign key (reviewed_by, company_id) references public.profiles (id, company_id),
  foreign key (accepted_by, company_id) references public.profiles (id, company_id),
  foreign key (approval_id, company_id) references public.approvals (id, company_id),
  unique (id, company_id),
  constraint odr_idempotent unique (company_id, client_submission_id),
  -- DB §8
  constraint odr_evidence_required check (odometer_evidence_id is not null or acceptance_method = 'no_photo_exception'),
  constraint odr_accepted_fields check (reading_status <> 'accepted'
    or (accepted_reading_km is not null and accepted_lifetime_km is not null and accepted_at is not null and acceptance_method is not null)),
  constraint odr_no_photo_approval check (acceptance_method is distinct from 'no_photo_exception' or approval_id is not null),
  constraint odr_accepted_only_when_accepted check (reading_status in ('accepted', 'superseded')
    or (accepted_reading_km is null and accepted_lifetime_km is null and accepted_at is null and accepted_by is null and acceptance_method is null)),
  -- 5A
  constraint odr_ocr_not_yet check (ocr_result_id is null and ocr_reading_km is null),   -- Phase 6 replaces this
  constraint odr_reviewer_accepted check (acceptance_method is distinct from 'reviewer' or (review_kind is not null and accepted_by is not null)),
  constraint odr_status_pair check (
       (reading_status = 'submitted'       and review_status = 'not_required')
    or (reading_status = 'awaiting_review' and review_status = 'pending' and review_kind is not null and validation is not null)
    or (reading_status = 'accepted'        and review_status in ('approved', 'not_required'))
    or (reading_status = 'rejected'        and review_status = 'rejected')
    or (reading_status = 'superseded'      and review_status in ('approved', 'not_required'))),
  constraint odr_validated_pair check ((validated_at is null) = (validation is null)),
  -- DEC-24 / DEC-44 in the database, not only in the UI: nobody checks or decides a reading they entered, one from an inspection they
  -- completed (entered_by IS inspections.submitted_by, fixed when the draft is begun), or one on an allocation where they are the driver
  constraint odr_no_self_accept check (accepted_by is null or (accepted_by <> entered_by and accepted_by <> driver_profile_id)),
  constraint odr_no_self_review check (reviewed_by is null or (reviewed_by <> entered_by and reviewed_by <> driver_profile_id)),
  constraint odr_no_self_send check (full_review_requested_by is null or (full_review_requested_by <> entered_by and full_review_requested_by <> driver_profile_id))
);
-- DB §8: one accepted reading per allocation and stage
create unique index odr_one_accepted_uq on public.odometer_readings (allocation_id, inspection_stage) where reading_status = 'accepted';
-- one live reading per inspection (a rejected or superseded one is history; a replacement inspection has its own)
create unique index odr_one_live_per_inspection_uq on public.odometer_readings (inspection_id)
  where reading_status in ('submitted', 'awaiting_review', 'accepted');
-- DB §22
create index odr_vehicle_status_accepted_idx on public.odometer_readings (vehicle_id, reading_status, accepted_at desc);
create index odr_allocation_stage_idx        on public.odometer_readings (allocation_id, inspection_stage);
create index odr_branch_queue_idx            on public.odometer_readings (branch_id, reading_status, review_kind);
-- FK covers, in FK column order (company_id is covered by the leading column of odr_idempotent)
create index odr_branch_company_idx        on public.odometer_readings (branch_id, company_id);
create index odr_allocation_fk_idx         on public.odometer_readings (allocation_id, vehicle_id, driver_id, shift_id, branch_id);
create index odr_inspection_fk_idx         on public.odometer_readings (inspection_id, allocation_id, inspection_stage);
create index odr_evidence_company_idx      on public.odometer_readings (odometer_evidence_id, company_id);
create index odr_segment_vehicle_idx       on public.odometer_readings (segment_id, vehicle_id);
create index odr_settings_company_idx      on public.odometer_readings (validation_settings_id, company_id);
create index odr_supersedes_company_idx    on public.odometer_readings (supersedes_reading_id, company_id);
create index odr_full_review_by_idx        on public.odometer_readings (full_review_requested_by, company_id);
create index odr_entered_by_idx            on public.odometer_readings (entered_by, company_id);
create index odr_driver_profile_idx        on public.odometer_readings (driver_profile_id, company_id);
create index odr_reviewed_by_idx           on public.odometer_readings (reviewed_by, company_id);
create index odr_accepted_by_idx           on public.odometer_readings (accepted_by, company_id);
create index odr_approval_company_idx      on public.odometer_readings (approval_id, company_id);
comment on table public.odometer_readings is
  'A candidate reading and its acceptance state (DB §8). OCR, driver and accepted values are three separate columns. Accepted rows are immutable (only accepted -> superseded, in 5B). The driver''s typed value is never edited: a reviewer''s different value is stored in accepted_reading_km (DEC-44).';
comment on column public.odometer_readings.review_kind is 'DEC-44: quick_check = no failed check (not_configured / waiting do not count); full = a failed check, or sent from the quick check. Kept when the reading is accepted (how it was accepted).';
comment on column public.odometer_readings.row_version is 'Bumped by every update (a general change counter). The quick-check concurrency token is validated_at: it changes only when the stored validation changes.';
comment on column public.odometer_readings.ocr_result_id is 'Phase 6: odometer_ocr_results does not exist yet, so no foreign key. Always NULL in 5A (odr_ocr_not_yet).';

-- ---------------------------------------------------------------- readings: insert and update guards
create function public.odometer_readings_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.inspections;
  e public.odometer_evidence;
begin
  select * into i from public.inspections where id = new.inspection_id and company_id = new.company_id;
  if not found or i.status <> 'draft' then
    raise exception 'a reading is created while its inspection is a draft' using errcode = '55000';
  end if;
  if new.entered_by <> i.submitted_by then
    raise exception 'the reading is entered by the person completing the inspection' using errcode = '23514';
  end if;
  if not exists (select 1 from public.drivers d where d.id = new.driver_id and d.profile_id = new.driver_profile_id and d.company_id = new.company_id) then
    raise exception 'driver_profile_id must be the allocation''s driver' using errcode = '23514';
  end if;
  if new.odometer_evidence_id is not null then
    select * into e from public.odometer_evidence where id = new.odometer_evidence_id and company_id = new.company_id;
    if not found or e.inspection_id <> new.inspection_id or not e.is_current then
      raise exception 'the reading links to the current odometer photo of its own inspection' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.odometer_readings_validate() from public, anon, authenticated;
create trigger odometer_readings_validate_t before insert on public.odometer_readings for each row execute function public.odometer_readings_validate();

-- Accepted rows are immutable except accepted -> superseded (5B does that; nothing in 5A may). Rejected and superseded are final.
-- Identity never changes. The driver's value and the photo link change only while the reading is still being entered ('submitted').
create function public.odometer_readings_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  col text;
  volatile_cols text[] := array['reading_status', 'updated_at', 'row_version'];
begin
  foreach col in array array['id', 'company_id', 'branch_id', 'vehicle_id', 'driver_id', 'shift_id', 'allocation_id', 'inspection_id', 'inspection_stage',
                             'segment_id', 'entered_by', 'driver_profile_id', 'client_submission_id', 'submitted_at', 'created_at', 'supersedes_reading_id'] loop
    if o -> col is distinct from n -> col then
      raise exception 'column odometer_readings.% is immutable', col using errcode = '23514';
    end if;
  end loop;
  if old.reading_status in ('rejected', 'superseded') then
    raise exception 'a % reading is history and cannot change', old.reading_status using errcode = '55000';
  end if;
  if old.reading_status = 'accepted' then
    if new.reading_status <> 'superseded' or (o - volatile_cols) is distinct from (n - volatile_cols) then
      raise exception 'an accepted reading is immutable (it can only be superseded by an accepted correction)' using errcode = '55000';
    end if;
  elsif new.reading_status <> old.reading_status
        and not ((old.reading_status = 'submitted' and new.reading_status in ('awaiting_review', 'rejected'))
              or (old.reading_status = 'awaiting_review' and new.reading_status in ('accepted', 'rejected'))) then
    raise exception 'a reading cannot go from % to %', old.reading_status, new.reading_status using errcode = '55000';
  end if;
  if old.reading_status <> 'submitted'
     and (new.driver_reading_km is distinct from old.driver_reading_km or new.odometer_evidence_id is distinct from old.odometer_evidence_id) then
    raise exception 'the driver''s reading and its photo are fixed once the inspection is submitted' using errcode = '55000';
  end if;
  new.row_version := old.row_version + 1;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.odometer_readings_guard() from public, anon, authenticated;
create trigger odometer_readings_guard_t before update on public.odometer_readings for each row execute function public.odometer_readings_guard();
create trigger odometer_readings_no_delete   before delete   on public.odometer_readings for each row       execute function public.forbid_delete();
create trigger odometer_readings_no_truncate before truncate on public.odometer_readings for each statement execute function public.forbid_delete();
create trigger odometer_readings_audit after insert or update or delete on public.odometer_readings for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- odometer_reading_events (append-only lifecycle log)
create table public.odometer_reading_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  odometer_reading_id uuid not null,
  event_type text not null check (event_type in (
    'submitted', 'ocr_completed', 'validated', 'exception_created', 'reviewed', 'accepted', 'rejected', 'correction_requested', 'corrected',
    'superseded',
    'value_changed', 'photo_relinked', 'sent_to_full_review')),   -- the last three are 5A additions to DB §8's list
  previous_value jsonb,
  new_value jsonb,
  reason text check (length(reason) <= 1000),
  actor_id uuid,                                               -- null = the system (validation at submit / re-validation)
  occurred_at timestamptz not null default clock_timestamp(),
  approval_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (odometer_reading_id, company_id) references public.odometer_readings (id, company_id),
  foreign key (actor_id, company_id) references public.profiles (id, company_id),
  foreign key (approval_id, company_id) references public.approvals (id, company_id)
);
create index ore_reading_company_idx on public.odometer_reading_events (odometer_reading_id, company_id, occurred_at);
create index ore_branch_company_idx   on public.odometer_reading_events (branch_id, company_id);
create index ore_actor_company_idx    on public.odometer_reading_events (actor_id, company_id);
create index ore_approval_company_idx on public.odometer_reading_events (approval_id, company_id);
create index ore_company_idx          on public.odometer_reading_events (company_id);
create trigger ore_no_change   before update or delete on public.odometer_reading_events for each row       execute function public.append_only();
create trigger ore_no_truncate before truncate         on public.odometer_reading_events for each statement execute function public.append_only();
create trigger ore_audit after insert on public.odometer_reading_events for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- odometer_exceptions (DB §8)
create table public.odometer_exceptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  branch_id uuid not null,
  vehicle_id uuid not null,
  driver_id uuid,
  allocation_id uuid,
  odometer_reading_id uuid,
  inspection_id uuid,
  exception_type text not null check (exception_type in (
    'unreadable_image', 'ocr_low_confidence', 'ocr_failed', 'ocr_driver_mismatch', 'decreasing_reading', 'implausible_distance',
    'unaccounted_distance', 'duplicate_submission', 'duplicate_image', 'gallery_upload', 'missing_reading', 'missing_inspection',
    'late_inspection', 'no_photo_exception', 'possible_odometer_replacement', 'possible_rollover', 'service_odometer_inconsistent', 'other')),
  description text not null check (length(description) between 1 and 1000),
  severity text not null check (severity in ('high', 'medium', 'low')),
  status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'dismissed')),
  assigned_to uuid,
  approval_id uuid,                                            -- the decision record (authoritative)
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_summary text check (length(resolution_summary) between 1 and 1000),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  foreign key (driver_id, company_id) references public.drivers (id, company_id),
  foreign key (allocation_id, company_id) references public.vehicle_allocations (id, company_id),
  foreign key (odometer_reading_id, company_id) references public.odometer_readings (id, company_id),
  foreign key (inspection_id, company_id) references public.inspections (id, company_id),
  foreign key (assigned_to, company_id) references public.profiles (id, company_id),
  foreign key (approval_id, company_id) references public.approvals (id, company_id),
  unique (id, company_id),
  constraint ode_resolved_shape check (
       (status in ('open', 'in_review') and resolved_at is null and resolution_summary is null and approval_id is null)
    or (status in ('resolved', 'dismissed') and resolved_at is not null and resolution_summary is not null))
);
-- one open exception per reading and type (re-validation never duplicates it)
create unique index ode_one_open_per_type_uq on public.odometer_exceptions (odometer_reading_id, exception_type) where status in ('open', 'in_review');
create index ode_branch_status_created_idx on public.odometer_exceptions (branch_id, status, created_at);   -- DB §22
create index ode_branch_company_idx     on public.odometer_exceptions (branch_id, company_id);
create index ode_vehicle_company_idx    on public.odometer_exceptions (vehicle_id, company_id);
create index ode_driver_company_idx     on public.odometer_exceptions (driver_id, company_id);
create index ode_allocation_company_idx on public.odometer_exceptions (allocation_id, company_id);
create index ode_reading_company_idx    on public.odometer_exceptions (odometer_reading_id, company_id);
create index ode_inspection_company_idx on public.odometer_exceptions (inspection_id, company_id);
create index ode_assigned_company_idx   on public.odometer_exceptions (assigned_to, company_id);
create index ode_approval_company_idx   on public.odometer_exceptions (approval_id, company_id);
create index ode_company_idx            on public.odometer_exceptions (company_id);
comment on table public.odometer_exceptions is 'Append-only except status / resolved_at / resolution_summary / approval_id, which change once (open -> resolved | dismissed), only inside the review and re-validation functions (transaction flag app.odometer_review). approvals holds the decision; status mirrors it.';

create function public.odometer_exceptions_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  col text;
begin
  foreach col in array array['id', 'company_id', 'branch_id', 'vehicle_id', 'driver_id', 'allocation_id', 'odometer_reading_id', 'inspection_id',
                             'exception_type', 'description', 'severity', 'created_at'] loop
    if o -> col is distinct from n -> col then
      raise exception 'column odometer_exceptions.% is immutable', col using errcode = '23514';
    end if;
  end loop;
  if old.status in ('resolved', 'dismissed') then
    raise exception 'a % exception cannot change', old.status using errcode = '55000';
  end if;
  if new.status in ('resolved', 'dismissed') and coalesce(current_setting('app.odometer_review', true), '') <> 'on' then
    raise exception 'exceptions are resolved only through the review functions' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.odometer_exceptions_guard() from public, anon, authenticated;
create trigger odometer_exceptions_guard_t before update on public.odometer_exceptions for each row execute function public.odometer_exceptions_guard();
create trigger odometer_exceptions_no_delete   before delete   on public.odometer_exceptions for each row       execute function public.forbid_delete();
create trigger odometer_exceptions_no_truncate before truncate on public.odometer_exceptions for each statement execute function public.forbid_delete();
create trigger odometer_exceptions_audit after insert or update or delete on public.odometer_exceptions for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- odometer_requests: idempotency ledger for the review functions (like damage_requests)
create table public.odometer_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  actor_id uuid not null,
  client_submission_id uuid not null,
  function_name text not null check (function_name in ('quick_check', 'send_to_full', 'review')),
  request_hash text not null,
  odometer_reading_id uuid,                                    -- null for a batch
  result jsonb not null,                                       -- what the call answered: a replay answers the same
  created_at timestamptz not null default now(),
  foreign key (actor_id, company_id) references public.profiles (id, company_id),
  foreign key (odometer_reading_id, company_id) references public.odometer_readings (id, company_id),
  constraint odometer_requests_idempotent unique (company_id, actor_id, client_submission_id)
);
create index odometer_requests_actor_idx   on public.odometer_requests (actor_id, company_id);
create index odometer_requests_reading_idx on public.odometer_requests (odometer_reading_id, company_id);
create trigger odometer_requests_no_change before update or delete on public.odometer_requests for each row execute function public.append_only();
create trigger odometer_requests_no_truncate before truncate on public.odometer_requests for each statement execute function public.append_only();

-- inspection_requests (the inspection ledger) learns the driver's reading entry
alter table public.inspection_requests drop constraint inspection_requests_function_name_check;
alter table public.inspection_requests add constraint inspection_requests_function_name_check
  check (function_name in ('begin', 'save_responses', 'attach_odometer', 'attach_photo', 'submit', 'void',
                           'report_damage', 'confirm_known_damage', 'begin_on_behalf', 'record_reading'));

-- ---------------------------------------------------------------- approvals: the deciding permission of the odometer_exception type (DEC-23)
create or replace function public.approval_decide_permission(p_type text) returns text
language sql immutable set search_path = '' as $$
  select case p_type
           when 'branch_transfer'         then 'vehicle.transfer.approve'
           when 'service_config_override' then 'service.config.manage'
           when 'licence_override'        then 'allocation.manage'
           when 'odometer_exception'      then 'odometer.exception.approve'
         end
$$;

-- approvals_select (014) lets a REQUESTER read their own request. For odometer_exception the requester is the reading's submitter (see 054),
-- who must not read the reviewer's decision notes: the requester branch of the policy excludes that type. Approvers of the branch still read it.
drop policy approvals_select on public.approvals;
create policy approvals_select on public.approvals for select to authenticated
  using (company_id = (select public.current_company_id())
         and ((requested_by = (select auth.uid()) and approval_type <> 'odometer_exception')
              or public.has_permission(public.approval_decide_permission(approval_type), branch_id)));

-- ---------------------------------------------------------------- vehicles.current_odometer_reading_id now has its foreign key
alter table public.vehicles add constraint vehicles_current_reading_fk
  foreign key (current_odometer_reading_id, company_id) references public.odometer_readings (id, company_id);
create index vehicles_current_reading_idx on public.vehicles (current_odometer_reading_id, company_id);

-- ---------------------------------------------------------------- RLS
-- Who may read readings of a branch: the people who review them there, and report viewers who may see the driver register (DEC-37 / DEC-41:
-- supervisor, fleet admin, branch manager, senior management). Maintenance and system administrators see nothing, although a maintenance
-- administrator holds reports.view: the register-visibility test is what keeps them out.
create function public.odometer_can_read(p_branch_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_permission('odometer.exception.review', p_branch_id)
      or (public.has_permission('reports.view', p_branch_id) and public.driver_register_visible(p_branch_id, null))
$$;
revoke all on function public.odometer_can_read(uuid) from public, anon;
grant execute on function public.odometer_can_read(uuid) to authenticated, service_role;

alter table public.odometer_readings       enable row level security;
alter table public.odometer_reading_events enable row level security;
alter table public.odometer_exceptions     enable row level security;
alter table public.odometer_requests       enable row level security;
revoke all on public.odometer_readings, public.odometer_reading_events, public.odometer_exceptions, public.odometer_requests
  from public, anon, authenticated;

-- The allocation's driver reads their own readings, WITHOUT the reviewer fields (validation, reviewer ids, decision, queue, notes):
-- a column list, so nobody reads those through the table (reviewers use the review functions in 054). No OCR column either (DEC-05).
grant select (id, company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, inspection_id, inspection_stage, odometer_evidence_id,
              driver_reading_km, accepted_reading_km, reading_status, review_status, device_entered_at, captured_offline, submitted_at,
              accepted_at, row_version, created_at, updated_at)
  on public.odometer_readings to authenticated;
create policy odometer_readings_select on public.odometer_readings for select to authenticated
  using (company_id = (select public.current_company_id())
         and (public.driver_is_self(driver_id) or public.odometer_can_read(branch_id)));

grant select on public.odometer_reading_events, public.odometer_exceptions to authenticated;
create policy odometer_reading_events_select on public.odometer_reading_events for select to authenticated
  using (company_id = (select public.current_company_id()) and public.odometer_can_read(branch_id));
create policy odometer_exceptions_select on public.odometer_exceptions for select to authenticated
  using (company_id = (select public.current_company_id()) and public.odometer_can_read(branch_id));
-- odometer_requests: no client access at all (ledger)
