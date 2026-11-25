-- Slice 5A pgTAP: the odometer reading — the driver's blind entry, validation, routing, the two review paths, DEC-24 / DEC-44 in the database, RLS,
-- no hard deletes, FK coverage (migrations 051–054; PRD v1.20 §5.8, §5.9; DEC-05, DEC-12..18, DEC-23, DEC-24, DEC-37 / DEC-41, DEC-44). Synthetic data only; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(231);

create schema tests;
create table tests.sha_override (file text primary key, sha text not null);
grant all on tests.sha_override to public;
grant usage on schema tests to anon, authenticated, service_role;
create function tests.id(n text) returns uuid language sql immutable as $$ select md5('fleetiq-test-' || n)::uuid $$;
create function tests.act_as(n text) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(n), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
end $$;
create function tests.reset() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims', '', true); end $$;
create function tests.sqlstate_of(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlstate; end $$;
create function tests.err_of(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlstate || ':' || sqlerrm; end $$;
create function tests.mk_user(n text, comp text, utype text default 'staff') returns void language sql as $$
  insert into auth.users (id, email) values (tests.id(n), n || '@example.test');
  insert into public.profiles (id, company_id, display_name, email, phone, user_type, login_identifier)
  values (tests.id(n), tests.id(comp), 'Synthetic ' || n, n || '@example.test', '0000000', utype, n);
$$;
create function tests.grant_role(n text, role_name text, branch text, by text) returns void language sql as $$
  insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, granted_by)
  select tests.id(n), r.id, p.company_id, case when branch is null then null else tests.id(branch) end, now() - interval '5 hours', tests.id(by)
  from public.roles r, public.profiles p where r.name = role_name and r.company_id is null and p.id = tests.id(n);
$$;
create function tests.mk_driver(n text, comp text, emp text, branch text) returns void language sql as $$
  select tests.mk_user(n, comp, 'driver');
  insert into public.drivers (id, company_id, profile_id, employee_number, branch_id) values (tests.id('d-' || n), tests.id(comp), tests.id(n), emp, tests.id(branch));
  select tests.grant_role(n, 'driver', branch, case when comp = 'coB' then 'bootb' else 'boot' end);
$$;
-- an evidence file (as if registered): n = label, uploader = profile label
create function tests.mk_file(n text, uploader text, branch text, purpose text default 'odometer', src text default 'in_app_camera') returns void language sql as $$
  insert into public.evidence_files (id, company_id, branch_id, bucket, object_path, sha256, mime_type, size_bytes, capture_source, exif_gps_stripped, uploaded_by, purpose)
  select tests.id('f-' || n), p.company_id, tests.id(branch), 'evidence', 'test/' || n, coalesce((select o.sha from tests.sha_override o where o.file = n), md5(n) || md5(n)), 'image/jpeg', 1000, src, true, p.id, purpose
    from public.profiles p where p.id = tests.id(uploader);
$$;
-- one scenario: driver + vehicle + shift + allocation in the given status + the two odometer files
create function tests.sc(label text, branch text, astatus text, shift_s timestamptz, shift_e timestamptz,
                         planned_e timestamptz default null, category text default 'bakkie') returns void language plpgsql as $$
declare comp text := case when branch = 'B1' then 'coB' else 'coA' end; booter text := case when branch = 'B1' then 'bootb' else 'boot' end;
begin
  perform tests.mk_driver('u-' || label, comp, 'E-' || upper(label), branch);
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('v-' || label), tests.id(comp), tests.id(branch), 'FL-' || label, upper('T4A' || label), 'Make', 'Model', category);
  insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('sh-' || label), tests.id(comp), tests.id(branch), (shift_s at time zone 'Africa/Johannesburg')::date, shift_s, shift_e, gen_random_uuid(), tests.id(booter));
  insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, status, started_at,
                                          opened_at, opened_by, licence_class_check, client_submission_id, created_by)
  values (tests.id('al-' || label), tests.id(comp), tests.id(branch), tests.id('v-' || label), tests.id('d-u-' || label), tests.id('sh-' || label),
          shift_s, coalesce(planned_e, shift_e), astatus, case when astatus in ('in_use', 'post_inspection_pending') then shift_s end,
          case when astatus <> 'planned' then shift_s end, case when astatus <> 'planned' then tests.id('u-' || label) end, 'matched', gen_random_uuid(), tests.id(booter));
  perform tests.mk_file('fo-' || label || '-pre', 'u-' || label, branch);
  perform tests.mk_file('fo-' || label || '-post', 'u-' || label, branch);
end $$;
create function tests.al(l text) returns uuid language sql immutable as $$ select tests.id('al-' || l) $$;
create function tests.ins(l text, stage text default 'pre_shift') returns uuid language sql stable as $$
  select id from public.inspections where allocation_id = tests.al(l) and inspection_stage = stage and status <> 'void' $$;
create function tests.item(k text, comp text default 'coA') returns uuid language sql stable as $$
  select i.id from public.inspection_template_items i join public.inspection_templates t on t.id = i.template_id
   where t.company_id = tests.id(comp) and t.vehicle_category is null and i.item_key = k $$;
-- every item of the stage answered "fine"
create function tests.answers(stage text, comp text default 'coA') returns jsonb language sql stable as $$
  select jsonb_agg(jsonb_build_object('template_item_id', i.id, 'value', case i.response_type when 'ok_defect' then 'ok' when 'fuel_quarter' then '1/2' else 'no' end) order by i.sequence)
    from public.inspection_template_items i join public.inspection_templates t on t.id = i.template_id
   where t.company_id = tests.id(comp) and t.vehicle_category is null and i.applies_to_stage = stage $$;
create function tests.ans(k text, v text, c text default null) returns jsonb language sql stable as $$
  select jsonb_build_object('template_item_id', tests.item(k), 'value', v, 'comment', c) $$;
create function tests.csid(n text) returns uuid language sql immutable as $$ select md5('cs-' || n)::uuid $$;
-- as the driver (caller does act_as): begin + answer everything + confirm vehicle + odometer photo => ready to submit
create function tests.prep(label text, stage text default 'pre_shift') returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.begin_inspection(tests.al(label), stage, null, false, tests.csid(label || stage || 'b'));
  perform public.save_inspection_responses(v, tests.answers(stage), true, tests.csid(label || stage || 's'));
  perform public.confirm_known_damage_reviewed(v, tests.csid(label || stage || 'k'));
  perform public.attach_odometer_photo(v, tests.id('f-fo-' || label || '-' || case stage when 'pre_shift' then 'pre' else 'post' end), tests.csid(label || stage || 'o'));
  return v;
end $$;
create function tests.submit(label text, stage text default 'pre_shift', c text default null) returns text language sql as $$
  select tests.err_of(format('select * from public.submit_inspection(%L, null, false, %L)', tests.ins(label, stage), tests.csid(coalesce(c, label || stage || 'x')))) $$;
-- (post-shift) answer everything except the incident question (set by the caller) and attach the odometer photo
create function tests.prep_rest(label text) returns void language plpgsql as $$
begin
  perform public.save_inspection_responses(tests.ins(label, 'post_shift'),
    (select jsonb_agg(e) from jsonb_array_elements(tests.answers('post_shift')) e where e ->> 'template_item_id' <> tests.item('post_incident')::text), true, tests.csid(label || 'rest'));
  perform public.attach_odometer_photo(tests.ins(label, 'post_shift'), tests.id('f-fo-' || label || '-post'), tests.csid(label || 'resto'));
  perform public.confirm_known_damage_reviewed(tests.ins(label, 'post_shift'), tests.csid(label || 'restk'));
end $$;
create function tests.n(q text) returns integer language plpgsql as $$
declare r integer; begin execute q into r; return r; end $$;

