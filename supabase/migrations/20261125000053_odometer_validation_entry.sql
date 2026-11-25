-- 053 — Slice 5A (3/4): reading validation, the driver's entry, submit / void / my_inspection
-- (PRD v1.20 §5.8, §5.9; ARCH v1.19 §6.5, §7.1–§7.3; DB v1.15 §8; DEC-05 blind entry, DEC-06 / DEC-43 offline, DEC-12, DEC-13 / DEC-15 no default,
--  DEC-14, DEC-16, DEC-17, DEC-24, DEC-44).
-- Added (client, SECURITY DEFINER, authenticated only):
--   record_driver_reading(inspection, km, device time, captured offline, client_submission_id) -> reading id
-- Added (internal, no client grant):
--   odometer_evaluate_checks(jsonb)       the pure rule set (TypeScript mirror: odometer-mileage/domain/validation.ts, SAME test vectors)
--   odometer_validate(reading, reason)    gathers the inputs, evaluates, stores the result, raises / dismisses exceptions, records events
--   odometer_revalidate_later(reading)    re-runs validation for the vehicle's LATER readings that still await review
--   odometer_submit_reading(inspection)   validates and moves the reading to awaiting_review (called by submit_inspection)
--   odometer_auto_accept_allowed(reading) DEC-44: false today (no OCR); the auto-accept branch exists and is tested
--   odometer_accept / odometer_reject / odometer_resolve_exceptions / odometer_void_for_inspection / odometer_log_event
-- Replaced (CREATE OR REPLACE, same signatures, ACLs kept): submit_inspection (047 + IN015 + validation), void_inspection (039 + the reading),
--   my_inspection (048 + the driver's reading status, never a reviewer's name or a check)
-- Altered: a trigger on odometer_evidence re-links the reading when the driver retakes the photo (an event is recorded).
--
-- Stable refusals added: IN015 "Enter the odometer reading shown in your photo before you submit."
-- DEC-05: the driver is never shown an OCR value; no OCR column is ever returned by anything in this migration.

-- ---------------------------------------------------------------- the event log: ONE writer
create function public.odometer_log_event(
  p_reading public.odometer_readings, p_type text, p_previous jsonb, p_new jsonb, p_reason text, p_actor uuid, p_approval uuid, p_metadata jsonb)
returns void
language sql security definer set search_path = '' as $$
  insert into public.odometer_reading_events
    (company_id, branch_id, odometer_reading_id, event_type, previous_value, new_value, reason, actor_id, approval_id, metadata)
  values (p_reading.company_id, p_reading.branch_id, p_reading.id, p_type, p_previous, p_new, p_reason, p_actor, p_approval, coalesce(p_metadata, '{}'::jsonb))
