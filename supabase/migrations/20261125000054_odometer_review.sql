-- 054 — Slice 5A (4/4): the two review paths and the reviewer's reads
-- (PRD v1.20 §4.2, §5.8, §5.9; ARCH v1.19 §6.5, §6.6, §7.5; DB v1.15 §8, §17; DEC-23, DEC-24, DEC-37 / DEC-41, DEC-44).
-- Added (client, SECURITY DEFINER, search_path = '', authenticated only; each is idempotent on client_submission_id through odometer_requests):
--   quick_check_accept(items jsonb, client_submission_id)                 odometer.exception.review — per-item results, never all-or-nothing
--   send_to_full_review(reading, note, client_submission_id)              odometer.exception.review — "doesn't match the photo"
--   review_reading(reading, decision, accepted_km, reason, csid)          odometer.exception.approve — accept | accept_value | reject
--   list_odometer_review(queue, branch, limit)                            the two queues (no driver names unless driver_register_visible())
--   odometer_review_detail(reading)                                       one reading with every check, its events and exceptions
--   odometer_review_counts(branch)                                        open counts for the supervisor overview
-- Added (internal): odometer_reviewer_blocked(reading, user), odometer_ledger_replay / odometer_ledger_record
--
-- DEC-24 / DEC-44 in the database: nobody checks or decides a reading they entered, one from an inspection they completed
-- (inspections.submitted_by, i.e. the on-behalf supervisor too), or one on an allocation where they are the driver. Enforced HERE (OD006) and
-- by the CHECKs odr_no_self_accept / odr_no_self_review / odr_no_self_send on the reading, so a direct call or a direct UPDATE cannot skip it.
--
-- approvals.requested_by for odometer_exception = the reading's SUBMITTER (odometer_readings.entered_by). No system user exists in this
-- database, and a system marker as requester would make approvals_no_self_decision (decided_by <> requested_by) meaningless: with the
-- submitter as requester the approvals table itself refuses a decision by the person who entered the reading, a second line behind OD006.
-- The row is inserted already decided (approved / rejected, decided_by = the reviewer), in the same transaction as the decision.

