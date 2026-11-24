-- 047 — Slice 4C (2/3): damage reporting, review and repair; the known-damage confirmation; submit_inspection (IN007, new_damage_flag)
-- (PRD v1.18 §4.2, §5.6, §5.7, §5.12, §6; ARCH v1.17 §6.2–§6.4; DB v1.13 §6, §7, §20; DEC-04/41, DEC-06, DEC-23, DEC-24, DEC-42).
-- Added columns: inspections.known_damage_reviewed boolean default false, inspections.new_damage_flag boolean default false
--   (a SUBMISSION field: only submit_inspection() sets it, same rule as late_flag in inspections_guard).
-- Added (client, SECURITY DEFINER, search_path = '', authenticated only):
--   confirm_known_damage_reviewed, report_damage, record_onboarding_damage, review_damage, mark_damage_repaired, inspection_new_damage
-- Replaced (CREATE OR REPLACE, same signature, ACL unchanged): submit_inspection (new IN007 after IN001; sets new_damage_flag; every
--   other rule exactly as in 040/043), inspections_guard (new_damage_flag is a submission field).
-- Dropped and created again (a returned row type cannot change in place; ACL as before): list_inspections (+ new_damage_flag, known_damage_reviewed).
-- Replaced constraint: inspections_draft_unsubmitted (+ not new_damage_flag).
-- my_inspection (known damage list, known_damage_reviewed) is replaced in 048 together with its on-behalf read rule.
-- Every write takes p_client_submission_id and is idempotent (DEC-06). Refusals: see 038 (IN0xx) and 046 (DM0xx).

alter table public.inspections
  add column known_damage_reviewed boolean not null default false,
  add column new_damage_flag boolean not null default false;
alter table public.inspections drop constraint inspections_draft_unsubmitted;
alter table public.inspections add constraint inspections_draft_unsubmitted
  check (status <> 'draft' or (submitted_at is null and not late_flag and not safety_defect_flag and not new_damage_flag));
comment on column public.inspections.known_damage_reviewed is 'DEC-42: the person completing the inspection confirmed "I have checked the known damage list". Required to submit (IN007).';
comment on column public.inspections.new_damage_flag is 'DEC-42: set by submit_inspection() when a PRE-shift inspection reported at least one damage item: the damage appeared between the vehicle''s previous post-shift inspection and now. A prompt to investigate; it assigns no fault or liability to anyone.';

-- ---------------------------------------------------------------- confirm_known_damage_reviewed
create function public.confirm_known_damage_reviewed(p_inspection_id uuid, p_client_submission_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  i public.inspections;
  v_hash text;
begin
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  i := public.inspection_load_for_driver(p_inspection_id);
  v_hash := md5(p_inspection_id::text);
  if public.inspection_replay(i.company_id, v_uid, p_client_submission_id, 'confirm_known_damage', v_hash) is not null then
    return i.id;
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is %s: it can no longer be changed', i.status));
  end if;
  if not i.known_damage_reviewed then
    update public.inspections set known_damage_reviewed = true where id = i.id;
  end if;
  perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'confirm_known_damage', v_hash, i.id);
  return i.id;
end $$;

-- ---------------------------------------------------------------- shared input checks (one place)
create function public.damage_check_input(p_zone text, p_severity text, p_description text, p_files uuid[]) returns text
language plpgsql immutable set search_path = '' as $$
declare v_desc text := btrim(coalesce(p_description, ''));
begin
  if p_zone is null or not (p_zone = any (public.damage_zones())) then
    perform public.inspection_fail('DM005', 'Choose where on the vehicle the damage is.');
  end if;
  if p_severity is null or p_severity not in ('minor', 'moderate', 'major') then
    perform public.inspection_fail('DM005', 'Choose how serious the damage is: minor, moderate or major.');
  end if;
  if length(v_desc) < 1 or length(v_desc) > 500 then
    perform public.inspection_fail('DM005', 'Describe the damage in 1 to 500 characters.');
  end if;
  if p_files is null or cardinality(p_files) < 1 then
    perform public.inspection_fail('DM006', 'A damage report needs at least one photo taken with the in-app camera.');
  end if;
  if cardinality(p_files) > 10 or cardinality(p_files) <> (select count(distinct x) from unnest(p_files) x) or array_position(p_files, null) is not null then
    perform public.inspection_fail('22023', 'a damage report takes 1 to 10 different photos');
  end if;
  return v_desc;