alter function tests.ins(text, text) security definer;
create function tests.sfile(n text, uploader text, branch text default 'A1') returns void language sql as $$ select tests.mk_file(n, uploader, branch, 'odometer') $$;
-- a second (or third...) allocation on an EXISTING vehicle (v-<vlabel>); non-overlapping windows only
create function tests.alloc(label text, vlabel text, branch text, st timestamptz, en timestamptz, astatus text default 'pre_inspection_pending') returns void language plpgsql as $$
declare comp text := case when branch = 'B1' then 'coB' else 'coA' end; booter text := case when branch = 'B1' then 'bootb' else 'boot' end;
begin
  perform tests.mk_driver('u-' || label, comp, 'E-' || upper(label), branch);
  insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('sh-' || label), tests.id(comp), tests.id(branch), (st at time zone 'Africa/Johannesburg')::date, st, en, gen_random_uuid(), tests.id(booter));
  insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, status, started_at,
                                          opened_at, opened_by, licence_class_check, client_submission_id, created_by)
  values (tests.id('al-' || label), tests.id(comp), tests.id(branch), tests.id('v-' || vlabel), tests.id('d-u-' || label), tests.id('sh-' || label),
          st, en, astatus, case when astatus in ('in_use', 'post_inspection_pending') then st end,
          case when astatus <> 'planned' then st end, case when astatus <> 'planned' then tests.id('u-' || label) end, 'matched', gen_random_uuid(), tests.id(booter));
  perform tests.mk_file('fo-' || label || '-pre', 'u-' || label, branch);
  perform tests.mk_file('fo-' || label || '-post', 'u-' || label, branch);
end $$;
-- an evidence file with a chosen hash (duplicate-image tests)
create function tests.mk_file_sha(n text, uploader text, branch text, sha text) returns void language sql as $$
  insert into public.evidence_files (id, company_id, branch_id, bucket, object_path, sha256, mime_type, size_bytes, capture_source, exif_gps_stripped, uploaded_by, purpose)
  select tests.id('f-' || n), p.company_id, tests.id(branch), 'evidence', 'test/' || n, sha, 'image/jpeg', 1000, 'in_app_camera', true, p.id, 'odometer'
    from public.profiles p where p.id = tests.id(uploader);
$$;
create function tests.rid(label text, stage text default 'pre_shift') returns uuid language sql stable security definer as $$
  select r.id from public.odometer_readings r where r.allocation_id = tests.al(label) and r.inspection_stage = stage and r.reading_status <> 'superseded' order by r.created_at desc limit 1 $$;
create function tests.rd(label text, stage text, km integer, c text default null) returns text language sql as $$
  select tests.err_of(format('select public.record_driver_reading(%L, %L, null, false, %L)', tests.ins(label, stage), km, tests.csid(coalesce(c, label || stage || 'rd' || coalesce(km::text, 'n'))))) $$;
-- as the driver: prepare the stage, enter the reading, submit. Returns the submit error (null = submitted).
create function tests.do_stage(label text, stage text, km integer) returns text language plpgsql as $$
declare v uuid;
begin
  v := tests.prep(label, stage);
  perform public.record_driver_reading(v, km, null, false, tests.csid(label || stage || 'rd0'));
  return tests.submit(label, stage);
end $$;
create function tests.qc(items jsonb, c text) returns jsonb language sql as $$ select public.quick_check_accept(items, tests.csid(c)) $$;
-- one quick-check item as the list shows it
create function tests.qi(label text, stage text default 'pre_shift') returns jsonb language sql stable security definer as $$
  select jsonb_build_object('reading_id', r.id, 'validated_at', r.validated_at) from public.odometer_readings r where r.id = tests.rid(label, stage) $$;
create function tests.rv(label text, stage text, decision text, km integer, reason text, c text) returns text language sql as $$
  select tests.err_of(format('select public.review_reading(%L, %L, %L, %L, %L)', tests.rid(label, stage), decision, km, reason, tests.csid(c))) $$;
create function tests.res(r jsonb, i integer) returns text language sql immutable as $$ select (r -> 'results' -> i ->> 'result') || coalesce(':' || (r -> 'results' -> i ->> 'code'), '') $$;
create function tests.chk(label text, stage text, k text) returns text language sql stable security definer as $$
  select c ->> 'result' from public.odometer_readings r, jsonb_array_elements(r.validation -> 'checks') c where r.id = tests.rid(label, stage) and c ->> 'key' = k $$;
create function tests.st(label text, stage text default 'pre_shift') returns text language sql stable security definer as $$
  select reading_status || '/' || coalesce(review_kind, '-') from public.odometer_readings where id = tests.rid(label, stage) $$;
create function tests.do_stage_b(label text, stage text, km integer) returns text language plpgsql as $$
declare v uuid;
begin
  v := public.begin_inspection(tests.al(label), stage, null, false, tests.csid(label || stage || 'b'));
  perform public.save_inspection_responses(v, tests.answers(stage, 'coB'), true, tests.csid(label || stage || 's'));
  perform public.confirm_known_damage_reviewed(v, tests.csid(label || stage || 'k'));
  perform public.attach_odometer_photo(v, tests.id('f-fo-' || label || '-' || case stage when 'pre_shift' then 'pre' else 'post' end), tests.csid(label || stage || 'o'));
  perform public.record_driver_reading(v, km, null, false, tests.csid(label || stage || 'rd0'));
  return tests.submit(label, stage);