create function public.odometer_reviewer_blocked(r public.odometer_readings, p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_uid = r.entered_by or p_uid = r.driver_profile_id
         or exists (select 1 from public.inspections i where i.id = r.inspection_id and i.submitted_by = p_uid)
$$;
revoke all on function public.odometer_reviewer_blocked(public.odometer_readings, uuid) from public, anon, authenticated;

-- idempotency ledger helpers (odometer_requests)
create function public.odometer_ledger_replay(p_company uuid, p_actor uuid, p_csid uuid, p_function text, p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.odometer_requests;
begin
  select * into q from public.odometer_requests where company_id = p_company and actor_id = p_actor and client_submission_id = p_csid;
  if not found then
    return null;
  end if;
  if q.function_name <> p_function or q.request_hash <> p_hash then
    perform public.odometer_fail('22023', 'client_submission_id was already used for a different request');
  end if;
  return q.result;
end $$;
create function public.odometer_ledger_record(p_company uuid, p_actor uuid, p_csid uuid, p_function text, p_hash text, p_reading uuid, p_result jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.odometer_requests (company_id, actor_id, client_submission_id, function_name, request_hash, odometer_reading_id, result)
  values (p_company, p_actor, p_csid, p_function, p_hash, p_reading, p_result)
  on conflict (company_id, actor_id, client_submission_id) do nothing
$$;
revoke all on function public.odometer_ledger_replay(uuid, uuid, uuid, text, text), public.odometer_ledger_record(uuid, uuid, uuid, text, text, uuid, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- quick check: accept one or several (DEC-44)
-- p_items: [{ "reading_id": uuid, "validated_at": timestamptz as the list showed it }]. Each reading is accepted SEPARATELY (acceptance_method
-- reviewer, review_kind quick_check, accepted value = the driver's value, one event). A reading that is no longer awaiting review, is not a
-- quick-check reading, or whose validation changed since the list was loaded is refused on its own, with a code and a message; the rest go through.
create function public.quick_check_accept(p_items jsonb, p_client_submission_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_hash text;
  v_prior jsonb;
  v_item jsonb;
  v_results jsonb := '[]'::jsonb;
  v_id uuid;
  v_at timestamptz;
  v_msg text;
  v_hint text;
  v_state text;
  r public.odometer_readings;
  v_out jsonb;
  v_ok integer := 0;
  v_no integer := 0;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.odometer_fail('22023', 'client_submission_id is required');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    perform public.odometer_fail_code('OD010');
  end if;
  v_hash := md5(p_items::text);
  v_prior := public.odometer_ledger_replay(v_company, v_uid, p_client_submission_id, 'quick_check', v_hash);
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_id := null;
    begin
      v_id := (v_item ->> 'reading_id')::uuid;
      v_at := (v_item ->> 'validated_at')::timestamptz;
      select * into r from public.odometer_readings x where x.id = v_id and x.company_id = v_company for update;
      if not found then
        perform public.odometer_fail_code('OD002');
      end if;
      if not public.has_permission('odometer.exception.review', r.branch_id) then
        perform public.odometer_fail_code('OD001');
      end if;
      if public.odometer_reviewer_blocked(r, v_uid) then
        perform public.odometer_fail_code('OD006');
      end if;
      if r.reading_status <> 'awaiting_review' then
        perform public.odometer_fail_code('OD003');
      end if;
      if r.review_kind <> 'quick_check' then
        perform public.odometer_fail_code('OD005');
      end if;
      if v_at is null or r.validated_at is distinct from v_at then
        perform public.odometer_fail_code('OD004');
      end if;
      perform public.odometer_accept(r.id, 'reviewer', 'quick_check', r.driver_reading_km, v_uid, null, null, jsonb_build_object('quick_check', true));
      v_results := v_results || jsonb_build_array(jsonb_build_object('reading_id', v_id, 'result', 'accepted'));
      v_ok := v_ok + 1;
    exception when others then
      get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
      v_state := sqlstate;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'reading_id', v_id, 'result', 'refused',
        'code', case when v_state ~ '^OD[0-9]{3}$' then v_state else 'OD010' end,
        'message', case when v_hint = 'user_message' then v_msg else 'That reading could not be accepted. Reload the list and try again.' end));
      v_no := v_no + 1;
    end;
  end loop;
  v_out := jsonb_build_object('results', v_results, 'accepted', v_ok, 'refused', v_no, 'replayed', false);
  perform public.odometer_ledger_record(v_company, v_uid, p_client_submission_id, 'quick_check', v_hash, null, v_out);
  return v_out;
end $$;

-- ---------------------------------------------------------------- quick check: "doesn't match the photo" -> full review
create function public.send_to_full_review(p_reading_id uuid, p_note text, p_client_submission_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_note text := nullif(btrim(p_note), '');
  v_hash text;
  v_prior jsonb;
  r public.odometer_readings;
  v_ex uuid;
  v_out jsonb;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.odometer_fail('22023', 'client_submission_id is required');
  end if;
  v_hash := md5(p_reading_id::text || '|' || coalesce(v_note, ''));
  v_prior := public.odometer_ledger_replay(v_company, v_uid, p_client_submission_id, 'send_to_full', v_hash);
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;
  select * into r from public.odometer_readings x where x.id = p_reading_id and x.company_id = v_company for update;
  if not found then
    perform public.odometer_fail_code('OD002');
  end if;
  if not public.has_permission('odometer.exception.review', r.branch_id) then
    perform public.odometer_fail_code('OD001');
  end if;
  if public.odometer_reviewer_blocked(r, v_uid) then
    perform public.odometer_fail_code('OD006');
  end if;
  if r.reading_status <> 'awaiting_review' then
    perform public.odometer_fail_code('OD003');
  end if;
  if r.review_kind <> 'quick_check' then
    perform public.odometer_fail_code('OD005');
  end if;
  if v_note is null or length(v_note) > 500 then
    perform public.odometer_fail_code('OD007');
  end if;

  update public.odometer_readings set review_kind = 'full', full_review_requested_by = v_uid, full_review_note = v_note where id = r.id;
  insert into public.odometer_exceptions
    (company_id, branch_id, vehicle_id, driver_id, allocation_id, odometer_reading_id, inspection_id, exception_type, description, severity)
  values (r.company_id, r.branch_id, r.vehicle_id, r.driver_id, r.allocation_id, r.id, r.inspection_id, 'other',
          'Sent from the quick check: the typed reading does not match the photo. ' || v_note, 'medium')
  returning id into v_ex;
  perform public.odometer_log_event(r, 'sent_to_full_review', jsonb_build_object('review_kind', 'quick_check'), jsonb_build_object('review_kind', 'full'),
                                    v_note, v_uid, null, jsonb_build_object('exception_id', v_ex));
  v_out := jsonb_build_object('reading_id', r.id, 'review_kind', 'full', 'exception_id', v_ex, 'replayed', false);
  perform public.odometer_ledger_record(v_company, v_uid, p_client_submission_id, 'send_to_full', v_hash, r.id, v_out);
  return v_out;
end $$;

-- ---------------------------------------------------------------- full review: accept | accept_value | reject (odometer.exception.approve)
-- One reading at a time, reason required. The driver's value is never edited: accept_value stores the reviewer's value in
-- accepted_reading_km. The reading's open exceptions are resolved (accept) or dismissed (reject) through ONE approvals row.
create function public.review_reading(
  p_reading_id uuid, p_decision text, p_accepted_km integer, p_reason text, p_client_submission_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_reason text := nullif(btrim(p_reason), '');
  v_hash text;
  v_prior jsonb;
  r public.odometer_readings;
  v_appr uuid;
  v_exceptions jsonb;
  v_accept_km integer;
  v_out jsonb;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.odometer_fail('22023', 'client_submission_id is required');
  end if;
  if p_decision is null or p_decision not in ('accept', 'accept_value', 'reject') then
    perform public.odometer_fail_code('OD010');
  end if;
  v_hash := md5(p_reading_id::text || '|' || p_decision || '|' || coalesce(p_accepted_km::text, '') || '|' || coalesce(v_reason, ''));
  v_prior := public.odometer_ledger_replay(v_company, v_uid, p_client_submission_id, 'review', v_hash);
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;
  select * into r from public.odometer_readings x where x.id = p_reading_id and x.company_id = v_company for update;
  if not found then
    perform public.odometer_fail_code('OD002');
  end if;
  if not public.has_permission('odometer.exception.approve', r.branch_id) then
    perform public.odometer_fail_code('OD001');
  end if;
  if public.odometer_reviewer_blocked(r, v_uid) then
    perform public.odometer_fail_code('OD006');
  end if;
  if r.reading_status <> 'awaiting_review' then
    perform public.odometer_fail_code('OD003');
  end if;
  if r.review_kind <> 'full' then
    perform public.odometer_fail_code('OD005');
  end if;
  if v_reason is null or length(v_reason) > 500 then
    perform public.odometer_fail_code('OD007');
  end if;
  if p_decision = 'accept_value' then
    if p_accepted_km is null or p_accepted_km < 0 or p_accepted_km > 9999999 then
      perform public.odometer_fail_code('OD008');
    end if;
    if p_accepted_km = r.driver_reading_km then
      perform public.odometer_fail_code('OD009');
    end if;
    v_accept_km := p_accepted_km;
  elsif p_accepted_km is not null then
    perform public.odometer_fail_code('OD010');
  else
    v_accept_km := r.driver_reading_km;
  end if;

  select coalesce(jsonb_agg(e.id order by e.created_at), '[]'::jsonb) into v_exceptions
    from public.odometer_exceptions e where e.odometer_reading_id = r.id and e.status in ('open', 'in_review');
  insert into public.approvals
    (company_id, branch_id, entity_type, entity_id, approval_type, requested_by, status, reason, decision_notes, decided_by, decided_at, payload, client_submission_id)
  values (v_company, r.branch_id, 'odometer_reading', r.id, 'odometer_exception', r.entered_by,
          case when p_decision = 'reject' then 'rejected' else 'approved' end, 'Odometer reading review (full review)', v_reason, v_uid, clock_timestamp(),
          jsonb_build_object('decision', p_decision, 'driver_reading_km', r.driver_reading_km, 'accepted_reading_km', case when p_decision = 'reject' then null else v_accept_km end,
                             'exception_ids', v_exceptions),
          p_client_submission_id)
  returning id into v_appr;

  perform set_config('app.audit_reason', v_reason, true);
  if p_decision = 'reject' then
    perform public.odometer_resolve_exceptions(r.id, 'dismissed', 'Reading rejected: ' || v_reason, v_appr);
    perform public.odometer_reject(r.id, v_uid, v_uid, v_appr, v_reason, jsonb_build_object('review_kind', 'full'));
  else
    perform public.odometer_resolve_exceptions(r.id, 'resolved',
      case when p_decision = 'accept' then 'Driver''s reading accepted: ' else format('Accepted a different value (%s km): ', v_accept_km) end || v_reason, v_appr);
    perform public.odometer_accept(r.id, 'reviewer', 'full', v_accept_km, v_uid, v_appr, v_reason, jsonb_build_object('decision', p_decision));
  end if;
  perform set_config('app.audit_reason', '', true);

  v_out := jsonb_build_object('reading_id', r.id, 'decision', p_decision, 'approval_id', v_appr,
                              'accepted_reading_km', case when p_decision = 'reject' then null else v_accept_km end, 'replayed', false);
  perform public.odometer_ledger_record(v_company, v_uid, p_client_submission_id, 'review', v_hash, r.id, v_out);
  return v_out;
end $$;

-- ---------------------------------------------------------------- the reviewer's reads (no driver names unless driver_register_visible, DEC-41)
create function public.list_odometer_review(p_queue text, p_branch_id uuid default null, p_limit integer default 100)
returns table (
  reading_id uuid, validated_at timestamptz, branch_id uuid, branch_name text, vehicle_id uuid, fleet_number text, registration text,
  inspection_id uuid, allocation_id uuid, inspection_stage text, planned_start_at timestamptz, planned_end_at timestamptz,
  driver_reading_km integer, driver_name text, evidence_file_id uuid, captured_offline boolean, late_flag boolean, submitted_at timestamptz,
  review_kind text, checks jsonb, failed_checks text[], full_review_note text,
  previous_accepted_km integer, previous_accepted_at timestamptz,
  blocked_reason text, can_decide boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_queue is null or p_queue not in ('quick_check', 'full') then
    perform public.odometer_fail_code('OD010');
  end if;
  return query
  select r.id, r.validated_at, r.branch_id, b.name, r.vehicle_id, v.fleet_number, v.registration_number,
         r.inspection_id, r.allocation_id, r.inspection_stage, a.planned_start_at, a.planned_end_at,
         r.driver_reading_km,
         case when public.driver_register_visible(r.branch_id, r.driver_profile_id)
              then (select p.display_name from public.profiles p where p.id = r.driver_profile_id) end,
         oe.evidence_file_id, r.captured_offline, i.late_flag, r.submitted_at,
         r.review_kind,
         coalesce((select jsonb_agg(jsonb_build_object('key', c ->> 'key', 'result', c ->> 'result', 'note', c ->> 'note', 'values', c -> 'values'))
                     from jsonb_array_elements(r.validation -> 'checks') c), '[]'::jsonb),
         coalesce((select array_agg(c ->> 'key') from jsonb_array_elements(r.validation -> 'checks') c where c ->> 'result' = 'fail'), '{}'),
         r.full_review_note,
         prev.accepted_reading_km, prev.accepted_at,
         case when public.odometer_reviewer_blocked(r, v_uid) then (select m.message from public.odometer_messages() m where m.code = 'OD006') end,
         (not public.odometer_reviewer_blocked(r, v_uid))
           and public.has_permission(case when p_queue = 'full' then 'odometer.exception.approve' else 'odometer.exception.review' end, r.branch_id)
    from public.odometer_readings r
    join public.branches b on b.id = r.branch_id and b.company_id = r.company_id
    join public.vehicles v on v.id = r.vehicle_id and v.company_id = r.company_id
    join public.vehicle_allocations a on a.id = r.allocation_id
    join public.inspections i on i.id = r.inspection_id
    left join public.odometer_evidence oe on oe.id = r.odometer_evidence_id
    left join lateral (
      select x.accepted_reading_km, x.accepted_at
        from public.odometer_readings x join public.vehicle_allocations xa on xa.id = x.allocation_id
       where x.vehicle_id = r.vehicle_id and x.reading_status = 'accepted' and x.id <> r.id
         and (xa.planned_start_at, public.odometer_stage_rank(x.inspection_stage)) < (a.planned_start_at, public.odometer_stage_rank(r.inspection_stage))
       order by xa.planned_start_at desc, public.odometer_stage_rank(x.inspection_stage) desc limit 1) prev on true
   where r.company_id = v_company and r.reading_status = 'awaiting_review' and r.review_kind = p_queue
     and (p_branch_id is null or r.branch_id = p_branch_id)
     and public.has_permission('odometer.exception.review', r.branch_id)
   order by a.planned_start_at, public.odometer_stage_rank(r.inspection_stage), r.id
   limit greatest(1, least(coalesce(p_limit, 100), 500));
end $$;

create function public.odometer_review_detail(p_reading_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  r public.odometer_readings;
  v_row jsonb;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into r from public.odometer_readings x where x.id = p_reading_id and x.company_id = v_company;
  if not found or not public.has_permission('odometer.exception.review', r.branch_id) then
    perform public.odometer_fail_code('OD002');
  end if;
  select to_jsonb(q) into v_row
    from (select * from public.list_odometer_review(r.review_kind, r.branch_id, 500) l where l.reading_id = r.id) q;
  return jsonb_build_object(
    'reading', v_row,
    'status', r.reading_status,
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'type', e.exception_type, 'severity', e.severity, 'description', e.description,
                                                                 'status', e.status, 'resolution_summary', e.resolution_summary) order by e.created_at)
                              from public.odometer_exceptions e where e.odometer_reading_id = r.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('type', v.event_type, 'reason', v.reason, 'occurred_at', v.occurred_at) order by v.occurred_at)
                          from public.odometer_reading_events v where v.odometer_reading_id = r.id), '[]'::jsonb));
end $$;

create function public.odometer_review_counts(p_branch_id uuid default null)
returns table (quick_check integer, full_review integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  return query
  select (count(*) filter (where r.review_kind = 'quick_check'))::integer, (count(*) filter (where r.review_kind = 'full'))::integer
    from public.odometer_readings r
   where r.company_id = v_company and r.reading_status = 'awaiting_review'
     and (p_branch_id is null or r.branch_id = p_branch_id)
     and public.has_permission('odometer.exception.review', r.branch_id);
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function public.quick_check_accept(jsonb, uuid), public.send_to_full_review(uuid, text, uuid),
  public.review_reading(uuid, text, integer, text, uuid), public.list_odometer_review(text, uuid, integer),
  public.odometer_review_detail(uuid), public.odometer_review_counts(uuid) from public, anon;
grant execute on function public.quick_check_accept(jsonb, uuid), public.send_to_full_review(uuid, text, uuid),
  public.review_reading(uuid, text, integer, text, uuid), public.list_odometer_review(text, uuid, integer),
  public.odometer_review_detail(uuid), public.odometer_review_counts(uuid) to authenticated;
