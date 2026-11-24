-- 039 — Slice 4A (3/3): the inspection functions, transition rules d and e, and started_at
-- (PRD v1.15 §5.5–§5.8.3, §6; ARCH v1.14 §6.1–§6.4, §6.9; DB v1.10 §6, §8, §20, §21; DEC-04, DEC-06, DEC-17, DEC-24).
-- Added (client, SECURITY DEFINER, search_path = '', authenticated only):
--   begin_inspection, save_inspection_responses, attach_odometer_photo, attach_inspection_photo, submit_inspection,
--   void_inspection, my_inspection, list_inspections
-- Added (internal, no client grant): inspection_is_late, inspection_replay, inspection_record, inspection_load_for_driver
-- Replaced (CREATE OR REPLACE, ACLs kept): transition_allocation (rules d and e), va_lifecycle_guard (started_at)
--
-- Every write takes p_client_submission_id and is idempotent (DEC-06): a retry with the same id and request returns the recorded
-- outcome (inspection_requests ledger); the same id with a different request is refused (22023). Refusals: see 038's header.
-- The user-scoped client is used by the app; none of this needs the service-role key.

-- ---------------------------------------------------------------- the late rule (DEC-17), pure so tests and the TS mirror can vary the numbers
-- pre-shift: submitted_at > shift start + pre minutes; post-shift: submitted_at > allocation planned end + post minutes (strict).
create function public.inspection_is_late(
  p_stage text, p_submitted_at timestamptz, p_shift_start timestamptz, p_planned_end timestamptz,
  p_pre_minutes integer, p_post_minutes integer)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case p_stage
    when 'pre_shift'  then p_submitted_at > p_shift_start + make_interval(mins => p_pre_minutes)
    when 'post_shift' then p_submitted_at > p_planned_end + make_interval(mins => p_post_minutes)
  end, false)