end $$;
revoke all on function public.damage_check_input(text, text, text, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------- report_damage
-- Draft inspection, its completer. Pre-shift: the interval is the vehicle's previous USED allocation by allocation chronology (planned
-- start, then id — never the highest value or the device time) and that allocation's submitted post-shift inspection, if any.
-- Each photo becomes the item's evidence AND an inspection_photos row (category 'damage') so the inspection detail shows it.
create function public.report_damage(
  p_inspection_id uuid, p_zone text, p_severity text, p_description text, p_evidence_file_ids uuid[],
  p_device_reported_at timestamptz, p_captured_offline boolean, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  i public.inspections;
  a public.vehicle_allocations;
  prev public.vehicle_allocations;
  v_prev_ins uuid;
  v_desc text;
  v_hash text;
  v_id uuid;
  f uuid;
begin
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  i := public.inspection_load_for_driver(p_inspection_id);
  v_hash := md5(p_inspection_id::text || '|' || coalesce(p_zone, '') || '|' || coalesce(p_severity, '') || '|' || btrim(coalesce(p_description, ''))
                || '|' || coalesce((select string_agg(x::text, ',' order by x) from unnest(p_evidence_file_ids) x), ''));
  if public.inspection_replay(i.company_id, v_uid, p_client_submission_id, 'report_damage', v_hash) is not null then
    select d.id into v_id from public.vehicle_damage_items d
     where d.company_id = i.company_id and d.reported_by = v_uid and d.client_submission_id = p_client_submission_id;
    return v_id;
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('DM007', format('this inspection is %s: damage can no longer be reported in it', i.status));
  end if;
  v_desc := public.damage_check_input(p_zone, p_severity, p_description, p_evidence_file_ids);

  if i.inspection_stage = 'pre_shift' then
    select * into a from public.vehicle_allocations x where x.id = i.allocation_id;
    select * into prev from public.vehicle_allocations x
     where x.vehicle_id = i.vehicle_id and x.company_id = i.company_id and x.id <> a.id
       and x.status in ('in_use', 'post_inspection_pending', 'closed', 'closed_with_exceptions')
       and (x.planned_start_at, x.id) < (a.planned_start_at, a.id)
     order by x.planned_start_at desc, x.id desc limit 1;
    if found then
      select y.id into v_prev_ins from public.inspections y
       where y.allocation_id = prev.id and y.inspection_stage = 'post_shift' and y.status = 'submitted';
    end if;
  end if;

  insert into public.vehicle_damage_items (company_id, branch_id, vehicle_id, zone, severity, description, source, reported_in_inspection_id,
                                           reported_stage, reported_by, device_reported_at, captured_offline,
                                           interval_previous_allocation_id, interval_previous_inspection_id, client_submission_id)
  values (i.company_id, i.branch_id, i.vehicle_id, p_zone, p_severity, v_desc, 'inspection', i.id, i.inspection_stage, v_uid,
          p_device_reported_at, coalesce(p_captured_offline, false), prev.id, v_prev_ins, p_client_submission_id)
  returning id into v_id;
  -- a file already used anywhere (also by this inspection) is refused with the stable message before the one allowed double use below
  foreach f in array p_evidence_file_ids loop
    if exists (select 1 from public.vehicle_damage_evidence e where e.evidence_file_id = f)
       or exists (select 1 from public.inspection_photos p where p.evidence_file_id = f)
       or exists (select 1 from public.odometer_evidence o where o.evidence_file_id = f) then
      perform public.inspection_fail('IN014', 'that photo is already attached to an inspection');
    end if;
  end loop;
  foreach f in array p_evidence_file_ids loop
    perform set_config('app.damage_report_file', f::text, true);
    insert into public.vehicle_damage_evidence (company_id, damage_item_id, evidence_file_id, added_by) values (i.company_id, v_id, f, v_uid);
    insert into public.inspection_photos (company_id, branch_id, inspection_id, vehicle_id, evidence_file_id, photo_category)
    values (i.company_id, i.branch_id, i.id, i.vehicle_id, f, 'damage');
    perform set_config('app.damage_report_file', '', true);
  end loop;
  perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'report_damage', v_hash, i.id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- record_onboarding_damage (day-one load, DEC-42)
create function public.record_onboarding_damage(
  p_vehicle_id uuid, p_zone text, p_severity text, p_description text, p_evidence_file_ids uuid[], p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v public.vehicles;
  ex public.vehicle_damage_items;
  v_desc text;
  v_id uuid;
  f uuid;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  select * into v from public.vehicles x where x.id = p_vehicle_id and x.company_id = v_company;
  if not found or not public.has_permission('allocation.manage', v.current_branch_id) then
    perform public.inspection_fail('42501', 'that vehicle was not found, or you cannot record damage for its branch');
  end if;
  select * into ex from public.vehicle_damage_items d where d.company_id = v_company and d.reported_by = v_uid and d.client_submission_id = p_client_submission_id;
  if found then
    if ex.vehicle_id <> p_vehicle_id or ex.zone is distinct from p_zone or ex.severity is distinct from p_severity or ex.source <> 'onboarding' then
      perform public.inspection_fail('22023', 'client_submission_id was already used for a different request');
    end if;
    return ex.id;
  end if;
  v_desc := public.damage_check_input(p_zone, p_severity, p_description, p_evidence_file_ids);
  insert into public.vehicle_damage_items (company_id, branch_id, vehicle_id, zone, severity, description, source, reported_by, client_submission_id)
  values (v_company, v.current_branch_id, v.id, p_zone, p_severity, v_desc, 'onboarding', v_uid, p_client_submission_id)
  returning id into v_id;
  foreach f in array p_evidence_file_ids loop
    insert into public.vehicle_damage_evidence (company_id, damage_item_id, evidence_file_id, added_by) values (v_company, v_id, f, v_uid);
  end loop;
  return v_id;
end $$;

-- ---------------------------------------------------------------- review_damage / mark_damage_repaired
create function public.damage_replay(p_company uuid, p_actor uuid, p_csid uuid, p_function text, p_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.damage_requests;
begin
  select * into r from public.damage_requests where company_id = p_company and actor_id = p_actor and client_submission_id = p_csid;
  if not found then
    return null;
  end if;
  if r.function_name <> p_function or r.request_hash <> p_hash then
    perform public.inspection_fail('22023', 'client_submission_id was already used for a different request');
  end if;
  return r.damage_item_id;
end $$;
revoke all on function public.damage_replay(uuid, uuid, uuid, text, text) from public, anon, authenticated;

create function public.review_damage(p_item_id uuid, p_decision text, p_reason text, p_client_submission_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := nullif(btrim(p_reason), '');
  v_hash text;
  d public.vehicle_damage_items;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  select * into d from public.vehicle_damage_items x where x.id = p_item_id and x.company_id = v_company for update;
  if not found or not public.has_permission('allocation.manage', d.branch_id) then
    perform public.inspection_fail('42501', 'that damage item was not found, or only a manager of its branch can review it');
  end if;
  v_hash := md5(p_item_id::text || '|' || coalesce(p_decision, '') || '|' || coalesce(v_reason, ''));
  if public.damage_replay(v_company, v_uid, p_client_submission_id, 'review', v_hash) is not null then
    return d.id;
  end if;
  if d.reported_by = v_uid then
    perform public.inspection_fail('DM003', 'You cannot review damage you reported yourself; another manager must verify or dispute it.');
  end if;
  if p_decision is null or p_decision not in ('verified', 'disputed') then
    perform public.inspection_fail('22023', 'the decision must be verified or disputed');
  end if;
  if d.status <> 'reported' then
    perform public.inspection_fail('DM002', format('this damage item is already %s and cannot be reviewed again', d.status));
  end if;
  if p_decision = 'disputed' and v_reason is null then
    perform public.inspection_fail('DM004', 'A reason is required to dispute a damage report.');
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    perform public.inspection_fail('DM004', 'the reason must be at most 500 characters');
  end if;
  perform set_config('app.damage_write', 'review', true);
  perform set_config('app.audit_reason', coalesce(v_reason, 'damage verified'), true);
  update public.vehicle_damage_items set status = p_decision, reviewed_by = v_uid, reviewed_at = now(), review_reason = v_reason where id = d.id;
  perform set_config('app.damage_write', '', true);
  perform set_config('app.audit_reason', '', true);
  insert into public.damage_requests (company_id, actor_id, client_submission_id, function_name, request_hash, damage_item_id)
  values (v_company, v_uid, p_client_submission_id, 'review', v_hash, d.id);
  return d.id;
end $$;

create function public.mark_damage_repaired(p_item_id uuid, p_note text, p_client_submission_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_note text := nullif(btrim(p_note), '');
  v_hash text;
  d public.vehicle_damage_items;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  select * into d from public.vehicle_damage_items x where x.id = p_item_id and x.company_id = v_company for update;
  if not found or not public.has_permission('service.record.create', d.branch_id) then
    perform public.inspection_fail('42501', 'that damage item was not found, or you cannot mark it repaired');
  end if;
  v_hash := md5(p_item_id::text || '|' || coalesce(v_note, ''));
  if public.damage_replay(v_company, v_uid, p_client_submission_id, 'repair', v_hash) is not null then
    return d.id;
  end if;
  if d.reported_by = v_uid then
    perform public.inspection_fail('DM003', 'You cannot mark damage you reported yourself as repaired.');
  end if;
  if d.status <> 'verified' then
    perform public.inspection_fail('DM002', case d.status
      when 'reported' then 'This damage report must be verified before it can be marked repaired.'
      else format('this damage item is %s and cannot be marked repaired', d.status) end);
  end if;
  if v_note is null or length(v_note) > 500 then
    perform public.inspection_fail('DM004', 'A note (1-500 characters) is required to mark damage repaired.');
  end if;
  perform set_config('app.damage_write', 'repair', true);
  perform set_config('app.audit_reason', v_note, true);
  update public.vehicle_damage_items set status = 'repaired', repaired_by = v_uid, repaired_at = now(), repair_note = v_note where id = d.id;
  perform set_config('app.damage_write', '', true);
  perform set_config('app.audit_reason', '', true);
  insert into public.damage_requests (company_id, actor_id, client_submission_id, function_name, request_hash, damage_item_id)
  values (v_company, v_uid, p_client_submission_id, 'repair', v_hash, d.id);
  return d.id;
end $$;

-- ---------------------------------------------------------------- inspection_new_damage: the supervisor's view of damage reported in one inspection
-- allocation.manage or reports.view for the inspection's branch. No names. The interval says WHEN the damage appeared; it assigns no fault.
create function public.inspection_new_damage(p_inspection_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.inspections;
begin
  if auth.uid() is null or public.current_company_id() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into i from public.inspections x where x.id = p_inspection_id and x.company_id = public.current_company_id();
  if not found or not (public.has_permission('allocation.manage', i.branch_id) or public.has_permission('reports.view', i.branch_id)) then
    perform public.inspection_fail('P0002', 'that inspection was not found, or you cannot access it');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'zone', d.zone, 'zone_label', public.damage_zone_label(d.zone), 'severity', d.severity, 'description', d.description,
      'status', d.status, 'reported_at', d.reported_at, 'stage', d.reported_stage,
      'photo_ids', (select coalesce(jsonb_agg(e.evidence_file_id order by e.added_at, e.id), '[]'::jsonb) from public.vehicle_damage_evidence e where e.damage_item_id = d.id),
      'interval', case when d.reported_stage <> 'pre_shift' then null else jsonb_build_object(
        'previous_allocation_id', d.interval_previous_allocation_id,
        'previous_allocation_planned_start_at', pa.planned_start_at,
        'previous_allocation_planned_end_at', pa.planned_end_at,
        'previous_post_shift_submitted_at', pi.submitted_at) end)
      order by d.reported_at, d.id)
      from public.vehicle_damage_items d
      left join public.vehicle_allocations pa on pa.id = d.interval_previous_allocation_id and pa.company_id = d.company_id
      left join public.inspections pi on pi.id = d.interval_previous_inspection_id and pi.company_id = d.company_id
     where d.reported_in_inspection_id = i.id and d.company_id = i.company_id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- inspections_guard: new_damage_flag is a submission field
create or replace function public.inspections_guard() returns trigger
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
    elsif new.submitted_at is not null or new.late_flag or new.safety_defect_flag or new.device_id is not null or new.device_flag is not null or new.new_damage_flag then
      raise exception 'the submission fields are set by submit_inspection()' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- submit_inspection: 043's rules + IN007 + new_damage_flag
create or replace function public.submit_inspection(
  p_inspection_id uuid, p_device_submitted_at timestamptz, p_captured_offline boolean, p_client_submission_id uuid)
returns table (out_inspection_id uuid, out_status text, out_late_flag boolean, out_safety_defect_flag boolean, out_replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  i public.inspections;
  a public.vehicle_allocations;
  st record;
  v_late boolean;
  v_safety boolean;
  v_text text;
  v_n integer;
  v_reg text;
  v_device uuid;
  v_flag text;
  v_new_damage boolean;
begin
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  -- lock order: the allocation, then the inspection (begin_inspection locks the allocation first too)
  perform 1 from public.vehicle_allocations x
   where x.company_id = public.current_company_id()
     and x.id = (select y.allocation_id from public.inspections y where y.id = p_inspection_id and y.company_id = x.company_id) for update;
  i := public.inspection_load_for_driver(p_inspection_id);
  v_hash := md5(p_inspection_id::text);
  if public.inspection_replay(i.company_id, v_uid, p_client_submission_id, 'submit', v_hash) is not null then
    out_inspection_id := i.id; out_status := i.status; out_late_flag := i.late_flag; out_safety_defect_flag := i.safety_defect_flag;
    out_replayed := true;
    return next;
    return;
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is already %s', i.status));
  end if;
  select * into a from public.vehicle_allocations x where x.id = i.allocation_id;
  if (i.inspection_stage = 'pre_shift' and a.status <> 'pre_inspection_pending')
     or (i.inspection_stage = 'post_shift' and a.status <> 'post_inspection_pending') then
    perform public.inspection_fail('55000', format('this inspection cannot be submitted while the allocation is %s', replace(a.status, '_', ' ')));
  end if;

  -- 1. the driver confirmed the vehicle
  if not i.vehicle_confirmed then
    select v.registration_number into v_reg from public.vehicles v where v.id = i.vehicle_id;
    perform public.inspection_fail('IN001', format('Confirm that you are inspecting the vehicle shown (%s) before you submit.', v_reg));
  end if;
  -- 1b. IN007 (DEC-42): the person completing the inspection confirmed they checked the vehicle's known damage list
  if not i.known_damage_reviewed then
    perform public.inspection_fail('IN007', 'Confirm that you checked the vehicle''s known damage list before you submit.');
  end if;
  -- 2. every required item for the stage is answered
  select count(*) into v_n
    from public.inspection_template_items it
   where it.template_id = i.template_id and it.required and it.applies_to_stage in (i.inspection_stage, 'both')
     and not exists (select 1 from public.inspection_responses r where r.inspection_id = i.id and r.template_item_id = it.id);
  select it.question into v_text
    from public.inspection_template_items it
   where it.template_id = i.template_id and it.required and it.applies_to_stage in (i.inspection_stage, 'both')
     and not exists (select 1 from public.inspection_responses r where r.inspection_id = i.id and r.template_item_id = it.id)
   order by it.sequence limit 1;
  if v_n > 0 then
    perform public.inspection_fail('IN002', format('Answer every required item before you submit: "%s" is not answered (%s still to answer).', v_text, v_n));
  end if;
  -- 3. every Defect has a comment and a photo linked to that item
  select it.question into v_text
    from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
   where r.inspection_id = i.id and r.response_value = 'defect' and r.comment is null
   order by it.sequence limit 1;
  if found then
    perform public.inspection_fail('IN003', format('Describe the defect: "%s" needs a comment.', v_text));
  end if;
  select it.question into v_text
    from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
   where r.inspection_id = i.id and r.response_value = 'defect'
     and not exists (select 1 from public.inspection_photos p where p.inspection_id = i.id and p.template_item_id = r.template_item_id)
   order by it.sequence limit 1;
  if found then
    perform public.inspection_fail('IN004', format('Add a photo of the defect: "%s" needs at least one photo.', v_text));
  end if;
  -- 4. every Yes (yes_no_detail) has a comment
  select it.question into v_text
    from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
   where r.inspection_id = i.id and it.response_type = 'yes_no_detail' and r.response_value = 'yes' and r.comment is null
   order by it.sequence limit 1;
  if found then
    perform public.inspection_fail('IN005', format('Add the details: "%s" was answered Yes and needs a comment.', v_text));
  end if;
  -- 5. a current odometer photo (mandatory; the no-photo exception is Phase 5 and does not exist yet: no bypass)
  if not exists (select 1 from public.odometer_evidence o where o.inspection_id = i.id and o.is_current) then
    perform public.inspection_fail('IN006', 'The odometer photo is required: take a photo of the odometer before you submit.');
  end if;

  select * into st from public.allocation_settings(i.company_id);
  v_late := public.inspection_is_late(i.inspection_stage, now(), a.planned_start_at, a.planned_end_at, st.pre_shift_late_minutes, st.post_shift_late_minutes);
  v_safety := exists (select 1 from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
                       where r.inspection_id = i.id and r.response_value = 'defect' and it.severity_rule = 'safety_critical');

  -- DEC-35: the inspection's device is the one that took its CURRENT odometer photo; compared with the driver's issued device
  -- as it stands now. Flags only — nothing here can refuse a submission.
  select ef.device_id into v_device
    from public.odometer_evidence o join public.evidence_files ef on ef.id = o.evidence_file_id
   where o.inspection_id = i.id and o.is_current;
  v_flag := public.inspection_device_flag(i.company_id, i.driver_id, v_device);

  -- DEC-42: damage first reported in a PRE-shift inspection (not already in the register) appeared between the previous
  -- post-shift inspection and now. A flag for investigation only; it assigns no fault or liability. Post-shift reports never set it.
  v_new_damage := i.inspection_stage = 'pre_shift'
                  and exists (select 1 from public.vehicle_damage_items d where d.reported_in_inspection_id = i.id and d.source = 'inspection');

  update public.inspections
     set status = 'submitted', submitted_at = now(), device_submitted_at = p_device_submitted_at,
         captured_offline = captured_offline or coalesce(p_captured_offline, false),
         late_flag = v_late, safety_defect_flag = v_safety, device_id = v_device, device_flag = v_flag,
         new_damage_flag = v_new_damage
   where id = i.id;

  if i.inspection_stage = 'pre_shift' then
    -- rule d (033 refuses it for everyone else): only through this function, only for this allocation
    perform set_config('app.inspection_transition', a.id::text || ':in_use', true);
    perform public.transition_allocation(a.id, 'in_use', null, md5(p_client_submission_id::text || ':in_use')::uuid);
    perform set_config('app.inspection_transition', '', true);
  end if;

  perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'submit', v_hash, i.id);
  out_inspection_id := i.id; out_status := 'submitted'; out_late_flag := v_late; out_safety_defect_flag := v_safety; out_replayed := false;
  return next;
end $$;

-- ---------------------------------------------------------------- list_inspections: + new_damage_flag, known_damage_reviewed
drop function public.list_inspections(timestamptz, timestamptz, uuid, integer);
create function public.list_inspections(p_from timestamptz, p_to timestamptz, p_branch_id uuid default null, p_limit integer default 200)
returns table (
  inspection_id uuid, allocation_id uuid, branch_id uuid, branch_name text, shift_date date, inspection_stage text, status text,
  vehicle_fleet_number text, vehicle_registration text, started_at timestamptz, submitted_at timestamptz,
  late_flag boolean, safety_defect_flag boolean, captured_offline boolean, completed_by_role text, allocation_status text, device_flag text,
  new_damage_flag boolean, known_damage_reviewed boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    perform public.inspection_fail('22023', 'the end of the range must be after its start');
  end if;
  if p_to - p_from > interval '92 days' then
    perform public.inspection_fail('22023', 'the range can be at most 92 days');
  end if;
  return query
  select i.id, i.allocation_id, i.branch_id, b.name::text, s.shift_date, i.inspection_stage, i.status,
         v.fleet_number::text, v.registration_number::text, i.started_at, i.submitted_at,
         i.late_flag, i.safety_defect_flag, i.captured_offline, i.completed_by_role, a.status, i.device_flag,
         i.new_damage_flag, i.known_damage_reviewed
    from public.inspections i
    join public.branches b on b.id = i.branch_id and b.company_id = i.company_id
    join public.shifts s on s.id = i.shift_id and s.company_id = i.company_id
    join public.vehicles v on v.id = i.vehicle_id and v.company_id = i.company_id
    join public.vehicle_allocations a on a.id = i.allocation_id and a.company_id = i.company_id
   where i.company_id = v_company
     and (p_branch_id is null or i.branch_id = p_branch_id)
     and i.started_at >= p_from and i.started_at < p_to
     and (public.has_permission('allocation.manage', i.branch_id) or public.has_permission('reports.view', i.branch_id))
   order by i.started_at desc, i.id
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on function
  public.confirm_known_damage_reviewed(uuid, uuid),
  public.report_damage(uuid, text, text, text, uuid[], timestamptz, boolean, uuid),
  public.record_onboarding_damage(uuid, text, text, text, uuid[], uuid),
  public.review_damage(uuid, text, text, uuid),
  public.mark_damage_repaired(uuid, text, uuid),
  public.inspection_new_damage(uuid),
  public.list_inspections(timestamptz, timestamptz, uuid, integer)
  from public, anon, authenticated;
grant execute on function
  public.confirm_known_damage_reviewed(uuid, uuid),
  public.report_damage(uuid, text, text, text, uuid[], timestamptz, boolean, uuid),
  public.record_onboarding_damage(uuid, text, text, text, uuid[], uuid),
  public.review_damage(uuid, text, text, uuid),
  public.mark_damage_repaired(uuid, text, uuid),
  public.inspection_new_damage(uuid),
  public.list_inspections(timestamptz, timestamptz, uuid, integer)
  to authenticated;