end $$;
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('fa', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'),
       tests.mk_user('sup3', 'coA'), tests.mk_user('bm1', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('sysadm', 'coA'),
       tests.mk_user('fab', 'coB'), tests.mk_user('supb', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sup2', 'supervisor', 'A1', 'boot'),
       tests.grant_role('sup3', 'supervisor', 'A2', 'boot'), tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'),
       tests.grant_role('sm', 'senior_management', null, 'boot'), tests.grant_role('sysadm', 'system_admin', null, 'boot'),
       tests.grant_role('fab', 'fleet_admin', null, 'bootb'), tests.grant_role('supb', 'supervisor', 'B1', 'bootb');
select public.seed_starter_inspection_template(tests.id('coA')), public.seed_starter_inspection_template(tests.id('coB'));

-- company A: the late windows are widened to a week so allocations on earlier days are not "late" (the late test uses a 20-day-old one)
select tests.act_as('fa');
select public.set_validation_settings(null, null, null, 0, 5, 10080, 10080, 7, 'Tests: wide late window', tests.csid('s-late'));
select tests.reset();

-- vehicle c: four allocations in a row on ONE vehicle (-5 .. -2 days), vehicle d: another, e: one allocation (entry tests)
insert into tests.sha_override values ('fo-dup-pre', md5('dupx') || md5('dupx')), ('fo-e5-pre', md5('dupx') || md5('dupx'));
select tests.sc('c1', 'A1', 'pre_inspection_pending', now() - interval '5 days', now() - interval '5 days' + interval '8 hours');
select tests.alloc('c2', 'c1', 'A1', now() - interval '4 days', now() - interval '4 days' + interval '8 hours');
select tests.alloc('c3', 'c1', 'A1', now() - interval '3 days', now() - interval '3 days' + interval '8 hours');
select tests.alloc('c4', 'c1', 'A1', now() - interval '2 days', now() - interval '2 days' + interval '8 hours');
select tests.sc('e1', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc('e2', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc('e3', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc('e4', 'A1', 'in_use', now() - interval '4 hours', now() + interval '4 hours');         -- on-behalf post-shift
select tests.sc('e5', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc('b1', 'B1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc('late', 'A1', 'pre_inspection_pending', now() - interval '20 days', now() - interval '20 days' + interval '8 hours');
select tests.sc('dup', 'A1', 'pre_inspection_pending', now() - interval '1 day', now() - interval '1 day' + interval '8 hours');


-- ================================================================ 1. the driver's entry (record_driver_reading)
select tests.act_as('u-e1');
select tests.reset();
select tests.act_as('u-e1');
select public.begin_inspection(tests.al('e1'), 'pre_shift', null, false, tests.csid('e1b'));
select is(tests.rd('e1', 'pre_shift', 1000, 'e1-nophoto') like 'IN006:%', true, 'a reading needs a current odometer photo first (IN006)');
select public.save_inspection_responses(tests.ins('e1'), tests.answers('pre_shift'), true, tests.csid('e1s'));
select public.confirm_known_damage_reviewed(tests.ins('e1'), tests.csid('e1k'));
select public.attach_odometer_photo(tests.ins('e1'), tests.id('f-fo-e1-pre'), tests.csid('e1o'));
select is(tests.rd('e1', 'pre_shift', -1, 'e1-neg') like '22023:%', true, 'a negative reading is refused');
select is(tests.rd('e1', 'pre_shift', 10000000, 'e1-big') like '22023:%', true, 'more than 7 digits is refused (DEC-12)');
select is(tests.rd('e1', 'pre_shift', null, 'e1-null') like '22023:%', true, 'no value is refused');
select is(tests.submit('e1', 'pre_shift', 'e1-sub0') like 'IN015:%', true, 'IN015: submit without a reading is refused with the plain message');
select matches(tests.submit('e1', 'pre_shift', 'e1-sub0b'), 'Enter the odometer reading shown in your photo before you submit\.', 'IN015 carries the specified message');
select is(tests.rd('e1', 'pre_shift', 1000, 'e1-rd1'), null, 'the driver enters the reading');
create temp table kv (k text primary key, v uuid); grant all on kv to public;
insert into kv select 'e1', public.record_driver_reading(tests.ins('e1'), 1000, null, false, tests.csid('e1-rd1'));
select is(public.record_driver_reading(tests.ins('e1'), 1000, null, false, tests.csid('e1-rd1')), (select v from kv where k = 'e1'), 'the retry with the same id returns the same reading');
select matches(tests.rd('e1', 'pre_shift', 1001, 'e1-rd1'), '^22023:.*already used for a different request', 'the same id with a different value is refused');
select tests.reset();
select is((select count(*)::int from public.inspection_requests where function_name = 'record_reading' and inspection_id = tests.ins('e1')), 1, 'the ledger holds one record_reading entry for it');
select tests.act_as('u-e1');
select is(tests.rd('e1', 'pre_shift', 1020, 'e1-rd2'), null, 'while the inspection is a draft the value can be changed (new id)');
select tests.reset();
select is((select count(*)::int from public.odometer_readings where inspection_id = tests.ins('e1')), 1, 'still one reading for the inspection');
select tests.reset();
select is((select driver_reading_km from public.odometer_readings where inspection_id = tests.ins('e1')), 1020, 'the latest typed value is stored');
select is((select count(*)::int from public.odometer_reading_events where odometer_reading_id = tests.rid('e1') and event_type = 'value_changed'), 1, 'each change is an event (value_changed)');
select is((select count(*)::int from public.odometer_reading_events where odometer_reading_id = tests.rid('e1') and event_type = 'submitted'), 1, 'creating the reading is an event (submitted)');
select is((select odometer_evidence_id from public.odometer_readings where inspection_id = tests.ins('e1')), (select id from public.odometer_evidence where inspection_id = tests.ins('e1') and is_current), 'the reading links to the current odometer photo');
-- retake after entry
select tests.sfile('fo-e1-pre-b', 'u-e1');
select tests.act_as('u-e1');
select public.attach_odometer_photo(tests.ins('e1'), tests.id('f-fo-e1-pre-b'), tests.csid('e1o2'));
select tests.reset();
select is((select odometer_evidence_id from public.odometer_readings where inspection_id = tests.ins('e1')), (select id from public.odometer_evidence where inspection_id = tests.ins('e1') and is_current), 'a retake re-links the reading to the new current photo');
select is((select count(*)::int from public.odometer_reading_events where odometer_reading_id = tests.rid('e1') and event_type = 'photo_relinked'), 1, 'the re-link is an event');
select is((select count(*)::int from public.odometer_evidence where inspection_id = tests.ins('e1')), 2, 'both photos are kept');
-- who may enter
select tests.act_as('u-e2');
select public.begin_inspection(tests.al('e2'), 'pre_shift', null, false, tests.csid('e2b'));
select public.attach_odometer_photo(tests.ins('e2'), tests.id('f-fo-e2-pre'), tests.csid('e2o'));
select tests.act_as('u-e3');
select is(tests.rd('e2', 'pre_shift', 500, 'e2-other') like '42501:%', true, 'another driver cannot enter a reading on this inspection');
select tests.act_as('sup1');
select is(tests.rd('e2', 'pre_shift', 500, 'e2-sup') like '42501:%', true, 'a supervisor who is not completing the inspection is refused');
select tests.act_as('fa');
select is(tests.rd('e2', 'pre_shift', 500, 'e2-fa') like '42501:%', true, 'a fleet administrator is refused');
select tests.act_as('ma');
select is(tests.rd('e2', 'pre_shift', 500, 'e2-ma') like '42501:%', true, 'a maintenance administrator is refused');
select tests.act_as('fab');
select is(tests.rd('e2', 'pre_shift', 500, 'e2-fab') like 'P0002:%', true, 'another company cannot see the inspection');
select tests.reset();
select is((select count(*)::int from public.odometer_readings where inspection_id = tests.ins('e2')), 0, 'none of the refusals created a reading');
-- the driver's phone gets no OCR anywhere
select tests.act_as('u-e1');
select is(public.my_inspection(tests.al('e1'), 'pre_shift')::text ~* 'ocr', false, 'DEC-05: the driver''s inspection document contains no OCR field');
select is(public.my_inspection(tests.al('e1'), 'pre_shift') -> 'reading' ->> 'status', 'entered', 'the driver sees their reading as entered');
select is(public.my_inspection(tests.al('e1'), 'pre_shift') -> 'reading' ->> 'driver_reading_km', '1020', 'the driver sees only their own typed value');
select is(has_column_privilege('authenticated', 'public.odometer_readings', 'ocr_reading_km', 'select'), false, 'DEC-05: no client role can select ocr_reading_km');
select is(has_column_privilege('authenticated', 'public.odometer_readings', 'ocr_result_id', 'select'), false, 'DEC-05: no client role can select ocr_result_id');
select is(has_column_privilege('authenticated', 'public.odometer_readings', 'validation', 'select'), false, 'reviewer fields (validation) are not readable through the table');
-- submit
select is(tests.submit('e1', 'pre_shift', 'e1-sub1'), null, 'with the reading entered, the inspection submits');
select tests.reset();
select is(tests.st('e1'), 'awaiting_review/quick_check', 'submit moved the reading to awaiting_review, routed to the quick check (no failed check)');
select is((select review_status from public.odometer_readings where id = tests.rid('e1')), 'pending', 'review_status pending');
select tests.act_as('u-e1');
select matches(tests.rd('e1', 'pre_shift', 1021, 'e1-after'), '^55000:', 'once submitted the reading can no longer be changed (draft only)');
select is(public.my_inspection(tests.al('e1'), 'pre_shift') -> 'reading' ->> 'status', 'sent_for_checking', 'the driver sees "sent for checking"');
select is(public.my_inspection(tests.al('e1'), 'pre_shift') -> 'reading' ->> 'accepted_reading_km', null, 'the driver is not shown the accepted value');
select tests.reset();
select is(tests.chk('e1', 'pre_shift', 'gallery_upload'), 'pass', 'DEC-04: gallery_upload is recorded as pass');
select is((select r.validation -> 'checks' -> 0 ->> 'key' from public.odometer_readings r where r.id = tests.rid('e1')), 'decreasing_reading', 'the validation result lists each check by key');
select is((select validation_settings_version from public.odometer_readings where id = tests.rid('e1')), 2, 'the settings version used is stored on the reading (set_validation_settings made v2)');
select is((select (validation -> 'settings' ->> 'version')::int from public.odometer_readings where id = tests.rid('e1')), 2, 'and inside the validation result with the settings id');
select is((select validation_settings_id from public.odometer_readings where id = tests.rid('e1')), (select id from public.odometer_validation_settings where company_id = tests.id('coA') and version = 2), 'the settings id is stored');
select is((select count(*)::int from public.odometer_exceptions where odometer_reading_id = tests.rid('e1')), 0, 'no failed check, no exception');
-- the on-behalf supervisor path
select tests.reset();
select tests.sfile('so-e4', 'sup1');
select tests.act_as('sup1');
select public.begin_inspection_on_behalf(tests.al('e4'), 'Driver ended the shift without finishing', null, false, tests.csid('e4b'));
select public.save_inspection_responses(tests.ins('e4', 'post_shift'), tests.answers('post_shift'), true, tests.csid('e4s'));
select public.confirm_known_damage_reviewed(tests.ins('e4', 'post_shift'), tests.csid('e4k'));
select public.attach_odometer_photo(tests.ins('e4', 'post_shift'), tests.id('f-so-e4'), tests.csid('e4o'));
select is(tests.rd('e4', 'post_shift', 777, 'e4-rd'), null, 'on behalf: the completing supervisor enters the reading with the same function');
select is(tests.submit('e4', 'post_shift', 'e4-sub'), null, 'on behalf: and submits');
select tests.reset();
select is((select entered_by from public.odometer_readings where id = tests.rid('e4', 'post_shift')), tests.id('sup1'), 'on behalf: entered_by is the completing supervisor');
select is((select driver_profile_id from public.odometer_readings where id = tests.rid('e4', 'post_shift')), tests.id('u-e4'), 'on behalf: the driver of the allocation is recorded separately');
-- a voided draft rejects its reading
select tests.act_as('u-e2');
select is(tests.rd('e2', 'pre_shift', 500, 'e2-ok'), null, 'e2: the driver enters a reading');
select tests.act_as('sup2');
select is(tests.err_of(format('select public.void_inspection(%L, %L, %L)', tests.ins('e2'), 'Wrong vehicle', tests.csid('e2-void'))), null, 'a supervisor voids the draft');
select tests.reset();
select is((select reading_status || '/' || review_status from public.odometer_readings where id = tests.rid('e2')), 'rejected/rejected', 'void: the reading of a voided inspection is rejected');
select is((select reason from public.odometer_reading_events where odometer_reading_id = tests.rid('e2') and event_type = 'rejected'), 'The inspection was voided: Wrong vehicle', 'void: the rejection event carries the void reason');

-- ================================================================ 2. a review-only role (no roles in the matrix hold review without approve)
select tests.mk_user('rev1', 'coA');
with r as (insert into public.roles (company_id, name, description) values (tests.id('coA'), 'review_only', 'Synthetic: quick check only') returning id)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from r, public.permissions p where p.permission_key in ('odometer.exception.review', 'evidence.view');
insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, granted_by)
select tests.id('rev1'), r.id, tests.id('coA'), tests.id('A1'), now() - interval '5 hours', tests.id('boot') from public.roles r where r.name = 'review_only' and r.company_id = tests.id('coA');

-- ================================================================ 3. validation across one vehicle's allocations (chronology, waiting, re-validation)
select tests.act_as('u-c1');
select is(tests.do_stage('c1', 'pre_shift', 1000), null, 'c1 pre 1000 submitted');
select is(tests.do_stage('c1', 'post_shift', 1100), null, 'c1 post 1100 submitted');
select tests.act_as('u-c2');
select is(tests.do_stage('c2', 'pre_shift', 1100), null, 'c2 pre 1100 submitted');
select tests.act_as('u-c3');
select is(tests.do_stage('c3', 'pre_shift', 1500), null, 'c3 pre 1500 submitted');
select tests.reset();
select is(tests.st('c1', 'pre_shift'), 'awaiting_review/quick_check', 'c1 pre: no earlier reading, no failed check -> quick check');
select is(tests.chk('c1', 'pre_shift', 'decreasing_reading'), 'pass', 'decreasing: no earlier reading passes');
select is(tests.chk('c1', 'pre_shift', 'unaccounted_distance'), 'pass', 'unaccounted: no previous allocation passes');
select is(tests.chk('c1', 'post_shift', 'decreasing_reading'), 'waiting', 'decreasing: an earlier reading is unaccepted and none is accepted -> waiting');
select is(tests.chk('c1', 'post_shift', 'implausible_distance'), 'not_configured', 'implausible_distance reports not_configured while max_km_per_allocation is null (never pass)');
select is(tests.st('c1', 'post_shift'), 'awaiting_review/quick_check', 'routing: waiting + not_configured alone -> quick check');
select is(tests.chk('c2', 'pre_shift', 'unaccounted_distance'), 'waiting', 'unaccounted: the previous post-shift reading is not accepted yet -> waiting');
select is(tests.st('c2', 'pre_shift'), 'awaiting_review/quick_check', 'routing: a waiting check is not a failed check');
select is(tests.chk('c3', 'pre_shift', 'unaccounted_distance'), 'waiting', 'c3: waiting on the same earlier post-shift reading');
select is((select count(*)::int from public.odometer_exceptions where odometer_reading_id in (tests.rid('c1'), tests.rid('c1', 'post_shift'), tests.rid('c2'), tests.rid('c3'))), 0, 'no exception for not_configured / waiting');

-- the quick check as the list shows it, then the data moves under the reviewer
create temp table items (k text primary key, v jsonb); grant all on items to public;
select tests.act_as('sup2');
select is(tests.res(tests.qc(jsonb_build_array(tests.qi('c1')), 'qc-c1pre'), 0), 'accepted', 'quick check: c1 pre accepted by a reviewer who did not enter it');
select tests.reset();
select is(tests.st('c1', 'pre_shift'), 'accepted/quick_check', 'accepted, review_kind quick_check');
select is((select acceptance_method || '/' || accepted_reading_km || '/' || accepted_lifetime_km || '/' || driver_reading_km from public.odometer_readings where id = tests.rid('c1')), 'reviewer/1000/1000/1000', 'acceptance_method reviewer, accepted value = driver value, lifetime = displayed + offset 0');
select is((select count(*)::int from public.odometer_reading_events where odometer_reading_id = tests.rid('c1') and event_type = 'accepted'), 1, 'one accepted event per accepted reading');
select is(tests.chk('c1', 'post_shift', 'decreasing_reading'), 'pass', 're-validation: c1 post is no longer waiting once the pre reading is accepted');
select is((select count(*)::int from public.odometer_reading_events where odometer_reading_id = tests.rid('c1', 'post_shift') and event_type = 'validated'), 2, 're-validation recorded a validated event (submit + re-validation)');
select is((select current_odometer_km from public.vehicles where id = tests.id('v-c1')), 1000, 'the vehicle cache follows the accepted reading');
select is((select current_odometer_reading_id from public.vehicles where id = tests.id('v-c1')), tests.rid('c1'), 'and its reading id');

select tests.reset();
insert into items select 'c2', tests.qi('c2');
insert into items select 'c1post', tests.qi('c1', 'post_shift');
-- stale item in a batch: c2's validation changes when c1 post is accepted; e1 (not stale) goes through in the same call
select tests.act_as('sup2');
select tests.reset();
select tests.act_as('sup2');
select is(tests.res(tests.qc((select jsonb_build_array(v) from items where k = 'c1post'), 'qc-c1post'), 0), 'accepted', 'quick check: c1 post accepted (its list item was fresh)');
select tests.reset();
select is(tests.chk('c2', 'pre_shift', 'unaccounted_distance'), 'pass', 're-validation: c2 pre unaccounted waiting -> pass (1100 - 1100 = 0)');
select is(tests.st('c3', 'pre_shift'), 'awaiting_review/full', 're-validation: c3 pre unaccounted fails (1500 - 1100 > 5) and moves to full review');
select is((select count(*)::int from public.odometer_exceptions where odometer_reading_id = tests.rid('c3') and exception_type = 'unaccounted_distance' and status = 'open' and severity = 'medium'), 1, 'the failed check created ONE open exception (medium)');
select is((select metadata ->> 'route_from' || '>' || (metadata ->> 'route_to') from public.odometer_reading_events where odometer_reading_id = tests.rid('c3') and event_type = 'validated' order by occurred_at desc limit 1), 'quick_check>full', 'the move between queues is a recorded event');
select is((select count(*)::int from public.odometer_exceptions where odometer_reading_id = tests.rid('c3')), 1, 'a second re-validation does not duplicate the exception');
select is((select description !~* 'driver' from public.odometer_exceptions where odometer_reading_id = tests.rid('c3')), true, 'the exception text never attributes the distance to the driver');
select tests.act_as('sup2');
select is(tests.res(tests.qc(jsonb_build_array((select v from items where k = 'c2'), tests.qi('e1')), 'qc-batch'), 0), 'refused:OD004', 'batch: the stale item (validation changed since the list was loaded) is refused with OD004');
select is(tests.res(tests.qc(jsonb_build_array((select v from items where k = 'c2'), tests.qi('e1')), 'qc-batch'), 1), 'accepted', 'batch: the other item is accepted');
select tests.reset();
select is(tests.st('e1'), 'accepted/quick_check', 'the fresh item of the batch is accepted');
select is(tests.st('c2'), 'awaiting_review/quick_check', 'the stale item stays awaiting review');
select tests.act_as('sup2');
select is(tests.res(tests.qc(jsonb_build_array(tests.qi('c2')), 'qc-c2'), 0), 'accepted', 'with a fresh version the refused item is accepted');
select is(tests.res(tests.qc(jsonb_build_array(tests.qi('c2')), 'qc-c2b'), 0), 'refused:OD003', 'an item that is no longer awaiting review is refused (OD003)');
select is(tests.qc(jsonb_build_array(tests.qi('c3')), 'qc-c3') -> 'results' -> 0 ->> 'code', 'OD005', 'a full-review reading cannot be accepted in the quick check (OD005)');
select is(tests.qc(jsonb_build_array(tests.qi('c2')), 'qc-c2')::text like '%"replayed": true%', true, 'idempotent: the same client_submission_id replays the recorded answer');
select matches(tests.err_of(format('select public.quick_check_accept(%L, %L)', jsonb_build_array(tests.qi('c3')), tests.csid('qc-c2'))), '^22023:.*already used for a different request', 'the same id for a different batch is refused');
select is(tests.err_of(format('select public.quick_check_accept(%L, %L)', '[]'::jsonb, tests.csid('qc-empty'))) like 'OD010:%', true, 'an empty batch is refused (OD010)');
select tests.reset();

-- ================================================================ 4. DEC-24 / DEC-44: nobody decides their own
select tests.grant_role('u-e3', 'supervisor', 'A1', 'boot');
select tests.act_as('u-e3');
select tests.do_stage('e3', 'pre_shift', 3000);
select is(tests.res(tests.qc(jsonb_build_array(tests.qi('e3')), 'self-qc'), 0), 'refused:OD006', 'DEC-24: the allocation''s own driver (given supervisor rights) cannot quick-check their reading');
select is(tests.err_of(format('select public.send_to_full_review(%L, %L, %L)', tests.rid('e3'), 'x', tests.csid('self-sf'))) like 'OD006:%', true, 'DEC-24: and cannot send it to full review');
select tests.reset();
select tests.act_as('sup1');
select is(tests.res(tests.qc(jsonb_build_array(tests.qi('e4', 'post_shift')), 'comp-qc'), 0), 'refused:OD006', 'DEC-44: the supervisor who completed the inspection on behalf cannot check its reading');
select tests.reset();
select throws_ok(format('update public.odometer_readings set reviewed_by = driver_profile_id where id = %L', tests.rid('e3')), '23514', null, 'the database CHECK refuses the allocation''s driver as reviewer, even on a direct UPDATE');
select throws_ok(format('update public.odometer_readings set reviewed_by = entered_by where id = %L', tests.rid('e4', 'post_shift')), '23514', null, 'the database CHECK refuses the person who entered the reading as reviewer');
select throws_ok(format('update public.odometer_readings set full_review_requested_by = entered_by where id = %L', tests.rid('e4', 'post_shift')), '23514', null, 'and as the person who sends it to full review');
select tests.act_as('u-e3');
select tests.reset();

-- ================================================================ 5. the quick check "doesn't match the photo"
select tests.act_as('u-e3');
select tests.reset();
select tests.sc('q1', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.act_as('u-q1');
select is(tests.do_stage('q1', 'pre_shift', 4000), null, 'q1 pre submitted');
select tests.act_as('rev1');
select is(tests.err_of(format('select public.send_to_full_review(%L, null, %L)', tests.rid('q1'), tests.csid('sf-1'))) like 'OD007:%', true, 'a note is required (OD007)');
select is(tests.err_of(format('select public.send_to_full_review(%L, ''  '', %L)', tests.rid('q1'), tests.csid('sf-2'))) like 'OD007:%', true, 'a blank note is refused');
select is(tests.err_of(format('select public.send_to_full_review(%L, %L, %L)', tests.rid('q1'), 'The photo shows 4600', tests.csid('sf-3'))), null, 'a reviewer sends it to full review with a note');
select is(tests.err_of(format('select public.send_to_full_review(%L, %L, %L)', tests.rid('q1'), 'The photo shows 4600', tests.csid('sf-3'))), null, 'the retry is a replay');
select tests.reset();
select is(tests.st('q1'), 'awaiting_review/full', 'moved to full review');
select is((select count(*)::int from public.odometer_exceptions where odometer_reading_id = tests.rid('q1') and exception_type = 'other' and description like '%The photo shows 4600%' and status = 'open'), 1, 'an exception of type other with the note');
select is((select count(*)::int from public.odometer_reading_events where odometer_reading_id = tests.rid('q1') and event_type = 'sent_to_full_review' and reason = 'The photo shows 4600'), 1, 'a recorded event with the note');
select is((select full_review_requested_by from public.odometer_readings where id = tests.rid('q1')), tests.id('rev1'), 'who sent it is recorded');
select is((select review_kind from public.odometer_readings where id = tests.rid('q1')), 'full', 'a later re-validation keeps it in full review (no silent move back)');

-- full review needs the approve permission
select tests.act_as('rev1');
select is(tests.rv('q1', 'pre_shift', 'accept', null, 'Photo checked', 'rv-rev1') like 'OD001:%', true, 'review permission alone cannot decide a full review (OD001)');
select tests.act_as('sup3');
select is(tests.rv('q1', 'pre_shift', 'accept', null, 'Photo checked', 'rv-sup3') like 'OD001:%', true, 'a supervisor of another branch cannot decide it');
select tests.act_as('fab');
select is(tests.rv('q1', 'pre_shift', 'accept', null, 'Photo checked', 'rv-fab') like 'OD002:%', true, 'another company cannot find it');
select tests.act_as('ma');
select is(tests.rv('q1', 'pre_shift', 'accept', null, 'Photo checked', 'rv-ma') like 'OD00_:%', true, 'a maintenance administrator is refused');
select tests.act_as('sup2');
select is(tests.rv('q1', 'pre_shift', 'accept', null, null, 'rv-noreason') like 'OD007:%', true, 'a reason is required');
select is(tests.rv('q1', 'pre_shift', 'accept_value', null, 'The photo shows 4600', 'rv-nokm') like 'OD008:%', true, 'accept_value needs a value');
select is(tests.rv('q1', 'pre_shift', 'accept_value', 10000000, 'The photo shows 4600', 'rv-bigkm') like 'OD008:%', true, 'and a valid one (7 digits)');
select is(tests.rv('q1', 'pre_shift', 'accept_value', 4000, 'The photo shows 4000', 'rv-same') like 'OD009:%', true, 'a value equal to the driver''s is refused (OD009)');
select is(tests.rv('q1', 'pre_shift', 'accept', 4100, 'x', 'rv-extra') like 'OD010:%', true, 'a value with accept is refused');
select is(tests.rv('q1', 'pre_shift', 'bogus', null, 'x', 'rv-bogus') like 'OD010:%', true, 'an unknown decision is refused');
select is(tests.rv('q1', 'pre_shift', 'accept_value', 4600, 'The photo shows 4600', 'rv-ok'), null, 'the approver accepts a different value with a reason');
select tests.reset();
select is((select driver_reading_km from public.odometer_readings where id = tests.rid('q1')), 4000, 'the driver''s value is unchanged');
select is((select accepted_reading_km from public.odometer_readings where id = tests.rid('q1')), 4600, 'the accepted value is stored separately');
select is(tests.st('q1'), 'accepted/full', 'accepted through full review');
select is((select count(*)::int from public.odometer_exceptions where odometer_reading_id = tests.rid('q1') and status = 'resolved' and approval_id is not null and resolution_summary like '%4600%'), 1, 'the exception is resolved with a summary and the approval id');
select is((select a.approval_type || '/' || a.status || '/' || (a.decided_by = tests.id('sup2'))::text || '/' || (a.requested_by = tests.id('u-q1'))::text
             from public.approvals a where a.id = (select approval_id from public.odometer_readings where id = tests.rid('q1'))), 'odometer_exception/approved/true/true', 'one approvals row: decided by the reviewer, requested_by = the reading''s submitter');
select is((select count(*)::int from public.odometer_reading_events where odometer_reading_id = tests.rid('q1') and event_type = 'accepted' and approval_id is not null), 1, 'the accepted event carries the approval');
select tests.act_as('sup2');
select is(tests.rv('q1', 'pre_shift', 'accept', null, 'again', 'rv-again') like 'OD003:%', true, 'a decided reading cannot be decided again (OD003)');
select tests.act_as('sup2');
select tests.reset();
select throws_ok(format('update public.odometer_readings set accepted_reading_km = 1 where id = %L', tests.rid('q1')), '55000', null, 'an accepted reading is immutable: a direct UPDATE of its value is refused');
select throws_ok(format('update public.odometer_readings set reading_status = ''rejected'', review_status = ''rejected'' where id = %L', tests.rid('q1')), '55000', null, 'an accepted reading cannot be rejected');
select throws_ok(format('update public.odometer_readings set driver_reading_km = 1 where id = %L', tests.rid('c3')), '55000', null, 'the driver''s value cannot be edited after submit');
select throws_ok(format('delete from public.odometer_readings where id = %L', tests.rid('q1')), '42501', null, 'no hard delete');
select is((select count(*)::int from pg_indexes where indexname = 'odr_one_accepted_uq' and indexdef like '%(allocation_id, inspection_stage)%reading_status = ''accepted''%'), 1, 'one accepted reading per allocation and stage (partial unique index)');

-- ================================================================ 6. reject; accept in full review; resolved exceptions
select tests.act_as('bm1');
select is(tests.rv('c3', 'pre_shift', 'reject', null, 'The photo shows a different vehicle''s odometer', 'rv-c3'), null, 'a branch manager rejects the c3 reading (full review)');
select tests.reset();
select is(tests.st('c3'), 'rejected/full', 'rejected');
select is((select count(*)::int from public.odometer_exceptions where odometer_reading_id = tests.rid('c3') and status = 'dismissed' and approval_id is not null), 1, 'reject: the exception is dismissed through the approval');
select is((select a.status from public.approvals a where a.id = (select approval_id from public.odometer_readings where id = tests.rid('c3'))), 'rejected', 'and the approval row is rejected');
select is((select accepted_reading_km from public.odometer_readings where id = tests.rid('c3')), null, 'a rejected reading has no accepted value');
-- late, duplicate image
select tests.act_as('u-late');
select is(tests.do_stage('late', 'pre_shift', 5000), null, 'a late inspection (20 days after its planned start) submits');
select tests.act_as('u-e5');
select is(tests.do_stage('e5', 'pre_shift', 6000), null, 'e5 submits');
select tests.act_as('u-dup');
select is(tests.do_stage('dup', 'pre_shift', 7000), null, 'dup submits (same photo file hash as e5)');
select tests.reset();
select is(tests.chk('late', 'pre_shift', 'late_inspection'), 'fail', 'the late flag fails the late check (DEC-17)');
select is(tests.st('late'), 'awaiting_review/full', 'late -> full review');
select is((select severity from public.odometer_exceptions where odometer_reading_id = tests.rid('late') and exception_type = 'late_inspection'), 'low', 'late_inspection is low');
select is(tests.chk('dup', 'pre_shift', 'duplicate_image'), 'fail', 'duplicate_image: the file hash was already used by another odometer photo');
select is(tests.chk('e5', 'pre_shift', 'duplicate_image'), 'pass', 'the first use of the file is not a duplicate');
select is((select severity from public.odometer_exceptions where odometer_reading_id = tests.rid('dup') and exception_type = 'duplicate_image'), 'high', 'duplicate_image is high');
select is(tests.st('dup'), 'awaiting_review/full', 'duplicate -> full review');
select tests.act_as('bm1');
select is(tests.rv('dup', 'pre_shift', 'accept', null, 'The photo is a different image', 'rv-dup'), null, 'accept the driver''s reading in full review');
select tests.reset();
select is((select count(*)::int from public.odometer_exceptions where odometer_reading_id = tests.rid('dup') and status = 'resolved' and approval_id is not null), 1, 'accept: the exception is resolved through the approval');
select is((select accepted_reading_km || '/' || driver_reading_km from public.odometer_readings where id = tests.rid('dup')), '7000/7000', 'accept the driver value: both values are the same number');

-- ================================================================ 7. scenario (b): post lower than pre -> full review -> a different accepted value
select tests.sc('h1', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.act_as('u-h1');
select is(tests.do_stage('h1', 'pre_shift', 2000), null, 'h1 pre 2000 submitted');
select tests.act_as('sup2');
select is(tests.res(tests.qc(jsonb_build_array(tests.qi('h1')), 'qc-h1'), 0), 'accepted', 'h1 pre accepted (quick check)');
select tests.act_as('u-h1');
select is(tests.do_stage('h1', 'post_shift', 1900), null, 'h1 post 1900 submitted (lower than the accepted pre-shift reading)');
select tests.reset();
select is(tests.chk('h1', 'post_shift', 'decreasing_reading'), 'fail', 'decreasing: lower than the latest accepted reading before it (the pre-shift reading, post after pre)');
select is(tests.st('h1', 'post_shift'), 'awaiting_review/full', 'any failed check -> full review');
select is((select severity || '/' || status from public.odometer_exceptions where odometer_reading_id = tests.rid('h1', 'post_shift') and exception_type = 'decreasing_reading'), 'high/open', 'decreasing_reading is high and open');
select tests.act_as('u-h1');
select is(public.my_inspection(tests.al('h1'), 'post_shift') -> 'reading' ->> 'status', 'needs_supervisor', 'the driver sees "Needs a supervisor" (no check names, no reviewer)');
select is(public.my_inspection(tests.al('h1'), 'post_shift') -> 'reading' ? 'validation', false, 'and none of the validation');
select tests.act_as('bm1');
select is((select failed_checks::text from public.list_odometer_review('full') where reading_id = tests.rid('h1', 'post_shift')), '{decreasing_reading}', 'the full-review list shows the failed check');
select is((select driver_name from public.list_odometer_review('full') where reading_id = tests.rid('h1', 'post_shift')), 'Synthetic u-h1', 'driver names are shown to register-visible reviewers');
select is((select previous_accepted_km from public.list_odometer_review('full') where reading_id = tests.rid('h1', 'post_shift')), 2000, 'the previous accepted reading is shown');
select is((select can_decide from public.list_odometer_review('full') where reading_id = tests.rid('h1', 'post_shift')), true, 'a branch manager can decide');
select tests.act_as('rev1');
select is((select driver_name from public.list_odometer_review('full') where reading_id = tests.rid('h1', 'post_shift')), null, 'DEC-41: a reviewer who is not register-visible sees no driver name');
select is((select can_decide from public.list_odometer_review('full') where reading_id = tests.rid('h1', 'post_shift')), false, 'review permission alone: cannot decide a full review (the list says so)');
select tests.reset();
select tests.grant_role('u-h1', 'supervisor', 'A1', 'boot');
select tests.act_as('u-h1');
select is((select can_decide from public.list_odometer_review('full') where reading_id = tests.rid('h1', 'post_shift')), false, 'scenario (c): the allocation''s own driver, given supervisor rights, cannot decide (can_decide false)');
select is((select blocked_reason from public.list_odometer_review('full') where reading_id = tests.rid('h1', 'post_shift')) like 'You cannot check or decide a reading you entered%', true, 'and the reason is shown');
select is(tests.rv('h1', 'post_shift', 'accept', null, 'It is mine', 'rv-h1-self') like 'OD006:%', true, 'scenario (c): a direct call is refused by the database (OD006)');
select is(tests.rv('h1', 'post_shift', 'accept_value', 2100, 'It is mine', 'rv-h1-self2') like 'OD006:%', true, 'scenario (c): also with a different value');
select tests.act_as('sup2');
select is(tests.rv('h1', 'post_shift', 'accept_value', 2005, 'The photo shows 2005', 'rv-h1'), null, 'scenario (b): a supervisor who completed nothing accepts a different value with a reason');
select tests.reset();
select is((select driver_reading_km || '/' || accepted_reading_km from public.odometer_readings where id = tests.rid('h1', 'post_shift')), '1900/2005', 'the driver''s value is still 1900; the accepted value 2005 is stored separately');
select is((select count(*)::int from public.odometer_exceptions where odometer_reading_id = tests.rid('h1', 'post_shift') and status = 'resolved' and approval_id is not null), 1, 'the exception is resolved');
select is((select current_odometer_km from public.vehicles where id = tests.id('v-h1')), 2005, 'the vehicle cache follows the accepted post-shift reading');
select tests.act_as('u-h1');
select is(public.my_inspection(tests.al('h1'), 'post_shift') -> 'reading' ->> 'status', 'accepted', 'the driver sees "Accepted"');
select is(public.my_inspection(tests.al('h1'), 'post_shift')::text ~* '(reviewer|accepted_by|2005)', false, 'and not who decided or the reviewer''s value');
select tests.reset();
select is((select count(*)::int from public.approvals where approval_type = 'odometer_exception'), 4, 'one approvals row per full-review decision');
select tests.act_as('u-q1');
select is((select count(*)::int from public.approvals where approval_type = 'odometer_exception'), 0, 'the driver (the approval''s requester) cannot read the decision record');
select tests.act_as('bm1');
select ok((select count(*)::int from public.approvals where approval_type = 'odometer_exception') >= 1, 'approvers of the branch read it');
select is(tests.err_of(format('select public.decide_approval(%L, ''approved'', null)', (select a.id from public.approvals a where a.entity_id = tests.rid('q1')))) like '55000:%', true, 'decide_approval cannot act on it (already decided)');
select tests.reset();

-- ================================================================ 8. settings: implausible distance once configured; the version used is recorded
select tests.sc('p1', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc('p2', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc('p3', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '8 hours');
select tests.act_as('u-p1');
select tests.do_stage('p1', 'pre_shift', 100);
select tests.act_as('u-p2');
select tests.do_stage('p2', 'pre_shift', 100);
select tests.act_as('u-p3');
select tests.do_stage('p3', 'pre_shift', 100);
select tests.act_as('sup2');
select tests.qc(jsonb_build_array(tests.qi('p1'), tests.qi('p3')), 'qc-p13');
select tests.act_as('fa');
select is(public.set_validation_settings(null, 500, null, 0, 5, 10080, 10080, 7, 'Tests: max 500 km per allocation', tests.csid('s-max')) is not null, true, 'the settings are changed (version 3)');
select tests.act_as('u-p1');
select tests.do_stage('p1', 'post_shift', 700);
select tests.act_as('u-p2');
select tests.do_stage('p2', 'post_shift', 700);
select tests.act_as('u-p3');
select tests.do_stage('p3', 'post_shift', 400);
select tests.reset();
select is(tests.chk('p1', 'post_shift', 'implausible_distance'), 'fail', 'implausible_distance fails once configured (600 km > 500)');
select is((select validation -> 'checks' -> 1 -> 'values' ->> 'pre_basis' from public.odometer_readings where id = tests.rid('p1', 'post_shift')), 'accepted', 'the pre reading''s accepted value is used when it is accepted');
select is((select validation -> 'checks' -> 1 -> 'values' ->> 'pre_basis' from public.odometer_readings where id = tests.rid('p2', 'post_shift')), 'driver', 'else the pre reading''s driver value (and the result says which)');
select is(tests.chk('p2', 'post_shift', 'implausible_distance'), 'fail', 'with the driver value as basis it fails too');
select is(tests.chk('p3', 'post_shift', 'implausible_distance'), 'pass', 'a distance within the maximum passes');
select is(tests.st('p3', 'post_shift'), 'awaiting_review/quick_check', 'and goes to the quick check');
select is((select severity from public.odometer_exceptions where odometer_reading_id = tests.rid('p1', 'post_shift') and exception_type = 'implausible_distance'), 'medium', 'implausible_distance is medium');
select is((select validation_settings_version from public.odometer_readings where id = tests.rid('p1', 'post_shift')), 3, 'the readings validated after the change record settings version 3');
select is((select validation_settings_version from public.odometer_readings where id = tests.rid('p1')), 2, 'a reading validated before the change keeps version 2');

-- ================================================================ 9. chronology, not value
select tests.sc('f1', 'A1', 'pre_inspection_pending', now() - interval '6 days', now() - interval '6 days' + interval '8 hours');
select tests.alloc('f2', 'f1', 'A1', now() - interval '5 days', now() - interval '5 days' + interval '8 hours');
select tests.alloc('f3', 'f1', 'A1', now() - interval '4 days', now() - interval '4 days' + interval '8 hours');
select tests.act_as('u-f1');
select tests.do_stage('f1', 'pre_shift', 5000);
select tests.act_as('u-f3');
select tests.do_stage('f3', 'pre_shift', 5200);
select tests.act_as('sup2');
select tests.qc(jsonb_build_array(tests.qi('f1')), 'qc-f1');
select tests.qc(jsonb_build_array(tests.qi('f3')), 'qc-f3');
select tests.reset();
select is((select current_odometer_km || '/' || (current_odometer_reading_id = tests.rid('f3'))::text from public.vehicles where id = tests.id('v-f1')), '5200/true', 'f3 (the latest allocation) is the vehicle''s current reading');
select tests.act_as('u-f2');
select tests.do_stage('f2', 'pre_shift', 5100);
select tests.reset();
select is(tests.chk('f2', 'pre_shift', 'decreasing_reading'), 'pass', 'chronology, not value: 5100 passes against the earlier allocation''s 5000, although a LATER allocation holds 5200');
select tests.act_as('sup2');
select tests.qc(jsonb_build_array(tests.qi('f2')), 'qc-f2');
select tests.reset();
select is(tests.st('f2'), 'accepted/quick_check', 'f2 accepted');
select is((select current_odometer_km || '/' || (current_odometer_reading_id = tests.rid('f3'))::text from public.vehicles where id = tests.id('v-f1')), '5200/true', 'accepting an earlier allocation''s reading later does not move the vehicle cache');

-- ================================================================ 10. DEC-44: nothing is auto-accepted before OCR
select is(public.odometer_auto_accept_allowed(tests.rid('f1')), false, 'odometer_auto_accept_allowed is false (no OCR result)');
select is(public.odometer_auto_accept_allowed(tests.rid('q1')), false, 'and false for every other reading');
select tests.act_as('fa');
select public.set_validation_settings('bakkie', null, 0.8, 0, 5, 30, 60, 7, 'Tests: a confidence threshold exists', tests.csid('s-conf'));
select tests.reset();
select is(public.odometer_auto_accept_allowed(tests.rid('f1')), false, 'still false when a confidence threshold is configured: there is no OCR result');
select is((select count(*)::int from public.odometer_readings where acceptance_method = 'auto_rule'), 0, 'no reading was accepted automatically');
select is((select count(*)::int from public.odometer_readings where ocr_reading_km is not null or ocr_result_id is not null), 0, 'no reading carries an OCR value');
select throws_ok(format('update public.odometer_readings set ocr_reading_km = 1000 where id = %L', tests.rid('late')), '23514', null, 'OCR columns cannot be filled in this slice');

-- ================================================================ 11. RLS
select tests.reset();
select tests.act_as('u-b1');
select tests.do_stage_b('b1', 'pre_shift', 900);
select tests.reset();
create temp table tot (k text primary key, n int); grant all on tot to public;
insert into tot select 'a', count(*)::int from public.odometer_readings where company_id = tests.id('coA');
insert into tot select 'b', count(*)::int from public.odometer_readings where company_id = tests.id('coB');
insert into tot select 'ex', count(*)::int from public.odometer_exceptions where company_id = tests.id('coA');
insert into tot select 'ev', count(*)::int from public.odometer_reading_events where company_id = tests.id('coA');
select tests.act_as('u-e1');
select is((select count(*)::int from public.odometer_readings), 1, 'RLS: a driver sees only their own reading');
select is((select count(*)::int from public.odometer_exceptions), 0, 'a driver sees no exceptions');
select is((select count(*)::int from public.odometer_reading_events), 0, 'a driver sees no events');
select throws_ok('select validation from public.odometer_readings', '42501', null, 'a driver cannot select the reviewer fields (column grants)');
select throws_ok('select accepted_by from public.odometer_readings', '42501', null, 'nor who accepted');
select tests.act_as('sup1');
select is((select count(*)::int from public.odometer_readings), (select n from tot where k = 'a'), 'a supervisor reads their branch''s readings (all of company A here)');
select is((select count(*)::int from public.odometer_exceptions), (select n from tot where k = 'ex'), 'and its exceptions');
select is((select count(*)::int from public.odometer_reading_events), (select n from tot where k = 'ev'), 'and its events');
select tests.act_as('sup3');
select is((select count(*)::int from public.odometer_readings), 0, 'RLS: a supervisor of another branch sees nothing');
select is((select count(*)::int from public.odometer_exceptions) + (select count(*)::int from public.odometer_reading_events), 0, 'nor its exceptions or events');
select tests.act_as('supb');
select is((select count(*)::int from public.odometer_readings), (select n from tot where k = 'b'), 'a company B supervisor sees only company B''s readings');
select tests.act_as('fab');
select is((select count(*)::int from public.odometer_readings where company_id = tests.id('coA')), 0, 'RLS: another company''s fleet administrator sees none of company A');
select tests.act_as('fa');
select is((select count(*)::int from public.odometer_readings), (select n from tot where k = 'a'), 'a fleet administrator reads the company');
select tests.act_as('sm');
select is((select count(*)::int from public.odometer_readings), (select n from tot where k = 'a'), 'senior management (reports.view, register-visible) reads readings');
select tests.act_as('ma');
select is((select count(*)::int from public.odometer_readings), 0, 'RLS: a maintenance administrator sees no readings');
select is((select count(*)::int from public.odometer_exceptions), 0, 'nor exceptions');
select is((select count(*)::int from public.list_odometer_review('quick_check')) + (select count(*)::int from public.list_odometer_review('full')), 0, 'and the review lists are empty for them');
select tests.act_as('sysadm');
select is((select count(*)::int from public.odometer_readings), 0, 'RLS: a system administrator sees no readings');
select is((select count(*)::int from public.odometer_exceptions) + (select count(*)::int from public.odometer_reading_events), 0, 'nor exceptions or events');
select is((select count(*)::int from public.odometer_segments), 0, 'nor segments');
select is((select count(*)::int from public.list_odometer_review('full')), 0, 'nor the review list');
select tests.act_as('sup1');
select is(tests.sqlstate_of('insert into public.odometer_readings (company_id) values (gen_random_uuid())'), '42501', 'no client INSERT on readings');
select is(tests.sqlstate_of('update public.odometer_readings set driver_reading_km = 1'), '42501', 'no client UPDATE on readings');
select is(tests.sqlstate_of('delete from public.odometer_readings'), '42501', 'no client DELETE on readings');
select is(tests.sqlstate_of('insert into public.odometer_exceptions (company_id) values (gen_random_uuid())'), '42501', 'no client INSERT on exceptions');
select is(tests.sqlstate_of('update public.odometer_exceptions set status = ''dismissed'''), '42501', 'no client UPDATE on exceptions');
select is(tests.sqlstate_of('delete from public.odometer_reading_events'), '42501', 'no client DELETE on events');
select is(tests.sqlstate_of('select * from public.odometer_requests'), '42501', 'the ledger is not readable by clients');
select tests.reset();
select is(tests.sqlstate_of(format('delete from public.odometer_exceptions where odometer_reading_id = %L', tests.rid('c3'))), '42501', 'no hard delete of exceptions (even for the owner)');
select is(tests.sqlstate_of(format('update public.odometer_reading_events set reason = ''x'' where odometer_reading_id = %L', tests.rid('c3'))), '42501', 'events are append-only');
select is(tests.sqlstate_of('delete from public.odometer_segments'), '42501', 'no hard delete of segments');
select is(tests.sqlstate_of('delete from public.odometer_validation_settings'), '42501', 'no hard delete of settings');
select is(tests.sqlstate_of(format('update public.odometer_exceptions set status = ''dismissed'', resolved_at = now(), resolution_summary = ''x'' where odometer_reading_id = %L and status = ''open''', tests.rid('late'))), '42501', 'an exception cannot be resolved outside the review functions (direct UPDATE refused)');
select is((select count(*)::int from public.audit_logs where entity_type = 'odometer_readings'), (select count(*)::int from public.audit_logs where entity_type = 'odometer_readings' and company_id is not null), 'audit_row_change records the readings (with their company)');
select ok((select count(*) from public.audit_logs where entity_type = 'odometer_exceptions') > 0 and (select count(*) from public.audit_logs where entity_type = 'odometer_reading_events') > 0, 'audit rows exist for exceptions and events');

-- every FK in public has a covering index in FK column order (this slice added many)
create function tests.uncovered_fks() returns setof text language sql as $$
  select c.conrelid::regclass::text || '.' || c.conname
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace and n.nspname = 'public'
   where c.contype = 'f'
     and not exists (
       select 1 from pg_index i
        where i.indrelid = c.conrelid and i.indisvalid and i.indnkeyatts >= cardinality(c.conkey)
          and (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] = c.conkey
          and (i.indpred is null
               or btrim(regexp_replace(
                    regexp_replace(pg_get_expr(i.indpred, i.indrelid),
                      '(' || (select string_agg(a.attname::text, '|') from pg_attribute a
                               where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) || ') IS NOT NULL', '', 'g'),
                    '[() ]|AND', '', 'g')) = ''))
   order by 1
$$;
select is((select count(*)::int from tests.uncovered_fks()), 0, 'every FK in public has a covering index (FK-coverage, incl. the 5A tables)');
select * from finish();
rollback;