$$;
revoke all on function public.inspection_is_late(text, timestamptz, timestamptz, timestamptz, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------- idempotency helpers
create function public.inspection_replay(p_company uuid, p_actor uuid, p_csid uuid, p_function text, p_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.inspection_requests;
begin
  select * into r from public.inspection_requests
   where company_id = p_company and actor_id = p_actor and client_submission_id = p_csid;
  if not found then
    return null;
  end if;
  if r.function_name <> p_function or r.request_hash <> p_hash then
    perform public.inspection_fail('22023', 'client_submission_id was already used for a different request');
  end if;
  return r.inspection_id;
end $$;
create function public.inspection_record(p_company uuid, p_actor uuid, p_csid uuid, p_function text, p_hash text, p_inspection_id uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.inspection_requests (company_id, actor_id, client_submission_id, function_name, request_hash, inspection_id)
  values (p_company, p_actor, p_csid, p_function, p_hash, p_inspection_id)
  on conflict (company_id, actor_id, client_submission_id) do nothing
$$;
revoke all on function public.inspection_replay(uuid, uuid, uuid, text, text), public.inspection_record(uuid, uuid, uuid, text, text, uuid)
  from public, anon, authenticated;

-- the inspection (locked) for the person completing it: its driver, with inspection.submit for the branch
create function public.inspection_load_for_driver(p_inspection_id uuid) returns public.inspections
language plpgsql security definer set search_path = '' as $$
declare
  i public.inspections;
begin
  if auth.uid() is null or public.current_company_id() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into i from public.inspections x where x.id = p_inspection_id and x.company_id = public.current_company_id() for update;
  if not found then
    perform public.inspection_fail('P0002', 'that inspection was not found, or you cannot access it');
  end if;
  if i.submitted_by <> auth.uid() or not public.driver_is_self(i.driver_id)
     or not public.has_permission('inspection.submit', i.branch_id) then
    perform public.inspection_fail('42501', 'only the driver completing this inspection can change it');
  end if;
  return i;
end $$;
revoke all on function public.inspection_load_for_driver(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- begin_inspection
-- Pre-shift: the allocation's driver, allocation pre_inspection_pending. Post-shift: the allocation is in_use (it moves to
-- post_inspection_pending through transition_allocation: rule e, this path only) or already post_inspection_pending.
-- An existing non-void inspection for the allocation and stage is returned instead of a second one.
create function public.begin_inspection(
  p_allocation_id uuid, p_stage text, p_device_started_at timestamptz, p_captured_offline boolean, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_hash text;
  v_replay uuid;
  a public.vehicle_allocations;
  ex public.inspections;
  v_template uuid;
  v_id uuid;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  if p_stage is null or p_stage not in ('pre_shift', 'post_shift') then
    perform public.inspection_fail('22023', 'the inspection stage must be pre_shift or post_shift');
  end if;
  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company for update;
  if not found then
    perform public.inspection_fail('P0002', 'that allocation was not found, or you cannot access it');
  end if;
  if not public.driver_is_self(a.driver_id) or not public.has_permission('inspection.submit', a.branch_id) then
    perform public.inspection_fail('42501', 'only the allocation''s own driver can start its inspection');
  end if;

  v_hash := md5(a.id::text || '|' || p_stage);
  v_replay := public.inspection_replay(v_company, v_uid, p_client_submission_id, 'begin', v_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  -- one live inspection per allocation and stage: return it (also after it was submitted, so a late retry still succeeds)
  select * into ex from public.inspections x where x.allocation_id = a.id and x.inspection_stage = p_stage and x.status <> 'void';
  if found then
    perform public.inspection_record(v_company, v_uid, p_client_submission_id, 'begin', v_hash, ex.id);
    return ex.id;
  end if;

  if p_stage = 'pre_shift' then
    if a.status <> 'pre_inspection_pending' then
      perform public.inspection_fail('55000', format('the pre-shift inspection can only be started once the allocation has been started; this allocation is %s', replace(a.status, '_', ' ')));
    end if;
  elsif a.status not in ('in_use', 'post_inspection_pending') then
    perform public.inspection_fail('55000', format('the post-shift inspection can only be started while the vehicle is in use; this allocation is %s', replace(a.status, '_', ' ')));
  end if;

  v_template := public.inspection_template_for(a.vehicle_id);
  if v_template is null then
    perform public.inspection_fail('55000', 'there is no active inspection checklist for this vehicle; ask your administrator');
  end if;

  if p_stage = 'post_shift' and a.status = 'in_use' then
    -- rule e (033 refuses it for everyone else): only through this function, only for this allocation
    perform set_config('app.inspection_transition', a.id::text || ':post_inspection_pending', true);
    perform public.transition_allocation(a.id, 'post_inspection_pending', null, md5(p_client_submission_id::text || ':post_inspection_pending')::uuid);
    perform set_config('app.inspection_transition', '', true);
  end if;

  update public.inspection_templates set first_used_at = now() where id = v_template and first_used_at is null;

  insert into public.inspections (company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, template_id, inspection_stage,
                                  device_started_at, captured_offline, submitted_by, client_submission_id)
  values (a.company_id, a.branch_id, a.vehicle_id, a.driver_id, a.shift_id, a.id, v_template, p_stage,
          p_device_started_at, coalesce(p_captured_offline, false), v_uid, p_client_submission_id)
  returning id into v_id;
  perform public.inspection_record(v_company, v_uid, p_client_submission_id, 'begin', v_hash, v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- save_inspection_responses
-- p_responses: [{"template_item_id": uuid, "value": text, "comment": text?, "device_answered_at": timestamptz?}, ...]
-- Upserts while the inspection is a draft; every value is validated per response type (the row trigger is the one place).
create function public.save_inspection_responses(
  p_inspection_id uuid, p_responses jsonb, p_vehicle_confirmed boolean, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  i public.inspections;
  e jsonb;
  v_hash text;
  v_item uuid;
  v_device timestamptz;
begin
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  i := public.inspection_load_for_driver(p_inspection_id);
  v_hash := md5(p_inspection_id::text || '|' || coalesce(p_responses::text, '') || '|' || coalesce(p_vehicle_confirmed::text, ''));
  if public.inspection_replay(i.company_id, v_uid, p_client_submission_id, 'save_responses', v_hash) is not null then
    return i.id;
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is %s: its answers can no longer be changed', i.status));
  end if;
  if p_responses is null or jsonb_typeof(p_responses) <> 'array' or jsonb_array_length(p_responses) > 100 then
    perform public.inspection_fail('22023', 'the answers must be a list of at most 100 items');
  end if;

  for e in select * from jsonb_array_elements(p_responses) loop
    if jsonb_typeof(e) <> 'object' then
      perform public.inspection_fail('22023', 'each answer must be an object');
    end if;
    begin
      v_item := (e ->> 'template_item_id')::uuid;
      v_device := (e ->> 'device_answered_at')::timestamptz;
    exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
      perform public.inspection_fail('22023', 'an answer has an invalid question id or time');
    end;
    if v_item is null or (e ->> 'value') is null then
      perform public.inspection_fail('22023', 'each answer needs a question and a value');
    end if;
    insert into public.inspection_responses (company_id, inspection_id, template_item_id, response_value, comment, device_answered_at)
    values (i.company_id, i.id, v_item, e ->> 'value', e ->> 'comment', v_device)
    on conflict (inspection_id, template_item_id)
    do update set response_value = excluded.response_value, comment = excluded.comment, device_answered_at = excluded.device_answered_at;
  end loop;

  if p_vehicle_confirmed is not null and p_vehicle_confirmed is distinct from i.vehicle_confirmed then
    update public.inspections set vehicle_confirmed = p_vehicle_confirmed where id = i.id;
  end if;
  perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'save_responses', v_hash, i.id);
  return i.id;
end $$;

-- ---------------------------------------------------------------- photos (rules: 038 inspection_check_evidence, DEC-04)
-- A retake marks the previous odometer photo not current and keeps it; the new row links back to it.
create function public.attach_odometer_photo(p_inspection_id uuid, p_evidence_file_id uuid, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  i public.inspections;
  cur public.odometer_evidence;
  v_hash text;
  v_id uuid;
begin
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  i := public.inspection_load_for_driver(p_inspection_id);
  v_hash := md5(p_inspection_id::text || '|' || coalesce(p_evidence_file_id::text, ''));
  if public.inspection_replay(i.company_id, v_uid, p_client_submission_id, 'attach_odometer', v_hash) is not null then
    select o.id into v_id from public.odometer_evidence o where o.inspection_id = i.id and o.evidence_file_id = p_evidence_file_id;
    return v_id;
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is %s: its photos can no longer be changed', i.status));
  end if;
  if p_evidence_file_id is null then
    perform public.inspection_fail('22023', 'the photo is required');
  end if;
  select * into cur from public.odometer_evidence o where o.inspection_id = i.id and o.is_current;
  if found and cur.evidence_file_id = p_evidence_file_id then
    perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'attach_odometer', v_hash, i.id);
    return cur.id;
  end if;
  if found then
    update public.odometer_evidence set is_current = false where id = cur.id;
  end if;
  insert into public.odometer_evidence (company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, inspection_id, inspection_stage,
                                        evidence_file_id, retake_of_id)
  values (i.company_id, i.branch_id, i.vehicle_id, i.driver_id, i.shift_id, i.allocation_id, i.id, i.inspection_stage,
          p_evidence_file_id, case when cur.id is not null then cur.id end)
  returning id into v_id;
  perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'attach_odometer', v_hash, i.id);
  return v_id;
end $$;

create function public.attach_inspection_photo(
  p_inspection_id uuid, p_evidence_file_id uuid, p_category text, p_template_item_id uuid, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  i public.inspections;
  v_hash text;
  v_id uuid;
begin
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  i := public.inspection_load_for_driver(p_inspection_id);
  v_hash := md5(p_inspection_id::text || '|' || coalesce(p_evidence_file_id::text, '') || '|' || coalesce(p_category, '') || '|' || coalesce(p_template_item_id::text, ''));
  if public.inspection_replay(i.company_id, v_uid, p_client_submission_id, 'attach_photo', v_hash) is not null then
    select p.id into v_id from public.inspection_photos p where p.inspection_id = i.id and p.evidence_file_id = p_evidence_file_id;
    return v_id;
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is %s: its photos can no longer be changed', i.status));
  end if;
  if p_evidence_file_id is null or p_category is null or p_category not in ('condition', 'damage', 'other') then
    perform public.inspection_fail('22023', 'a photo and a category (condition, damage or other) are required');
  end if;
  insert into public.inspection_photos (company_id, branch_id, inspection_id, vehicle_id, evidence_file_id, photo_category, template_item_id)
  values (i.company_id, i.branch_id, i.id, i.vehicle_id, p_evidence_file_id, p_category, p_template_item_id)
  returning id into v_id;
  perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'attach_photo', v_hash, i.id);
  return v_id;
end $$;

-- ---------------------------------------------------------------- submit_inspection
-- Complete checks first, in this order; the first failure is the refusal (clear message, stable SQLSTATE). Late and safety
-- defects never block. Pre-shift submit moves the allocation pre_inspection_pending -> in_use (rule d, this path only) and
-- sets started_at = submitted_at. Post-shift submit leaves the allocation post_inspection_pending (closure is Phase 5).
create function public.submit_inspection(
  p_inspection_id uuid, p_device_submitted_at timestamptz, p_captured_offline boolean, p_client_submission_id uuid)
returns table (out_inspection_id uuid, out_status text, out_late_flag boolean, out_safety_defect_flag boolean, out_replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  i public.inspections;
  a public.vehicle_allocations;
  st record;
  v_shift_start timestamptz;
  v_late boolean;
  v_safety boolean;
  v_text text;
  v_n integer;
  v_reg text;
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
  select s.scheduled_start_at into v_shift_start from public.shifts s where s.id = i.shift_id;
  v_late := public.inspection_is_late(i.inspection_stage, now(), v_shift_start, a.planned_end_at, st.pre_shift_late_minutes, st.post_shift_late_minutes);
  v_safety := exists (select 1 from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
                       where r.inspection_id = i.id and r.response_value = 'defect' and it.severity_rule = 'safety_critical');

  update public.inspections
     set status = 'submitted', submitted_at = now(), device_submitted_at = p_device_submitted_at,
         captured_offline = captured_offline or coalesce(p_captured_offline, false),
         late_flag = v_late, safety_defect_flag = v_safety
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

-- ---------------------------------------------------------------- void_inspection (allocation.manage; DEC-24)
-- Nobody voids their own work: not the person who completed it. A voided pre-shift inspection does NOT move the allocation
-- back (Phase 5 decides corrections). Nothing is deleted: the inspection and every row under it stay.
create function public.void_inspection(p_inspection_id uuid, p_reason text, p_client_submission_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := nullif(btrim(p_reason), '');
  v_hash text;
  i public.inspections;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  select * into i from public.inspections x where x.id = p_inspection_id and x.company_id = v_company for update;
  if not found then
    perform public.inspection_fail('P0002', 'that inspection was not found, or it is not in a branch you can access');
  end if;
  if not public.has_permission('allocation.manage', i.branch_id) then
    perform public.inspection_fail('42501', 'only a manager of this branch can void an inspection');
  end if;
  v_hash := md5(p_inspection_id::text || '|' || coalesce(v_reason, ''));
  if public.inspection_replay(v_company, v_uid, p_client_submission_id, 'void', v_hash) is not null then
    return i.id;
  end if;
  if i.submitted_by = v_uid then
    perform public.inspection_fail('42501', 'you cannot void an inspection you completed yourself; ask another manager');
  end if;
  if v_reason is null or length(v_reason) > 500 then
    perform public.inspection_fail('22023', 'a reason (1-500 characters) is required to void an inspection');
  end if;
  if i.status = 'void' then
    perform public.inspection_fail('55000', 'this inspection is already void');
  end if;
  perform set_config('app.audit_reason', v_reason, true);
  update public.inspections set status = 'void', voided_at = now(), void_reason = v_reason, voided_by = v_uid where id = i.id;
  perform set_config('app.audit_reason', '', true);
  perform public.inspection_record(v_company, v_uid, p_client_submission_id, 'void', v_hash, i.id);
  return i.id;
end $$;

-- ---------------------------------------------------------------- read: the driver's form
-- One jsonb document: the allocation's vehicle, the stage's template items with the current answers, the photo slots
-- (odometer, and one per Defect) and whether the odometer photo is present. Only the allocation's own driver can call it.
create function public.my_inspection(p_allocation_id uuid, p_stage text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
  a public.vehicle_allocations;
  i public.inspections;
  v_template uuid;
  v_items jsonb;
  v_slots jsonb;
  v_odo boolean := false;
  v_vehicle jsonb;
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_stage is null or p_stage not in ('pre_shift', 'post_shift') then
    perform public.inspection_fail('22023', 'the inspection stage must be pre_shift or post_shift');
  end if;
  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company;
  if not found or not public.driver_is_self(a.driver_id) then
    perform public.inspection_fail('P0002', 'that allocation was not found, or you cannot access it');
  end if;
  select * into i from public.inspections x where x.allocation_id = a.id and x.inspection_stage = p_stage and x.status <> 'void';
  v_template := coalesce(i.template_id, public.inspection_template_for(a.vehicle_id));
  select jsonb_build_object('fleet_number', v.fleet_number, 'registration', v.registration_number, 'make', v.make, 'model', v.model)
    into v_vehicle from public.vehicles v where v.id = a.vehicle_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'template_item_id', it.id, 'item_key', it.item_key, 'question', it.question, 'response_type', it.response_type,
           'required', it.required, 'severity_rule', it.severity_rule, 'sequence', it.sequence,
           'allow_na', coalesce((it.configuration ->> 'allow_na')::boolean, false),
           'answer', case when r.id is null then null else jsonb_build_object('value', r.response_value, 'comment', r.comment) end)
           order by it.sequence), '[]'::jsonb)
    into v_items
    from public.inspection_template_items it
    left join public.inspection_responses r on r.template_item_id = it.id and r.inspection_id = i.id
   where it.template_id = v_template and it.applies_to_stage in (p_stage, 'both');

  if i.id is not null then
    v_odo := exists (select 1 from public.odometer_evidence o where o.inspection_id = i.id and o.is_current);
  end if;
  select coalesce(jsonb_agg(s order by s ->> 'sequence'), '[]'::jsonb) into v_slots from (
    select jsonb_build_object('kind', 'odometer', 'template_item_id', null, 'required', true, 'filled', v_odo, 'sequence', '000') s
    union all
    select jsonb_build_object('kind', 'defect_photo', 'template_item_id', it.id, 'question', it.question, 'required', true,
             'filled', exists (select 1 from public.inspection_photos p where p.inspection_id = i.id and p.template_item_id = it.id),
             'sequence', lpad(it.sequence::text, 3, '0'))
      from public.inspection_responses r join public.inspection_template_items it on it.id = r.template_item_id
     where r.inspection_id = i.id and r.response_value = 'defect'
  ) q;

  return jsonb_build_object(
    'allocation_status', a.status, 'stage', p_stage, 'vehicle', v_vehicle,
    'inspection', case when i.id is null then null else jsonb_build_object(
        'id', i.id, 'status', i.status, 'vehicle_confirmed', i.vehicle_confirmed, 'late_flag', i.late_flag,
        'safety_defect_flag', i.safety_defect_flag, 'captured_offline', i.captured_offline,
        'started_at', i.started_at, 'submitted_at', i.submitted_at) end,
    'items', v_items, 'photo_slots', v_slots, 'odometer_photo_present', v_odo);
end $$;

-- ---------------------------------------------------------------- read: the supervisor's list
-- allocation.manage or reports.view for the inspection's branch (checked per row). No driver identity: DEC-37 keeps the
-- driver register away from maintenance administrators, who also hold reports.view.
create function public.list_inspections(p_from timestamptz, p_to timestamptz, p_branch_id uuid default null, p_limit integer default 200)
returns table (
  inspection_id uuid, allocation_id uuid, branch_id uuid, branch_name text, shift_date date, inspection_stage text, status text,
  vehicle_fleet_number text, vehicle_registration text, started_at timestamptz, submitted_at timestamptz,
  late_flag boolean, safety_defect_flag boolean, captured_offline boolean, completed_by_role text, allocation_status text)
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
         i.late_flag, i.safety_defect_flag, i.captured_offline, i.completed_by_role, a.status
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

-- ---------------------------------------------------------------- va_lifecycle_guard: started_at (rule d), nothing else opens
-- Replaces 032's guard (same trigger name). Only change: started_at may be set, once, by the transition to in_use (made inside
-- transition_allocation(), which sets the flag). released_at (Phase 5) and closed_by (Phase 5) stay closed.
create or replace function public.va_lifecycle_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_transition boolean := coalesce(current_setting('app.allocation_transition', true), '') = 'on';
  v_amend boolean := coalesce(current_setting('app.allocation_amend', true), '') = 'on';
begin
  if new.started_at is distinct from old.started_at then
    if not (v_transition and old.status = 'pre_inspection_pending' and new.status = 'in_use'
            and old.started_at is null and new.started_at is not null) then
      raise exception 'started_at is set once, when the pre-shift inspection is submitted (the move to in use)' using errcode = '55000';
    end if;
  end if;
  if new.released_at is distinct from old.released_at then
    raise exception 'released_at belongs to the closure flow, available from Phase 5' using errcode = '55000';
  end if;
  if new.closed_by is distinct from old.closed_by then
    raise exception 'closed_by belongs to the closure rules, available from Phase 5' using errcode = '55000';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('closed', 'cancelled', 'no_show') then
      raise exception 'a % allocation is final and its status cannot change', replace(old.status, '_', ' ') using errcode = '55000';
    end if;
    if not public.allocation_transition_allowed(old.status, new.status) then
      raise exception 'an allocation cannot move from % to %', old.status, new.status using errcode = '55000';
    end if;
    if not v_transition then
      raise exception 'allocation status changes only through transition_allocation()' using errcode = '55000';
    end if;
    if new.status = 'pre_inspection_pending' and new.opened_at is null then
      raise exception 'starting an allocation records who opened it (opened_at / opened_by)' using errcode = '55000';
    end if;
    if new.status = 'in_use' and new.started_at is null then
      raise exception 'moving to in use records when the shift started (started_at)' using errcode = '55000';
    end if;
  end if;

  if new.opened_at is distinct from old.opened_at or new.opened_by is distinct from old.opened_by
     or new.opened_on_behalf is distinct from old.opened_on_behalf then
    if old.opened_at is not null then
      raise exception 'who started the allocation is permanent and cannot be changed' using errcode = '23514';
    end if;
    if not v_transition or old.status <> 'planned' or new.status <> 'pre_inspection_pending' then
      raise exception 'opened_at / opened_by / opened_on_behalf are written only by the start transition' using errcode = '55000';
    end if;
  end if;

  if new.planned_start_at is distinct from old.planned_start_at or new.planned_end_at is distinct from old.planned_end_at then
    if not v_amend or old.status not in ('planned', 'pre_inspection_pending') or new.status <> old.status then
      raise exception 'planned times change only through amend_allocation_times(), while the allocation is planned or pre-inspection pending'
        using errcode = '55000';
    end if;
    if not exists (select 1 from public.shifts s
                    where s.id = new.shift_id and s.company_id = new.company_id
                      and new.planned_start_at >= s.scheduled_start_at and new.planned_end_at <= s.scheduled_end_at) then
      raise exception 'the planned times must lie within the shift''s scheduled window' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- transition_allocation: rules d and e (033 + this)
-- d. in_use: ONLY from submit_inspection() — the transaction-local flag names this allocation and the move, the caller is its
--    driver, and a submitted pre-shift inspection exists. started_at = that inspection's server submitted_at.
-- e. post_inspection_pending: ONLY from begin_inspection() for the post-shift stage, same flag and driver rule.
-- Every other caller and path keeps the 0A000 refusal of 033. Rule f (closing) is unchanged: Phase 5.
create or replace function public.transition_allocation(
  p_allocation_id uuid, p_to_status text, p_reason text, p_client_submission_id uuid)
returns table (out_allocation_id uuid, out_status text, out_replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := nullif(btrim(p_reason), '');
  v_now timestamptz := now();
  a public.vehicle_allocations;
  ev public.allocation_events;
  ins public.inspections;
  st record;
  v_manager boolean;
  v_driver boolean;
  v_on_behalf boolean := false;
  v_blockers text[];
  v_event_type text := 'status_changed';
  v_flag text := coalesce(current_setting('app.inspection_transition', true), '');
  v_extra jsonb := '{}'::jsonb;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.allocation_fail('22023', 'client_submission_id is required');
  end if;
  if p_to_status is null or p_to_status not in ('planned', 'pre_inspection_pending', 'in_use', 'post_inspection_pending',
                                                'closed', 'closed_with_exceptions', 'cancelled', 'no_show') then
    perform public.allocation_fail('22023', 'unknown allocation status');
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    perform public.allocation_fail('22023', 'the reason must be at most 500 characters');
  end if;

  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company for update;
  if not found then
    perform public.allocation_fail('P0002', 'that allocation was not found, or it is not in a branch you can access');
  end if;

  v_manager := public.has_permission('allocation.manage', a.branch_id);
  v_driver := public.driver_is_self(a.driver_id);
  if not (v_manager or v_driver) then
    perform public.allocation_fail('42501', 'you are not allowed to change this allocation: only its driver, or a manager of its branch, can');
  end if;

  select * into ev from public.allocation_events e
   where e.allocation_id = a.id and e.actor_id = v_uid and e.metadata ->> 'client_submission_id' = p_client_submission_id::text;
  if found then
    if ev.new_value ->> 'status' is distinct from p_to_status then
      perform public.allocation_fail('22023', 'client_submission_id was already used for a different request');
    end if;
    out_allocation_id := a.id;
    out_status := p_to_status;
    out_replayed := true;
    return next;
    return;
  end if;

  if not public.allocation_transition_allowed(a.status, p_to_status) then
    if a.status in ('closed', 'cancelled', 'no_show') then
      perform public.allocation_fail('55000', format('this allocation is %s and can no longer change status', replace(a.status, '_', ' ')));
    end if;
    perform public.allocation_fail('55000', format('an allocation that is %s cannot be moved to %s',
                                                    replace(a.status, '_', ' '), replace(p_to_status, '_', ' ')));
  end if;

  if p_to_status = 'pre_inspection_pending' then
    -- a. start (DEC-40): the allocation's own driver, or allocation.manage for the branch on the driver's behalf
    select * into st from public.allocation_settings(a.company_id);
    if v_driver then
      v_on_behalf := false;
    else
      if v_reason is null then
        perform public.allocation_fail('22023', 'a reason (1-500 characters) is required to start an allocation on the driver''s behalf');
      end if;
      v_on_behalf := true;
    end if;
    v_blockers := public.allocation_start_blockers(a.id, v_now);
    if cardinality(v_blockers) > 0 then
      if v_blockers[1] = 'too_early' then
        perform public.allocation_fail('55000', format('it is too early to start this allocation: it can be started from %s (%s minutes before the planned start)',
          to_char((a.planned_start_at - make_interval(mins => st.open_before_start_minutes)) at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'),
          st.open_before_start_minutes));
      elsif v_blockers[1] = 'window_closed' then
        perform public.allocation_fail('55000', 'the planned period of this allocation has ended, so it can no longer be started');
      end if;
      perform public.allocation_refusal(v_blockers);
    end if;
    perform set_config('app.audit_reason', coalesce(v_reason, 'allocation started'), true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations
       set status = 'pre_inspection_pending', opened_at = v_now, opened_by = v_uid, opened_on_behalf = v_on_behalf
     where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);

  elsif p_to_status = 'cancelled' then
    if not v_manager then
      perform public.allocation_fail('42501', 'only a manager of this branch can cancel an allocation');
    end if;
    if v_reason is null then
      perform public.allocation_fail('22023', 'a reason (1-500 characters) is required to cancel an allocation');
    end if;
    perform set_config('app.audit_reason', v_reason, true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations set status = 'cancelled' where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);
    v_event_type := 'cancelled';

  elsif p_to_status = 'no_show' then
    if not v_manager then
      perform public.allocation_fail('42501', 'only a manager of this branch can record a no-show');
    end if;
    if v_reason is null then
      perform public.allocation_fail('22023', 'a reason (1-500 characters) is required to record a no-show');
    end if;
    select * into st from public.allocation_settings(a.company_id);
    if not public.allocation_no_show_allowed(a.planned_start_at, v_now, st.no_show_grace_minutes) then
      perform public.allocation_fail('55000', format('a no-show can only be recorded from %s (%s minutes after the planned start)',
        to_char((a.planned_start_at + make_interval(mins => st.no_show_grace_minutes)) at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'),
        st.no_show_grace_minutes));
    end if;
    perform set_config('app.audit_reason', v_reason, true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations set status = 'no_show' where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);

  elsif p_to_status = 'in_use' then
    -- d. ONLY inside submit_inspection(): flag + the allocation's driver + a submitted pre-shift inspection
    select * into ins from public.inspections x
     where x.allocation_id = a.id and x.inspection_stage = 'pre_shift' and x.status = 'submitted';
    if v_flag <> a.id::text || ':in_use' or not v_driver or not found then
      perform public.allocation_fail('0A000', 'This step needs a submitted pre-shift inspection — available from Phase 4.');
    end if;
    perform set_config('app.audit_reason', 'pre-shift inspection submitted', true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations set status = 'in_use', started_at = ins.submitted_at where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);
    v_extra := jsonb_build_object('inspection_id', ins.id);

  elsif p_to_status = 'post_inspection_pending' then
    -- e. ONLY inside begin_inspection() for the post-shift stage: flag + the allocation's driver
    if v_flag <> a.id::text || ':post_inspection_pending' or not v_driver then
      perform public.allocation_fail('0A000', 'This step needs the post-shift inspection flow — available from Phase 4.');
    end if;
    perform set_config('app.audit_reason', 'post-shift inspection started', true);
    perform set_config('app.allocation_transition', 'on', true);
    update public.vehicle_allocations set status = 'post_inspection_pending' where id = a.id;
    perform set_config('app.allocation_transition', 'off', true);

  elsif p_to_status in ('closed', 'closed_with_exceptions') then
    -- f. not available yet: the closure decision lives behind allocation_closure_blockers() (Phase 5 fills it in)
    v_blockers := public.allocation_closure_blockers(a.id);
    perform public.allocation_fail('0A000', 'Closing an allocation needs the closure rules — available from Phase 5.', array_to_string(v_blockers, ','));
  else
    perform public.allocation_fail('55000', format('an allocation that is %s cannot be moved to %s',
                                                    replace(a.status, '_', ' '), replace(p_to_status, '_', ' ')));
  end if;
  perform set_config('app.audit_reason', '', true);

  insert into public.allocation_events (company_id, allocation_id, event_type, previous_value, new_value, reason, actor_id, metadata)
  values (a.company_id, a.id, v_event_type,
          jsonb_build_object('status', a.status), jsonb_build_object('status', p_to_status),
          v_reason, v_uid,
          jsonb_build_object('client_submission_id', p_client_submission_id)
            || case when p_to_status = 'pre_inspection_pending' then jsonb_build_object('on_behalf', v_on_behalf) else '{}'::jsonb end
            || v_extra);

  out_allocation_id := a.id;
  out_status := p_to_status;
  out_replayed := false;
  return next;
end $$;

-- ---------------------------------------------------------------- privileges: only what clients call
revoke all on function
  public.begin_inspection(uuid, text, timestamptz, boolean, uuid),
  public.save_inspection_responses(uuid, jsonb, boolean, uuid),
  public.attach_odometer_photo(uuid, uuid, uuid),
  public.attach_inspection_photo(uuid, uuid, text, uuid, uuid),
  public.submit_inspection(uuid, timestamptz, boolean, uuid),
  public.void_inspection(uuid, text, uuid),
  public.my_inspection(uuid, text),
  public.list_inspections(timestamptz, timestamptz, uuid, integer)
  from public, anon, authenticated;
grant execute on function
  public.begin_inspection(uuid, text, timestamptz, boolean, uuid),
  public.save_inspection_responses(uuid, jsonb, boolean, uuid),
  public.attach_odometer_photo(uuid, uuid, uuid),
  public.attach_inspection_photo(uuid, uuid, text, uuid, uuid),
  public.submit_inspection(uuid, timestamptz, boolean, uuid),
  public.void_inspection(uuid, text, uuid),
  public.my_inspection(uuid, text),
  public.list_inspections(timestamptz, timestamptz, uuid, integer)
  to authenticated;