$$;
revoke all on function public.odometer_log_event(public.odometer_readings, text, jsonb, jsonb, text, uuid, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- the rule set: pure, one place (DEC-12..DEC-17, PRD §5.8.8)
-- Input (all lifetime km = displayed + segment offset):
--   stage, driver_lifetime_km,
--   latest_accepted_lifetime_km  the vehicle's latest ACCEPTED reading strictly before this one by allocation chronology (null = none),
--   earlier_unaccepted_exists    an earlier reading of the vehicle still awaits review,
--   pre_reading                  post-shift only: the same allocation's pre-shift reading {lifetime_km, accepted} or null,
--   previous_post                pre-shift only: the previous allocation's post-shift reading {lifetime_km, accepted} or null (none),
--   max_km_per_allocation (null = not configured, DEC-15), unaccounted_tolerance_km (DEC-16),
--   duplicate_image, capture_source, late_flag.
-- Output: { checks: [{key, result, values, note}], failed: [keys], route: 'quick_check' | 'full' }.
-- result: pass | fail | not_configured | waiting. A check that is not_configured or waiting does NOT count as failed (DEC-44).
-- Nothing here ever attributes a distance to a driver.
create function public.odometer_evaluate_checks(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_stage text := p ->> 'stage';
  v_km integer := (p ->> 'driver_lifetime_km')::integer;
  v_latest integer := (p ->> 'latest_accepted_lifetime_km')::integer;
  v_earlier boolean := coalesce((p ->> 'earlier_unaccepted_exists')::boolean, false);
  v_max integer := (p ->> 'max_km_per_allocation')::integer;
  v_tol integer := coalesce((p ->> 'unaccounted_tolerance_km')::integer, 0);
  v_dup boolean := coalesce((p ->> 'duplicate_image')::boolean, false);
  v_source text := p ->> 'capture_source';
  v_late boolean := coalesce((p ->> 'late_flag')::boolean, false);
  v_pre jsonb := case when jsonb_typeof(p -> 'pre_reading') = 'object' then p -> 'pre_reading' end;
  v_prev jsonb := case when jsonb_typeof(p -> 'previous_post') = 'object' then p -> 'previous_post' end;
  v_checks jsonb := '[]'::jsonb;
  v_result text;
  v_values jsonb;
  v_note text;
  v_dist integer;
  v_basis text;
  v_failed text[];
begin
  -- decreasing_reading: lower than the latest accepted reading before it (equal passes). waiting only when there is NO accepted
  -- reading at all and an earlier one is still unaccepted.
  if v_latest is not null then
    v_result := case when v_km < v_latest then 'fail' else 'pass' end;
    v_values := jsonb_build_object('driver_lifetime_km', v_km, 'previous_accepted_lifetime_km', v_latest);
    v_note := case when v_km < v_latest then 'The reading is lower than the latest accepted reading before it.' else 'Not lower than the latest accepted reading before it.' end;
  elsif v_earlier then
    v_result := 'waiting'; v_values := jsonb_build_object('driver_lifetime_km', v_km);
    v_note := 'An earlier reading of this vehicle is still waiting to be accepted; there is nothing accepted to compare with yet.';
  else
    v_result := 'pass'; v_values := jsonb_build_object('driver_lifetime_km', v_km);
    v_note := 'No earlier reading of this vehicle to compare with.';
  end if;
  v_checks := v_checks || jsonb_build_array(jsonb_build_object('key', 'decreasing_reading', 'result', v_result, 'values', v_values, 'note', v_note));

  -- implausible_distance (post-shift only): post minus pre of the same allocation; the pre reading's accepted value, else its driver value
  if v_stage = 'post_shift' then
    if v_max is null then
      v_result := 'not_configured'; v_values := jsonb_build_object('max_km_per_allocation', null);
      v_note := 'The largest plausible distance per allocation is not configured, so this check cannot run.';
    elsif v_pre is null then
      v_result := 'waiting'; v_values := jsonb_build_object('max_km_per_allocation', v_max);
      v_note := 'There is no pre-shift reading for this allocation to compare with.';
    else
      v_dist := v_km - (v_pre ->> 'lifetime_km')::integer;
      v_basis := case when coalesce((v_pre ->> 'accepted')::boolean, false) then 'accepted' else 'driver' end;
      v_result := case when v_dist > v_max then 'fail' else 'pass' end;
      v_values := jsonb_build_object('distance_km', v_dist, 'pre_lifetime_km', (v_pre ->> 'lifetime_km')::integer, 'pre_basis', v_basis, 'max_km_per_allocation', v_max);
      v_note := case when v_dist > v_max then 'The distance between the pre-shift and post-shift readings is larger than the configured maximum.'
                     else 'The distance between the pre-shift and post-shift readings is within the configured maximum.' end
                || ' The pre-shift value used is the ' || case v_basis when 'accepted' then 'accepted reading.' else 'typed reading (not yet accepted).' end;
    end if;
    v_checks := v_checks || jsonb_build_array(jsonb_build_object('key', 'implausible_distance', 'result', v_result, 'values', v_values, 'note', v_note));
  end if;

  -- unaccounted_distance (pre-shift only): this reading minus the previous allocation's accepted post-shift reading
  if v_stage = 'pre_shift' then
    if v_prev is null then
      v_result := 'pass'; v_values := '{}'::jsonb; v_note := 'There is no previous allocation reading to compare with.';
    elsif not coalesce((v_prev ->> 'accepted')::boolean, false) then
      v_result := 'waiting'; v_values := jsonb_build_object('tolerance_km', v_tol);
      v_note := 'The previous allocation''s post-shift reading is not accepted yet.';
    else
      v_dist := v_km - (v_prev ->> 'lifetime_km')::integer;
      v_result := case when v_dist > v_tol then 'fail' else 'pass' end;
      v_values := jsonb_build_object('gap_km', v_dist, 'previous_post_lifetime_km', (v_prev ->> 'lifetime_km')::integer, 'tolerance_km', v_tol);
      v_note := case when v_dist > v_tol then 'Kilometres were recorded between the previous allocation''s post-shift reading and this pre-shift reading.'
                     else 'Within the allowed gap since the previous allocation''s post-shift reading.' end;
    end if;
    v_checks := v_checks || jsonb_build_array(jsonb_build_object('key', 'unaccounted_distance', 'result', v_result, 'values', v_values, 'note', v_note));
  end if;

  v_checks := v_checks || jsonb_build_array(
    jsonb_build_object('key', 'duplicate_image', 'result', case when v_dup then 'fail' else 'pass' end, 'values', '{}'::jsonb,
                       'note', case when v_dup then 'The same photo file was already used for another odometer photo.' else 'The photo file is not used elsewhere.' end),
    -- DEC-04: the camera is the only way in, so this cannot fail today; it records the capture source
    jsonb_build_object('key', 'gallery_upload', 'result', case when coalesce(v_source, '') <> 'in_app_camera' then 'fail' else 'pass' end,
                       'values', jsonb_build_object('capture_source', v_source),
                       'note', case when coalesce(v_source, '') <> 'in_app_camera' then 'The photo did not come from the in-app camera.' else 'The photo was taken with the in-app camera.' end),
    jsonb_build_object('key', 'late_inspection', 'result', case when v_late then 'fail' else 'pass' end, 'values', '{}'::jsonb,
                       'note', case when v_late then 'The inspection was submitted after the late window.' else 'The inspection was submitted on time.' end));

  select coalesce(array_agg(c ->> 'key'), '{}') into v_failed from jsonb_array_elements(v_checks) c where c ->> 'result' = 'fail';
  return jsonb_build_object('checks', v_checks, 'failed', to_jsonb(v_failed),
                            'route', case when cardinality(v_failed) > 0 then 'full' else 'quick_check' end);
end $$;
revoke all on function public.odometer_evaluate_checks(jsonb) from public, anon, authenticated;

-- severity per check (DB §8 exception types): decreasing / duplicate high, unaccounted / implausible medium, late and gallery low
create function public.odometer_check_severity(p_key text) returns text
language sql immutable set search_path = '' as $$
  select case p_key when 'decreasing_reading' then 'high' when 'duplicate_image' then 'high'
                    when 'unaccounted_distance' then 'medium' when 'implausible_distance' then 'medium' else 'low' end
$$;
revoke all on function public.odometer_check_severity(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- validation: gather, evaluate, store
create function public.odometer_validate(p_reading_id uuid, p_trigger text default 'submit') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.odometer_readings;
  a public.vehicle_allocations;
  i public.inspections;
  s public.odometer_validation_settings;
  f public.evidence_files;
  v_in jsonb;
  v_res jsonb;
  v_old jsonb;
  v_km integer;
  v_latest integer;
  v_earlier boolean;
  v_pre jsonb;
  v_prev jsonb;
  v_dup boolean;
  v_route text;
  v_changed boolean;
  c jsonb;
  v_key text;
  v_ex public.odometer_exceptions;
begin
  select * into r from public.odometer_readings where id = p_reading_id for update;
  select * into a from public.vehicle_allocations where id = r.allocation_id;
  select * into i from public.inspections where id = r.inspection_id;
  s := public.validation_settings_for(r.vehicle_id);
  select ef.* into f from public.odometer_evidence oe join public.evidence_files ef on ef.id = oe.evidence_file_id where oe.id = r.odometer_evidence_id;
  v_km := public.odometer_lifetime_km(r.segment_id, r.driver_reading_km);

  -- the latest accepted reading strictly before this one by allocation chronology (allocation start, then pre before post)
  select x.accepted_lifetime_km into v_latest
    from public.odometer_readings x join public.vehicle_allocations xa on xa.id = x.allocation_id
   where x.vehicle_id = r.vehicle_id and x.reading_status = 'accepted' and x.id <> r.id
     and (xa.planned_start_at, public.odometer_stage_rank(x.inspection_stage)) < (a.planned_start_at, public.odometer_stage_rank(r.inspection_stage))
   order by xa.planned_start_at desc, public.odometer_stage_rank(x.inspection_stage) desc
   limit 1;
  select exists (select 1 from public.odometer_readings x join public.vehicle_allocations xa on xa.id = x.allocation_id
                  where x.vehicle_id = r.vehicle_id and x.reading_status = 'awaiting_review' and x.id <> r.id
                    and (xa.planned_start_at, public.odometer_stage_rank(x.inspection_stage)) < (a.planned_start_at, public.odometer_stage_rank(r.inspection_stage)))
    into v_earlier;

  if r.inspection_stage = 'post_shift' then
    select jsonb_build_object('lifetime_km', case when x.reading_status = 'accepted' then x.accepted_lifetime_km
                                                  else public.odometer_lifetime_km(x.segment_id, x.driver_reading_km) end,
                              'accepted', x.reading_status = 'accepted')
      into v_pre
      from public.odometer_readings x
     where x.allocation_id = r.allocation_id and x.inspection_stage = 'pre_shift' and x.reading_status in ('awaiting_review', 'accepted');
  else
    select jsonb_build_object('lifetime_km', x.accepted_lifetime_km, 'accepted', x.reading_status = 'accepted')
      into v_prev
      from public.odometer_readings x join public.vehicle_allocations xa on xa.id = x.allocation_id
     where x.vehicle_id = r.vehicle_id and x.inspection_stage = 'post_shift' and x.reading_status in ('awaiting_review', 'accepted')
       and xa.planned_start_at < a.planned_start_at
     order by xa.planned_start_at desc
     limit 1;
  end if;

  select exists (select 1 from public.odometer_evidence oe2 join public.evidence_files ef2 on ef2.id = oe2.evidence_file_id
                  where oe2.company_id = r.company_id and oe2.inspection_id <> r.inspection_id and ef2.sha256 = f.sha256)
    into v_dup;

  v_in := jsonb_build_object(
    'stage', r.inspection_stage, 'driver_lifetime_km', v_km, 'latest_accepted_lifetime_km', v_latest, 'earlier_unaccepted_exists', v_earlier,
    'pre_reading', v_pre, 'previous_post', v_prev, 'max_km_per_allocation', s.max_km_per_allocation,
    'unaccounted_tolerance_km', s.unaccounted_tolerance_km, 'duplicate_image', v_dup, 'capture_source', f.capture_source, 'late_flag', i.late_flag);
  v_res := public.odometer_evaluate_checks(v_in);
  v_route := case when v_res ->> 'route' = 'full' or r.full_review_requested_by is not null then 'full' else 'quick_check' end;
  v_old := r.validation;
  v_changed := v_old is null or (v_old -> 'checks') is distinct from (v_res -> 'checks') or r.review_kind is distinct from v_route;

  v_res := v_res || jsonb_build_object('settings', jsonb_build_object('id', s.id, 'version', s.version),
                                       'route', v_route, 'inputs_for', v_in - 'stage');
  if v_changed then
    update public.odometer_readings
       set validation = v_res, validated_at = clock_timestamp(), validation_settings_id = s.id, validation_settings_version = s.version,
           review_kind = v_route,
           exception_summary = (select nullif(string_agg(e ->> 'note', ' '), '') from jsonb_array_elements(v_res -> 'checks') e where e ->> 'result' = 'fail')
     where id = r.id;
    perform public.odometer_log_event(r, 'validated',
      case when v_old is null then null else jsonb_build_object('route', r.review_kind, 'results', (select jsonb_object_agg(e ->> 'key', e ->> 'result') from jsonb_array_elements(v_old -> 'checks') e)) end,
      jsonb_build_object('route', v_route, 'results', (select jsonb_object_agg(e ->> 'key', e ->> 'result') from jsonb_array_elements(v_res -> 'checks') e),
                         'settings_id', s.id, 'settings_version', s.version),
      null, null, null,
      jsonb_build_object('trigger', p_trigger, 'route_from', r.review_kind, 'route_to', v_route));
  end if;

  -- exceptions follow the failed checks: one open exception per failed check; one that no longer fails is dismissed
  perform set_config('app.odometer_review', 'on', true);
  for c in select * from jsonb_array_elements(v_res -> 'checks') loop
    v_key := c ->> 'key';
    if c ->> 'result' = 'fail' then
      if not exists (select 1 from public.odometer_exceptions e where e.odometer_reading_id = r.id and e.exception_type = v_key and e.status in ('open', 'in_review')) then
        insert into public.odometer_exceptions
          (company_id, branch_id, vehicle_id, driver_id, allocation_id, odometer_reading_id, inspection_id, exception_type, description, severity)
        values (r.company_id, r.branch_id, r.vehicle_id, r.driver_id, r.allocation_id, r.id, r.inspection_id, v_key, c ->> 'note', public.odometer_check_severity(v_key))
        returning * into v_ex;
        perform public.odometer_log_event(r, 'exception_created', null, jsonb_build_object('exception_id', v_ex.id, 'type', v_key, 'severity', v_ex.severity),
                                          null, null, null, jsonb_build_object('trigger', p_trigger));
      end if;
    else
      update public.odometer_exceptions e
         set status = 'dismissed', resolved_at = clock_timestamp(), resolution_summary = 'No longer applies after re-validation.'
       where e.odometer_reading_id = r.id and e.exception_type = v_key and e.status in ('open', 'in_review');
    end if;
  end loop;
  perform set_config('app.odometer_review', '', true);
  return jsonb_build_object('changed', v_changed, 'route', v_route);
end $$;
revoke all on function public.odometer_validate(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- re-validation of LATER readings (never an accepted one)
create function public.odometer_revalidate_later(p_reading_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.odometer_readings;
  a public.vehicle_allocations;
  x record;
begin
  select * into r from public.odometer_readings where id = p_reading_id;
  select * into a from public.vehicle_allocations where id = r.allocation_id;
  for x in
    select y.id from public.odometer_readings y join public.vehicle_allocations ya on ya.id = y.allocation_id
     where y.vehicle_id = r.vehicle_id and y.reading_status = 'awaiting_review' and y.id <> r.id
       and (ya.planned_start_at, public.odometer_stage_rank(y.inspection_stage)) > (a.planned_start_at, public.odometer_stage_rank(r.inspection_stage))
     order by ya.planned_start_at, public.odometer_stage_rank(y.inspection_stage)
  loop
    perform public.odometer_validate(x.id, 'revalidation');
  end loop;
end $$;
revoke all on function public.odometer_revalidate_later(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- DEC-44: automatic acceptance does not exist before OCR is live
-- No reading is accepted automatically while there is no OCR result or ocr_min_confidence is null (DEC-13). OCR is Phase 6, so this is false
-- for every reading today (odr_ocr_not_yet keeps the OCR columns empty). Phase 6 replaces this body with the in-app + confidence + tolerance
-- + all-checks-pass rule; the branch that uses it is already in odometer_submit_reading and is covered by a test.
create function public.odometer_auto_accept_allowed(p_reading_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select false
$$;
revoke all on function public.odometer_auto_accept_allowed(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- acceptance / rejection helpers (shared by 054 and the auto branch)
create function public.odometer_resolve_exceptions(p_reading_id uuid, p_status text, p_summary text, p_approval_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform set_config('app.odometer_review', 'on', true);
  update public.odometer_exceptions e
     set status = p_status, resolved_at = clock_timestamp(), resolution_summary = left(p_summary, 1000), approval_id = p_approval_id
   where e.odometer_reading_id = p_reading_id and e.status in ('open', 'in_review');
  get diagnostics n = row_count;
  perform set_config('app.odometer_review', '', true);
  return n;
end $$;
revoke all on function public.odometer_resolve_exceptions(uuid, text, text, uuid) from public, anon, authenticated;

-- accept: the reading must be awaiting review. p_method = reviewer | auto_rule. The driver's value is never touched.
create function public.odometer_accept(
  p_reading_id uuid, p_method text, p_review_kind text, p_accepted_km integer, p_actor uuid, p_approval_id uuid, p_reason text, p_metadata jsonb default '{}')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.odometer_readings;
  v_lifetime integer;
  v_latest uuid;
begin
  select * into r from public.odometer_readings where id = p_reading_id for update;
  if r.reading_status <> 'awaiting_review' then
    perform public.odometer_fail_code('OD003');
  end if;
  v_lifetime := public.odometer_lifetime_km(r.segment_id, p_accepted_km);
  begin
    update public.odometer_readings
       set reading_status = 'accepted', review_status = case when p_method = 'auto_rule' then 'not_required' else 'approved' end,
           acceptance_method = p_method, review_kind = coalesce(p_review_kind, r.review_kind),
           accepted_reading_km = p_accepted_km, accepted_lifetime_km = v_lifetime, accepted_at = clock_timestamp(),
           accepted_by = p_actor, reviewed_by = p_actor, reviewed_at = clock_timestamp(), approval_id = p_approval_id
     where id = r.id
     returning * into r;
  exception when unique_violation then
    perform public.odometer_fail_code('OD011');
  end;
  perform public.odometer_log_event(r, 'accepted',
    jsonb_build_object('driver_reading_km', r.driver_reading_km), jsonb_build_object('accepted_reading_km', p_accepted_km, 'accepted_lifetime_km', v_lifetime),
    p_reason, p_actor, p_approval_id,
    jsonb_build_object('method', p_method, 'review_kind', r.review_kind, 'different_value', p_accepted_km is distinct from r.driver_reading_km) || coalesce(p_metadata, '{}'));
  -- the vehicle's cache follows allocation chronology (never the highest value or the device time)
  select x.id into v_latest
    from public.odometer_readings x join public.vehicle_allocations xa on xa.id = x.allocation_id
   where x.vehicle_id = r.vehicle_id and x.reading_status = 'accepted'
   order by xa.planned_start_at desc, public.odometer_stage_rank(x.inspection_stage) desc
   limit 1;
  if v_latest = r.id then
    update public.vehicles set current_odometer_km = p_accepted_km, current_odometer_reading_id = r.id where id = r.vehicle_id;
  end if;
  perform public.odometer_revalidate_later(r.id);
end $$;
revoke all on function public.odometer_accept(uuid, text, text, integer, uuid, uuid, text, jsonb) from public, anon, authenticated;

-- reject (a reviewer's decision, or the voiding of its inspection). p_reviewer = null for a system rejection (void).
create function public.odometer_reject(p_reading_id uuid, p_reviewer uuid, p_actor uuid, p_approval_id uuid, p_reason text, p_metadata jsonb default '{}')
returns void
language plpgsql security definer set search_path = '' as $$
declare r public.odometer_readings;
begin
  select * into r from public.odometer_readings where id = p_reading_id for update;
  if r.reading_status not in ('submitted', 'awaiting_review') then
    perform public.odometer_fail_code('OD003');
  end if;
  update public.odometer_readings
     set reading_status = 'rejected', review_status = 'rejected', reviewed_by = p_reviewer,
         reviewed_at = case when p_reviewer is null then null else clock_timestamp() end, approval_id = p_approval_id
   where id = r.id returning * into r;
  perform public.odometer_log_event(r, 'rejected', jsonb_build_object('driver_reading_km', r.driver_reading_km), null, p_reason, p_actor, p_approval_id,
                                    coalesce(p_metadata, '{}'));
  perform public.odometer_revalidate_later(r.id);
end $$;
revoke all on function public.odometer_reject(uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- submit: validate and send to review (called by submit_inspection)
create function public.odometer_submit_reading(p_inspection_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.odometer_readings;
  v_route text;
begin
  select * into r from public.odometer_readings where inspection_id = p_inspection_id and reading_status = 'submitted' for update;
  if not found then
    return;
  end if;
  v_route := public.odometer_validate(r.id, 'submit') ->> 'route';
  if public.odometer_auto_accept_allowed(r.id) then
    -- DEC-44: unreachable until OCR is live (the function is false today). The reading is accepted by the rule, with no reviewer.
    update public.odometer_readings set reading_status = 'awaiting_review', review_status = 'pending' where id = r.id;
    perform public.odometer_accept(r.id, 'auto_rule', null, r.driver_reading_km, null, null, null, jsonb_build_object('auto', true));
  else
    update public.odometer_readings set reading_status = 'awaiting_review', review_status = 'pending', review_kind = v_route where id = r.id;
  end if;
end $$;
revoke all on function public.odometer_submit_reading(uuid) from public, anon, authenticated;

-- a voided inspection's reading that is not accepted is rejected with the void reason (an accepted one stays: 5B replaces it)
create function public.odometer_void_for_inspection(p_inspection_id uuid, p_reason text, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.odometer_readings;
begin
  select * into r from public.odometer_readings where inspection_id = p_inspection_id and reading_status in ('submitted', 'awaiting_review') for update;
  if not found then
    return;
  end if;
  perform public.odometer_resolve_exceptions(r.id, 'dismissed', 'The inspection was voided: ' || p_reason, null);
  perform public.odometer_reject(r.id, null, p_actor, null, 'The inspection was voided: ' || p_reason, jsonb_build_object('voided_inspection', true));
end $$;
revoke all on function public.odometer_void_for_inspection(uuid, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- the driver's entry (blind, DEC-05)
create function public.record_driver_reading(
  p_inspection_id uuid, p_reading_km integer, p_device_time timestamptz, p_captured_offline boolean, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_hash text;
  i public.inspections;
  oe public.odometer_evidence;
  r public.odometer_readings;
  v_profile uuid;
  v_segment uuid;
  v_id uuid;
  v_before integer;
begin
  if p_client_submission_id is null then
    perform public.inspection_fail('22023', 'client_submission_id is required');
  end if;
  i := public.inspection_load_for_driver(p_inspection_id);          -- the ONE completer check (driver, or the on-behalf supervisor)
  v_hash := md5(p_inspection_id::text || '|' || coalesce(p_reading_km::text, ''));
  if public.inspection_replay(i.company_id, v_uid, p_client_submission_id, 'record_reading', v_hash) is not null then
    select x.id into v_id from public.odometer_readings x where x.inspection_id = i.id and x.reading_status in ('submitted', 'awaiting_review', 'accepted', 'rejected')
      order by x.created_at desc limit 1;
    return v_id;
  end if;
  if i.status <> 'draft' then
    perform public.inspection_fail('55000', format('this inspection is %s: the reading can no longer be changed', i.status));
  end if;
  if p_reading_km is null or p_reading_km < 0 or p_reading_km > 9999999 then
    perform public.inspection_fail('22023', 'Enter the reading as whole kilometres, using digits only (0 to 9,999,999).');
  end if;
  select * into oe from public.odometer_evidence o where o.inspection_id = i.id and o.is_current;
  if not found then
    perform public.inspection_fail('IN006', 'Take the odometer photo first, then enter the reading shown in it.');
  end if;

  select * into r from public.odometer_readings x where x.inspection_id = i.id and x.reading_status = 'submitted' for update;
  if found then
    if r.driver_reading_km is distinct from p_reading_km then
      v_before := r.driver_reading_km;
      update public.odometer_readings
         set driver_reading_km = p_reading_km, device_entered_at = p_device_time, captured_offline = coalesce(p_captured_offline, false)
       where id = r.id returning * into r;
      perform public.odometer_log_event(r, 'value_changed', jsonb_build_object('driver_reading_km', v_before),
                                        jsonb_build_object('driver_reading_km', p_reading_km), null, v_uid, null, jsonb_build_object('captured_offline', coalesce(p_captured_offline, false)));
    end if;
    v_id := r.id;
  else
    select d.profile_id into v_profile from public.drivers d where d.id = i.driver_id and d.company_id = i.company_id;
    select s.id into v_segment from public.odometer_segments s where s.vehicle_id = i.vehicle_id and s.ends_at is null;
    insert into public.odometer_readings
      (company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, inspection_id, inspection_stage, odometer_evidence_id, segment_id,
       driver_reading_km, entered_by, driver_profile_id, device_entered_at, captured_offline, client_submission_id)
    values (i.company_id, i.branch_id, i.vehicle_id, i.driver_id, i.shift_id, i.allocation_id, i.id, i.inspection_stage, oe.id, v_segment,
            p_reading_km, i.submitted_by, v_profile, p_device_time, coalesce(p_captured_offline, false), p_client_submission_id)
    returning * into r;
    perform public.odometer_log_event(r, 'submitted', null, jsonb_build_object('driver_reading_km', p_reading_km), null, v_uid, null,
                                      jsonb_build_object('captured_offline', coalesce(p_captured_offline, false), 'completed_by_role', i.completed_by_role));
    v_id := r.id;
  end if;
  perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'record_reading', v_hash, i.id);
  return v_id;
end $$;
revoke all on function public.record_driver_reading(uuid, integer, timestamptz, boolean, uuid) from public, anon;
grant execute on function public.record_driver_reading(uuid, integer, timestamptz, boolean, uuid) to authenticated;

-- a retake after the reading was entered re-links the reading to the new current photo (an event records it)
create function public.odometer_evidence_relink() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.odometer_readings;
begin
  if not new.is_current then
    return null;
  end if;
  select * into r from public.odometer_readings x where x.inspection_id = new.inspection_id and x.reading_status = 'submitted' for update;
  if found and r.odometer_evidence_id is distinct from new.id then
    update public.odometer_readings set odometer_evidence_id = new.id where id = r.id returning * into r;
    perform public.odometer_log_event(r, 'photo_relinked', null, jsonb_build_object('odometer_evidence_id', new.id), null, auth.uid(), null,
                                      jsonb_build_object('retake_of', new.retake_of_id));
  end if;
  return null;
end $$;
revoke all on function public.odometer_evidence_relink() from public, anon, authenticated;
create trigger odometer_evidence_relink_t after insert on public.odometer_evidence for each row execute function public.odometer_evidence_relink();

-- ---------------------------------------------------------------- submit_inspection: 047's rules + IN015 + validation
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
  -- 5b. IN015 (DEC-44, 5A): the driver entered the reading shown in the photo (blind entry, DEC-05)
  if not exists (select 1 from public.odometer_readings x where x.inspection_id = i.id and x.reading_status = 'submitted' and x.driver_reading_km is not null) then
    perform public.inspection_fail('IN015', 'Enter the odometer reading shown in your photo before you submit.');
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

  -- 5A: validate the reading in the same transaction and send it to review (quick check or full review, DEC-44)
  perform public.odometer_submit_reading(i.id);

  perform public.inspection_record(i.company_id, v_uid, p_client_submission_id, 'submit', v_hash, i.id);
  out_inspection_id := i.id; out_status := 'submitted'; out_late_flag := v_late; out_safety_defect_flag := v_safety; out_replayed := false;
  return next;
end $$;


-- ---------------------------------------------------------------- void_inspection: 039 + the reading
create or replace function public.void_inspection(p_inspection_id uuid, p_reason text, p_client_submission_id uuid) returns uuid
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
  -- 5A: a reading of the voided inspection that is not accepted is rejected with the void reason (an accepted one stays; 5B replaces it)
  perform public.odometer_void_for_inspection(i.id, v_reason, v_uid);
  perform set_config('app.audit_reason', '', true);
  perform public.inspection_record(v_company, v_uid, p_client_submission_id, 'void', v_hash, i.id);
  return i.id;
end $$;


-- ---------------------------------------------------------------- my_inspection: 048 + the driver's reading status
create or replace function public.my_inspection(p_allocation_id uuid, p_stage text) returns jsonb
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
  v_known jsonb;
  v_new jsonb;
  v_reading jsonb;
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_stage is null or p_stage not in ('pre_shift', 'post_shift') then
    perform public.inspection_fail('22023', 'the inspection stage must be pre_shift or post_shift');
  end if;
  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company;
  if not found then
    perform public.inspection_fail('P0002', 'that allocation was not found, or you cannot access it');
  end if;
  select * into i from public.inspections x where x.allocation_id = a.id and x.inspection_stage = p_stage and x.status <> 'void';
  -- the allocation's own driver, or (DEC-09) the person completing an on-behalf post-shift inspection — never anyone else
  if not public.driver_is_self(a.driver_id)
     and not (i.id is not null and i.completed_by_role = 'supervisor_on_behalf' and i.submitted_by = auth.uid()
              and public.has_permission('inspection.submit', i.branch_id) and public.has_permission('allocation.manage', i.branch_id)) then
    perform public.inspection_fail('P0002', 'that allocation was not found, or you cannot access it');
  end if;
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

  -- DEC-42: the vehicle's open damage (reported or verified): zone, severity, description, status, date. No photos, no names.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'zone', d.zone, 'zone_label', public.damage_zone_label(d.zone), 'severity', d.severity, 'description', d.description,
           'status', d.status, 'reported_at', d.reported_at, 'source', d.source,
           'reported_now', d.reported_in_inspection_id is not distinct from i.id and i.id is not null)
           order by d.reported_at, d.id), '[]'::jsonb)
    into v_known
    from public.vehicle_damage_items d
   where d.vehicle_id = a.vehicle_id and d.company_id = a.company_id and d.status in ('reported', 'verified');
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'zone', d.zone, 'zone_label', public.damage_zone_label(d.zone), 'severity', d.severity, 'description', d.description,
           'reported_at', d.reported_at) order by d.reported_at, d.id), '[]'::jsonb)
    into v_new
    from public.vehicle_damage_items d where i.id is not null and d.reported_in_inspection_id = i.id;

  -- 5A: what the driver sees about their own reading: their typed value and a plain status. Never an OCR value (DEC-05), a check, or a reviewer.
  select jsonb_build_object('driver_reading_km', x.driver_reading_km,
           'status', case when x.reading_status = 'submitted' then 'entered'
                          when x.reading_status = 'awaiting_review' and x.review_kind = 'quick_check' then 'sent_for_checking'
                          when x.reading_status = 'accepted' then 'accepted'
                          else 'needs_supervisor' end)
    into v_reading
    from public.odometer_readings x
   where i.id is not null and x.inspection_id = i.id and x.reading_status <> 'superseded'
   order by (x.reading_status = 'rejected'), x.created_at desc limit 1;

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
        'id', i.id, 'status', i.status, 'vehicle_confirmed', i.vehicle_confirmed, 'known_damage_reviewed', i.known_damage_reviewed,
        'completed_by_role', i.completed_by_role, 'on_behalf_reason', i.on_behalf_reason,
        'viewer_is_completer', i.submitted_by = auth.uid(), 'late_flag', i.late_flag,
        'safety_defect_flag', i.safety_defect_flag, 'captured_offline', i.captured_offline,
        'started_at', i.started_at, 'submitted_at', i.submitted_at) end,
    'items', v_items, 'photo_slots', v_slots, 'odometer_photo_present', v_odo,
    'known_damage_reviewed', coalesce(i.known_damage_reviewed, false), 'known_damage', v_known, 'new_damage', v_new, 'reading', v_reading);
end $$;

