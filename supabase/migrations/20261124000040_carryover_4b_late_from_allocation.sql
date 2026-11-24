-- 040 — Slice 4B carry-over C1: DEC-17 as amended 2026-11-24 — lateness is measured from the ALLOCATION, not the shift.
-- Pre-shift: late after allocation.planned_start_at + pre_shift_late_minutes. Post-shift: late after allocation.planned_end_at +
-- post_shift_late_minutes (unchanged). Example: an allocation 10:00–14:00 inside a 06:00–18:00 shift is not late at 10:30 and is
-- late at 10:31 (before this fix it was judged from 06:00, so it was late all day).
-- Replaced (CREATE OR REPLACE, same signature, ACL unchanged): submit_inspection — the ONLY change is that it passes
-- a.planned_start_at to inspection_is_late() instead of the shift's scheduled_start_at. Nothing else in it is touched.
-- Comments corrected (no behaviour): allocation_settings, inspections.late_flag, inspection_is_late (its parameter is still named
-- p_shift_start; Postgres cannot rename a parameter in place, and the value passed is now the allocation's planned start).

-- ---------------------------------------------------------------- submit_inspection
-- Complete checks first, in this order; the first failure is the refusal (clear message, stable SQLSTATE). Late and safety
-- defects never block. Pre-shift submit moves the allocation pre_inspection_pending -> in_use (rule d, this path only) and
-- sets started_at = submitted_at. Post-shift submit leaves the allocation post_inspection_pending (closure is Phase 5).
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
  v_late := public.inspection_is_late(i.inspection_stage, now(), a.planned_start_at, a.planned_end_at, st.pre_shift_late_minutes, st.post_shift_late_minutes);
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

comment on function public.allocation_settings(uuid) is
  'DEC-40 start window (60) and no-show grace (30); DEC-17 (amended 2026-11-24) late windows, both measured from the ALLOCATION: pre-shift +30 min after planned_start_at, post-shift +60 min after planned_end_at. Configurable defaults; the one place.';
comment on column public.inspections.late_flag is
  'DEC-17 (amended 2026-11-24): submitted after the allocation''s planned_start_at + pre_shift_late_minutes (pre-shift) or its planned_end_at + post_shift_late_minutes (post-shift). Set even when captured_offline. Never blocks submission.';
comment on function public.inspection_is_late(text, timestamptz, timestamptz, timestamptz, integer, integer) is
  'DEC-17 (amended 2026-11-24). p_shift_start is the ALLOCATION''s planned_start_at (name kept: a parameter cannot be renamed in place). Pre-shift: p_submitted_at > start + p_pre_minutes; post-shift: p_submitted_at > p_planned_end + p_post_minutes (strict).';
