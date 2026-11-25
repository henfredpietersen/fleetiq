-- Slice 4A pgTAP: inspections — begin, answers, photos, submit, void, transition rules d/e, RLS (migrations 037-039;
-- PRD v1.15 §5.5–§5.8.3; DEC-04, DEC-06, DEC-17, DEC-24). Synthetic data only; everything rolls back.
-- Scenario label L: driver profile u-L (driver d-u-L), vehicle v-L, shift sh-L, allocation al-L, odometer files fo-L-pre / fo-L-post.
begin;
create extension if not exists pgtap with schema extensions;
select plan(261);

create schema tests;
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
  select tests.id('f-' || n), p.company_id, tests.id(branch), 'evidence', 'test/' || n, md5(n) || md5(n), 'image/jpeg', 1000, src, true, p.id, purpose
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
  perform public.record_driver_reading(v, 1000, null, false, gen_random_uuid());
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
  perform public.record_driver_reading(tests.ins(label, 'post_shift'), 1000, null, false, gen_random_uuid());
  perform public.confirm_known_damage_reviewed(tests.ins(label, 'post_shift'), tests.csid(label || 'restk'));
end $$;
create function tests.n(q text) returns integer language plpgsql as $$
declare r integer; begin execute q into r; return r; end $$;

-- ---------------------------------------------------------------- fixtures
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('fa', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'),
       tests.mk_user('bm1', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('fab', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sup2', 'supervisor', 'A2', 'boot'),
       tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'),
       tests.grant_role('sm', 'senior_management', null, 'boot'), tests.grant_role('sa', 'system_admin', null, 'boot'),
       tests.grant_role('fab', 'fleet_admin', null, 'bootb');
select public.seed_starter_inspection_template(tests.id('coA')), public.seed_starter_inspection_template(tests.id('coB'));

select tests.sc('p1', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc('p2', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc('plan', 'A1', 'planned', now() + interval '30 minutes', now() + interval '9 hours');
select tests.sc('inu', 'A1', 'in_use', now() - interval '2 hours', now() + interval '9 hours');
select tests.sc('can', 'A1', 'cancelled', now() - interval '2 hours', now() + interval '9 hours');
select tests.sc('b1', 'B1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.grant_role('u-p2', 'supervisor', 'A1', 'boot');    -- p2's driver also holds allocation.manage (DEC-24 void test)

-- ================================================================ 1. begin_inspection
select tests.act_as('u-p2');
select is(tests.err_of(format('select public.begin_inspection(%L, ''pre_shift'', null, false, %L)', tests.al('p1'), tests.csid('x1'))) like '42501:%', true, 'begin: another driver (not the allocation''s) is refused');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''pre_shift'', null, false, %L)', tests.al('p1'), tests.csid('x2'))), '42501', 'begin: a supervisor cannot begin a driver''s inspection (on-behalf is slice 4C)');
select tests.act_as('u-b1');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''pre_shift'', null, false, %L)', tests.al('p1'), tests.csid('x3'))), 'P0002', 'begin: another company''s allocation is not found');
select tests.act_as('u-plan');
select matches(tests.err_of(format('select public.begin_inspection(%L, ''pre_shift'', null, false, %L)', tests.al('plan'), tests.csid('x4'))), '^55000:.*started.*planned', 'begin: a planned (not started) allocation is refused with a clear message');
select tests.act_as('u-can');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''pre_shift'', null, false, %L)', tests.al('can'), tests.csid('x5'))), '55000', 'begin: a cancelled allocation is refused');
select tests.act_as('u-inu');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''pre_shift'', null, false, %L)', tests.al('inu'), tests.csid('x6'))), '55000', 'begin pre-shift: an allocation already in use is refused');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''bogus'', null, false, %L)', tests.al('inu'), tests.csid('x7'))), '22023', 'begin: unknown stage refused');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''pre_shift'', null, false, null)', tests.al('inu'))), '22023', 'begin: client_submission_id is required');
select tests.act_as('u-p1');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''post_shift'', null, false, %L)', tests.al('p1'), tests.csid('x8'))), '55000', 'begin post-shift: a pre_inspection_pending allocation is refused');
create temp table kv (k text primary key, v uuid); grant all on kv to public;
insert into kv select 'p1', public.begin_inspection(tests.al('p1'), 'pre_shift', '2026-01-01 05:00+00', true, tests.csid('p1b'));
select tests.reset();
select is((select count(*)::int from public.inspections where allocation_id = tests.al('p1')), 1, 'begin: a draft inspection exists');
select is((select status from public.inspections where id = (select v from kv where k = 'p1')), 'draft', '... status draft');
select is((select submitted_by from public.inspections where id = (select v from kv where k = 'p1')), tests.id('u-p1'), '... completed by the driver');
select is((select completed_by_role from public.inspections where id = (select v from kv where k = 'p1')), 'driver', '... completed_by_role driver');
select is((select captured_offline from public.inspections where id = (select v from kv where k = 'p1')), true, '... captured_offline stored');
select is((select device_started_at from public.inspections where id = (select v from kv where k = 'p1')), '2026-01-01 05:00+00'::timestamptz, '... the device start time is stored (untrusted) beside the server start');
select is((select started_at from public.inspections where id = (select v from kv where k = 'p1')), now(), '... started_at is the server time');
select is((select template_id from public.inspections where id = (select v from kv where k = 'p1')), (select id from public.inspection_templates where company_id = tests.id('coA') and vehicle_category is null), '... the starter template is used');
select isnt((select first_used_at from public.inspection_templates where company_id = tests.id('coA') and vehicle_category is null), null, '... and its first_used_at is now set');
select tests.act_as('u-p1');
select is(public.begin_inspection(tests.al('p1'), 'pre_shift', null, false, tests.csid('p1b')), (select v from kv where k = 'p1'), 'idempotent retry (same client_submission_id) returns the same inspection');
select is(public.begin_inspection(tests.al('p1'), 'pre_shift', null, false, tests.csid('p1b-other')), (select v from kv where k = 'p1'), 'a second begin with a new id returns the existing draft');
select tests.reset();
select is((select count(*)::int from public.inspections where allocation_id = tests.al('p1')), 1, '... never a second non-void inspection per stage');
select tests.act_as('u-p1');
select matches(tests.err_of(format('select public.begin_inspection(%L, ''post_shift'', null, false, %L)', tests.al('p1'), tests.csid('p1b'))), '^22023:.*already used for a different request', 'the same client_submission_id for a different request is refused');
select tests.reset();


-- ================================================================ 2. save_inspection_responses
select tests.mk_file('ph-insp', 'u-p1', 'A1', 'inspection'), tests.mk_file('ph-dmg', 'u-p1', 'A1', 'damage'), tests.mk_file('ph-gal', 'u-p1', 'A1', 'inspection', 'gallery'),
       tests.mk_file('ph-odo', 'u-p1', 'A1', 'odometer'), tests.mk_file('ph-insp2', 'u-p1', 'A1', 'inspection'), tests.mk_file('ph-insp3', 'u-p1', 'A1', 'inspection'),
       tests.mk_file('ph-insp4', 'u-p1', 'A1', 'inspection'), tests.mk_file('ph-insp5', 'u-p1', 'A1', 'inspection');
select tests.act_as('u-p1');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'maybe')), tests.csid('r1'))), '22023', 'responses: an invalid ok/defect value is refused');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('fuel_level', '1/3')), tests.csid('r2'))), '22023', 'responses: an invalid fuel level is refused');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('fuel_level', 'ok')), tests.csid('r3'))), '22023', 'responses: an ok/defect value on a fuel item is refused');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('tyres', '1/2')), tests.csid('r4'))), '22023', 'responses: a fuel value on an ok/defect item is refused');
select matches(tests.err_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'na')), tests.csid('r5'))), '^22023:.*N/A.*Tyres', 'responses: N/A is refused where the item does not allow it, naming the question');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('post_incident', 'no')), tests.csid('r6'))), '22023', 'responses: a post-shift item on a pre-shift inspection is refused');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(jsonb_build_object('template_item_id', tests.item('tyres', 'coB'), 'value', 'ok')), tests.csid('r7'))), '22023', 'responses: an item from another company''s template is refused');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(jsonb_build_object('template_item_id', gen_random_uuid(), 'value', 'ok')), tests.csid('r8'))), '22023', 'responses: an unknown question is refused');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), '{"a":1}'::jsonb, tests.csid('r9'))), '22023', 'responses: the payload must be a list');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), '[{"template_item_id":"nope","value":"ok"}]'::jsonb, tests.csid('r10'))), '22023', 'responses: a malformed question id is refused');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), '[{"template_item_id":null}]'::jsonb, tests.csid('r11'))), '22023', 'responses: an answer without a value is refused');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'defect', repeat('x', 1001))), tests.csid('r12'))), '23514', 'responses: a comment over 1000 characters is refused');
select is((select count(*)::int from public.inspection_responses where inspection_id = tests.ins('p1')), 0, '... nothing was saved by any refused call');
select tests.act_as('u-p2');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'ok')), tests.csid('r13'))), '42501', 'responses: another driver cannot answer');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'ok')), tests.csid('r14'))), '42501', 'responses: a supervisor cannot answer a driver''s inspection (on-behalf is slice 4C)');
select tests.act_as('u-p1');
select is(public.save_inspection_responses(tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'ok'), tests.ans('warning_triangle', 'na'), tests.ans('fuel_level', '3/4')), null, tests.csid('r15')), tests.ins('p1'), 'responses: valid answers are saved (N/A on a triangle, 3/4 fuel)');
select is(public.save_inspection_responses(tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'ok'), tests.ans('warning_triangle', 'na'), tests.ans('fuel_level', '3/4')), null, tests.csid('r15')), tests.ins('p1'), 'responses: the retry is idempotent');
select tests.reset();
select is((select count(*)::int from public.inspection_responses where inspection_id = tests.ins('p1')), 3, '... three rows, not six');
select tests.act_as('u-p1');
select is(public.save_inspection_responses(tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'defect', 'Cut on the left front sidewall')), null, tests.csid('r16')), tests.ins('p1'), 'responses: an answer can be changed while the inspection is a draft');
select tests.reset();
select is((select response_value || '/' || comment from public.inspection_responses where inspection_id = tests.ins('p1') and template_item_id = tests.item('tyres')), 'defect/Cut on the left front sidewall', '... the same row is updated');
select is((select count(*)::int from public.inspection_responses where inspection_id = tests.ins('p1')), 3, '... still three rows');

-- ================================================================ 3. submit refusals (p1 is still incomplete)
select tests.act_as('u-p1');
select matches(tests.submit('p1'), '^IN001:.*onfirm.*T4AP1', 'submit: the vehicle is not confirmed -> IN001, naming the registration');
select is(public.save_inspection_responses(tests.ins('p1'), '[]'::jsonb, true, tests.csid('r17')), tests.ins('p1'), 'the driver confirms the vehicle');
select public.confirm_known_damage_reviewed(tests.ins('p1'), tests.csid('r17k'));
select matches(tests.submit('p1', 'pre_shift', 'sx2'), '^IN002:.*"Wheel nuts present and tight" is not answered \(17 still to answer\)', 'submit: required items missing -> IN002, naming the first and the count');
select is(public.save_inspection_responses(tests.ins('p1'), tests.answers('pre_shift') - 0, null, tests.csid('r18')), tests.ins('p1'), 'all items answered (as fine)...');
select is(public.save_inspection_responses(tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'defect')), null, tests.csid('r19')), tests.ins('p1'), '... but Tyres is a Defect without a comment');
select matches(tests.submit('p1', 'pre_shift', 'sx3'), '^IN003:.*"Tyres: tread, pressure, cuts or bulges \(including the spare\)" needs a comment', 'submit: a Defect without a comment -> IN003');
select is(public.save_inspection_responses(tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'defect', 'Cut on the left front sidewall')), null, tests.csid('r20')), tests.ins('p1'), 'the comment is added...');
select matches(tests.submit('p1', 'pre_shift', 'sx4'), '^IN004:.*needs at least one photo', 'submit: ... but a Defect without a photo -> IN004');

-- ================================================================ 4. condition / damage photos (DEC-04: in-app camera only)
select is(tests.sqlstate_of(format('select public.attach_inspection_photo(%L, %L, ''condition'', %L, %L)', tests.ins('p1'), tests.id('f-ph-gal'), tests.item('tyres'), tests.csid('ph1'))), 'IN010', 'photo: a gallery image is refused (DEC-04)');
select matches(tests.err_of(format('select public.attach_inspection_photo(%L, %L, ''condition'', %L, %L)', tests.ins('p1'), tests.id('f-ph-gal'), tests.item('tyres'), tests.csid('ph1b'))), 'in-app camera', '... with a clear message');
select is(tests.sqlstate_of(format('select public.attach_inspection_photo(%L, %L, ''condition'', %L, %L)', tests.ins('p1'), tests.id('f-ph-odo'), tests.item('tyres'), tests.csid('ph2'))), 'IN011', 'photo: an odometer-purpose file is not an inspection photo');
select is(tests.sqlstate_of(format('select public.attach_inspection_photo(%L, %L, ''bogus'', %L, %L)', tests.ins('p1'), tests.id('f-ph-insp'), tests.item('tyres'), tests.csid('ph3'))), '22023', 'photo: an unknown category is refused');
select is(tests.sqlstate_of(format('select public.attach_inspection_photo(%L, %L, ''condition'', %L, %L)', tests.ins('p1'), tests.id('f-ph-insp'), tests.item('post_incident'), tests.csid('ph4'))), '22023', 'photo: a question of the other stage is refused');
select is(tests.sqlstate_of(format('select public.attach_inspection_photo(%L, %L, ''condition'', %L, %L)', tests.ins('p1'), gen_random_uuid(), tests.item('tyres'), tests.csid('ph5'))), 'IN013', 'photo: an unknown file is refused');
select tests.act_as('u-p2');
select is(tests.sqlstate_of(format('select public.attach_inspection_photo(%L, %L, ''condition'', %L, %L)', tests.ins('p1'), tests.id('f-ph-insp'), tests.item('tyres'), tests.csid('ph6'))), '42501', 'photo: another driver cannot attach to this inspection');
select tests.act_as('u-p1');
select is(public.attach_inspection_photo(tests.ins('p1'), tests.id('f-ph-insp'), 'condition', tests.item('tyres'), tests.csid('ph7')) is not null, true, 'photo: an in-app camera inspection photo is attached, linked to the Tyres item');
select is(public.attach_inspection_photo(tests.ins('p1'), tests.id('f-ph-insp'), 'condition', tests.item('tyres'), tests.csid('ph7')) is not null, true, 'photo: the retry is idempotent');
select is(public.attach_inspection_photo(tests.ins('p1'), tests.id('f-ph-dmg'), 'damage', null, tests.csid('ph8')) is not null, true, 'photo: a damage-purpose file is accepted too (an unlinked damage photo)');
select tests.reset();
select is((select count(*)::int from public.inspection_photos where inspection_id = tests.ins('p1')), 2, '... two photo rows');
select tests.act_as('u-p1');
select is(tests.sqlstate_of(format('select public.attach_inspection_photo(%L, %L, ''other'', null, %L)', tests.ins('p1'), tests.id('f-ph-insp'), tests.csid('ph9'))), 'IN014', 'photo: a photo already attached cannot be attached twice (under a new request id)');
select matches(tests.submit('p1', 'pre_shift', 'sx5'), '^IN006:.*odometer photo is required', 'submit: no odometer photo -> IN006 (no bypass exists in this slice)');

-- ================================================================ 5. odometer photo: DEC-04 and ownership
select tests.reset();
select tests.mk_file('o-gal', 'u-p1', 'A1', 'odometer', 'gallery'), tests.mk_file('o-upl', 'u-p1', 'A1', 'odometer', 'file_upload'), tests.mk_file('o-imp', 'u-p1', 'A1', 'odometer', 'import'),
       tests.mk_file('o-oth', 'u-p2', 'A1', 'odometer'), tests.mk_file('o-br', 'u-p1', 'A2', 'odometer'), tests.mk_file('o-co', 'u-b1', 'B1', 'odometer'),
       tests.mk_file('o-wp', 'u-p1', 'A1', 'inspection'), tests.mk_file('o-re', 'u-p1', 'A1', 'odometer'), tests.mk_file('o-re2', 'u-p1', 'A1', 'odometer');
select tests.act_as('u-p1');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-o-gal'), tests.csid('o1'))), 'IN010', 'odometer: gallery is refused (DEC-04)');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-o-upl'), tests.csid('o2'))), 'IN010', 'odometer: file_upload is refused (DEC-04)');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-o-imp'), tests.csid('o3'))), 'IN010', 'odometer: import is refused (DEC-04)');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-o-oth'), tests.csid('o4'))), 'IN012', 'odometer: a photo uploaded by someone else is refused');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-o-br'), tests.csid('o5'))), 'IN013', 'odometer: a photo from another branch is refused');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-o-co'), tests.csid('o6'))), 'IN013', 'odometer: another company''s photo is not even found');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-o-wp'), tests.csid('o7'))), 'IN011', 'odometer: a photo of the wrong purpose is refused');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), gen_random_uuid(), tests.csid('o8'))), 'IN013', 'odometer: an unregistered file is refused');
select tests.act_as('u-p2');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-o-oth'), tests.csid('o9'))), '42501', 'odometer: another driver cannot attach to this inspection');
select tests.act_as('u-p1');
select is(public.attach_odometer_photo(tests.ins('p1'), tests.id('f-fo-p1-pre'), tests.csid('o10')) is not null, true, 'odometer: the in-app camera photo is attached');
select is(public.attach_odometer_photo(tests.ins('p1'), tests.id('f-fo-p1-pre'), tests.csid('o10')) is not null, true, 'odometer: the retry is idempotent');
select tests.reset();
select is((select count(*)::int from public.odometer_evidence where inspection_id = tests.ins('p1')), 1, '... one odometer row');
select is((select processing_status from public.odometer_evidence where inspection_id = tests.ins('p1')), 'not_required', '... processing_status not_required (OCR is Phase 6)');
select tests.act_as('u-p1');
select is(public.attach_odometer_photo(tests.ins('p1'), tests.id('f-o-re'), tests.csid('o11')) is not null, true, 'odometer: a retake is attached');
select tests.reset();
select is((select count(*)::int from public.odometer_evidence where inspection_id = tests.ins('p1')), 2, 'retake: both photos are kept');
select is((select count(*)::int from public.odometer_evidence where inspection_id = tests.ins('p1') and is_current), 1, '... exactly one is current');
select is((select evidence_file_id from public.odometer_evidence where inspection_id = tests.ins('p1') and is_current), tests.id('f-o-re'), '... the newest');
select is((select retake_of_id from public.odometer_evidence where inspection_id = tests.ins('p1') and is_current), (select id from public.odometer_evidence where inspection_id = tests.ins('p1') and not is_current), '... and it links back to the photo it replaced');
select tests.act_as('u-p1');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-fo-p1-pre'), tests.csid('o12'))), 'IN014', 'odometer: a photo already used (the replaced one) cannot be attached again');
select tests.reset();
select is(tests.sqlstate_of($$update public.odometer_evidence set evidence_file_id = tests.id('f-o-re2') where inspection_id = tests.ins('p1') and is_current$$), '23514', 'an odometer photo row cannot be re-pointed at another file (only retired by a retake)');
select is(tests.sqlstate_of($$update public.odometer_evidence set is_current = true where inspection_id = tests.ins('p1') and not is_current$$), '23514', '... and a replaced photo cannot become current again');
select is(tests.sqlstate_of($$insert into public.odometer_evidence (company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, inspection_id, inspection_stage, evidence_file_id)
  select company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, id, inspection_stage, tests.id('f-o-re2') from public.inspections where id = tests.ins('p1')$$), '23505', 'one current odometer photo per inspection (partial unique index)');


-- ================================================================ 6. submit: success, flags, allocation in_use + started_at
select tests.act_as('u-p1');
select public.record_driver_reading(tests.ins('p1'), 1000, null, false, gen_random_uuid());   -- 5A: the driver's reading (IN015)
select is(tests.submit('p1', 'pre_shift', 's-ok'), null, 'submit: succeeds once everything is in place (a late/safety defect never blocks)');
select tests.reset();
select is((select status from public.inspections where id = tests.ins('p1')), 'submitted', '... status submitted');
select is((select submitted_at from public.inspections where id = tests.ins('p1')), now(), '... submitted_at is the server time');
select is((select safety_defect_flag from public.inspections where id = tests.ins('p1')), true, '... safety_defect_flag: Tyres is a safety-critical item');
select is((select late_flag from public.inspections where id = tests.ins('p1')), false, '... late_flag false (10 minutes after the shift start)');
select is((select captured_offline from public.inspections where id = tests.ins('p1')), true, '... captured_offline stays visible (set when begun offline)');
select is((select status from public.vehicle_allocations where id = tests.al('p1')), 'in_use', '... the allocation moved to in_use');
select is((select started_at from public.vehicle_allocations where id = tests.al('p1')), (select submitted_at from public.inspections where id = tests.ins('p1')), '... started_at = the inspection''s submitted_at');
select is((select released_at from public.vehicle_allocations where id = tests.al('p1')), null, '... released_at stays unset (Phase 5)');
select is((select count(*)::int from public.allocation_events where allocation_id = tests.al('p1') and new_value ->> 'status' = 'in_use' and metadata ? 'inspection_id'), 1, '... one status_changed event, carrying the inspection id');
select tests.act_as('u-p1');
select is((select out_replayed from public.submit_inspection(tests.ins('p1'), null, false, tests.csid('s-ok'))), true, 'submit: the retry (same client_submission_id) is a replay and changes nothing');
select matches(tests.submit('p1', 'pre_shift', 's-other'), '^55000:.*already submitted', 'submit: a second submit with a new id is refused');
select tests.reset();
select is((select count(*)::int from public.allocation_events where allocation_id = tests.al('p1') and new_value ->> 'status' = 'in_use'), 1, '... still exactly one in_use event');
select tests.act_as('u-p1');
select matches(tests.err_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('p1'), jsonb_build_array(tests.ans('tyres', 'ok')), tests.csid('after1'))), '^55000:.*submitted.*can no longer be changed', 'edits after submit are refused (answers)');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', tests.ins('p1'), tests.id('f-o-re2'), tests.csid('after2'))), '55000', 'edits after submit are refused (odometer photo)');
select is(tests.sqlstate_of(format('select public.attach_inspection_photo(%L, %L, ''other'', null, %L)', tests.ins('p1'), tests.id('f-ph-insp2'), tests.csid('after3'))), '55000', 'edits after submit are refused (condition photo)');
select tests.reset();
select is(tests.sqlstate_of($$update public.inspection_responses set response_value = 'ok' where inspection_id = tests.ins('p1') and template_item_id = tests.item('tyres')$$), '55000', 'a submitted inspection''s answers are immutable even for the table owner (trigger)');
select is(tests.sqlstate_of($$update public.inspections set vehicle_confirmed = false where id = tests.ins('p1')$$), '55000', 'a submitted inspection is immutable (trigger): only voiding is possible');
select is(tests.sqlstate_of($$update public.inspections set late_flag = true where id = tests.ins('p1')$$), '55000', '... including its flags');
select is(tests.sqlstate_of($$update public.inspections set status = 'draft' where id = tests.ins('p1')$$), '55000', '... and it cannot go back to draft');
select is(tests.sqlstate_of($$update public.inspections set allocation_id = tests.al('p2') where id = tests.ins('p1')$$), '23514', 'identity columns are immutable');

-- ================================================================ 7. late flag at the window edges (DEC-17) and non-safety defects
select tests.sc('l29', 'A1', 'pre_inspection_pending', now() - interval '29 minutes', now() + interval '9 hours');
select tests.sc('l30', 'A1', 'pre_inspection_pending', now() - interval '30 minutes', now() + interval '9 hours');
select tests.sc('l31', 'A1', 'pre_inspection_pending', now() - interval '31 minutes', now() + interval '9 hours');
select tests.sc('mir', 'A1', 'pre_inspection_pending', now() - interval '5 minutes', now() + interval '9 hours');
select tests.mk_file('mir-ph', 'u-mir', 'A1', 'inspection');
select tests.act_as('u-l29'); select tests.prep('l29'); select is(tests.submit('l29'), null, 'pre-shift submit 29 minutes after the shift start');
select tests.act_as('u-l30'); select tests.prep('l30'); select is(tests.submit('l30'), null, 'pre-shift submit exactly 30 minutes after the shift start');
select tests.act_as('u-l31'); select tests.prep('l31'); select is(tests.submit('l31'), null, 'pre-shift submit 31 minutes after the shift start (late never blocks)');
select tests.reset();
select is((select late_flag from public.inspections where id = tests.ins('l29')), false, '29 min: not late');
select is((select late_flag from public.inspections where id = tests.ins('l30')), false, '30 min: not late (the window is "more than 30 minutes")');
select is((select late_flag from public.inspections where id = tests.ins('l31')), true, '31 min: late');
select is((select status from public.vehicle_allocations where id = tests.al('l31')), 'in_use', '... a late inspection still starts the allocation');
select is((select safety_defect_flag from public.inspections where id = tests.ins('l31')), false, 'no defects: safety_defect_flag false');
-- a non-safety-critical defect (mirrors) does not set the safety flag
select tests.act_as('u-mir');
select tests.prep('mir');
select public.save_inspection_responses(tests.ins('mir'), jsonb_build_array(tests.ans('mirrors', 'defect', 'Left mirror cracked')), null, tests.csid('mir-d'));
select public.attach_inspection_photo(tests.ins('mir'), tests.id('f-mir-ph'), 'damage', tests.item('mirrors'), tests.csid('mir-p'));
select is(tests.submit('mir'), null, 'a Defect on a standard item, with a comment and a photo, submits');
select tests.reset();
select is((select safety_defect_flag from public.inspections where id = tests.ins('mir')), false, '... safety_defect_flag stays false for a standard defect');
select is((select count(*)::int from public.inspection_photos where inspection_id = tests.ins('mir') and template_item_id = tests.item('mirrors')), 1, '... the photo is linked to that item');
-- pure rule with explicit settings (the numbers come from allocation_settings, nothing is hard-coded)
select is(public.inspection_is_late('pre_shift', now(), now() - interval '30 minutes', now() + interval '8 hours', 30, 60), false, 'rule: pre-shift 30 min is not late at 30');
select is(public.inspection_is_late('pre_shift', now(), now() - interval '30 minutes', now() + interval '8 hours', 20, 60), true, 'rule: ... but late when the setting is 20');
select is(public.inspection_is_late('post_shift', now(), now() - interval '10 hours', now() - interval '60 minutes', 30, 60), false, 'rule: post-shift 60 min after the planned end is not late');
select is(public.inspection_is_late('post_shift', now(), now() - interval '10 hours', now() - interval '61 minutes', 30, 60), true, 'rule: 61 minutes is late');
select is(public.inspection_is_late('bogus', now(), now(), now(), 30, 60), false, 'rule: an unknown stage is never late');


-- ================================================================ 8. post-shift: begin moves in_use -> post_inspection_pending (rule e)
select tests.act_as('u-inu');
select is(public.begin_inspection(tests.al('inu'), 'post_shift', null, false, tests.csid('inu-b')) is not null, true, 'post-shift begin on an in_use allocation succeeds');
select tests.reset();
select is((select status from public.vehicle_allocations where id = tests.al('inu')), 'post_inspection_pending', '... and the allocation moved to post_inspection_pending');
select is((select count(*)::int from public.allocation_events where allocation_id = tests.al('inu') and new_value ->> 'status' = 'post_inspection_pending'), 1, '... with one status_changed event');
select tests.act_as('u-inu');
select is(public.begin_inspection(tests.al('inu'), 'post_shift', null, false, tests.csid('inu-b2')), tests.ins('inu', 'post_shift'), 'a second post-shift begin returns the existing draft');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, true, %L)', tests.ins('inu', 'post_shift'), jsonb_build_array(tests.ans('post_incident', 'yes')), tests.csid('inu-s0'))), null, 'post-shift answers: a Yes is accepted as an answer...');
select tests.prep_rest('inu');
select matches(tests.submit('inu', 'post_shift', 'inu-x1'), '^IN005:.*"Any incident, accident or traffic fine during the shift\?" was answered Yes and needs a comment', '... but a Yes without detail cannot be submitted -> IN005');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, null, %L)', tests.ins('inu', 'post_shift'), jsonb_build_array(tests.ans('post_incident', 'yes', 'Scraped a pole in the yard')), tests.csid('inu-s1'))), null, 'the detail is added');
select is(tests.submit('inu', 'post_shift', 'inu-x2'), null, 'post-shift submit succeeds');
select tests.reset();
select is((select status from public.vehicle_allocations where id = tests.al('inu')), 'post_inspection_pending', '... the allocation stays post_inspection_pending (closure is Phase 5)');
select is((select released_at from public.vehicle_allocations where id = tests.al('inu')), null, '... released_at is not set');
select is((select status from public.inspections where id = tests.ins('inu', 'post_shift')), 'submitted', '... the inspection is submitted');
-- post-shift late window: planned end + 60 minutes
select tests.sc('q59', 'A1', 'post_inspection_pending', now() - interval '12 hours', now() + interval '1 hour', now() - interval '59 minutes');
select tests.sc('q60', 'A1', 'post_inspection_pending', now() - interval '12 hours', now() + interval '1 hour', now() - interval '60 minutes');
select tests.sc('q61', 'A1', 'post_inspection_pending', now() - interval '12 hours', now() + interval '1 hour', now() - interval '61 minutes');
select tests.act_as('u-q59'); select tests.prep('q59', 'post_shift'); select is(tests.submit('q59', 'post_shift'), null, 'post-shift submit 59 minutes after the planned end');
select tests.act_as('u-q60'); select tests.prep('q60', 'post_shift'); select is(tests.submit('q60', 'post_shift'), null, 'post-shift submit exactly 60 minutes after the planned end');
select tests.act_as('u-q61'); select tests.prep('q61', 'post_shift'); select is(tests.submit('q61', 'post_shift', 'q61-late-offline'), null, 'post-shift submit 61 minutes after the planned end');
select tests.reset();
select is((select late_flag from public.inspections where id = tests.ins('q59', 'post_shift')), false, '59 min: not late');
select is((select late_flag from public.inspections where id = tests.ins('q60', 'post_shift')), false, '60 min: not late');
select is((select late_flag from public.inspections where id = tests.ins('q61', 'post_shift')), true, '61 min: late');
select tests.act_as('u-q61');
select is(tests.err_of(format('select public.submit_inspection(%L, ''2026-01-01 05:00+00'', true, %L)', tests.ins('q61', 'post_shift'), tests.csid('q61-x'))) like '55000:%', true, 'a submitted inspection cannot be submitted again');
select tests.reset();
-- offline: the device time and the offline flag are stored and the late rule still uses the server time
select tests.sc('off', 'A1', 'pre_inspection_pending', now() - interval '90 minutes', now() + interval '9 hours');
select tests.act_as('u-off'); select public.begin_inspection(tests.al('off'), 'pre_shift', '2026-01-01 04:00+00', false, tests.csid('off-b'));
select public.save_inspection_responses(tests.ins('off'), tests.answers('pre_shift'), true, tests.csid('off-s'));
select public.confirm_known_damage_reviewed(tests.ins('off'), tests.csid('off-k'));
select public.attach_odometer_photo(tests.ins('off'), tests.id('f-fo-off-pre'), tests.csid('off-o'));
select public.record_driver_reading(tests.ins('off'), 1000, null, false, gen_random_uuid());
select is((select out_late_flag from public.submit_inspection(tests.ins('off'), '2026-01-01 04:30+00', true, tests.csid('off-x'))), true, 'offline submit: late is judged on the server time, not the device clock');
select tests.reset();
select is((select captured_offline from public.inspections where id = tests.ins('off')), true, '... captured_offline = true');
select is((select device_submitted_at from public.inspections where id = tests.ins('off')), '2026-01-01 04:30+00'::timestamptz, '... the device submit time is stored (untrusted)');
select is((select submitted_at from public.inspections where id = tests.ins('off')), now(), '... beside the server submitted_at');

-- ================================================================ 9. transition_allocation still refuses in_use / post_inspection_pending for every other caller and path
select tests.sc('tx', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc('ty', 'A1', 'in_use', now() - interval '2 hours', now() + interval '9 hours');
select tests.act_as('u-tx');
select matches(tests.err_of(format('select * from public.transition_allocation(%L, ''in_use'', null, %L)', tests.al('tx'), tests.csid('t1'))), '^0A000:.*pre-shift inspection — available from Phase 4', 'rule d: the driver cannot move an allocation to in_use directly');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select * from public.transition_allocation(%L, ''in_use'', ''manual'', %L)', tests.al('tx'), tests.csid('t2'))), '0A000', 'rule d: a manager cannot either');
select tests.act_as('fa');
select is(tests.sqlstate_of(format('select * from public.transition_allocation(%L, ''in_use'', ''manual'', %L)', tests.al('tx'), tests.csid('t3'))), '0A000', 'rule d: nor a fleet admin');
select tests.reset();
select set_config('app.inspection_transition', tests.al('tx')::text || ':in_use', true);
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select * from public.transition_allocation(%L, ''in_use'', ''manual'', %L)', tests.al('tx'), tests.csid('t4'))), '0A000', 'rule d: the flag alone is not enough for a non-driver');
select tests.act_as('u-tx');
select is(tests.sqlstate_of(format('select * from public.transition_allocation(%L, ''in_use'', null, %L)', tests.al('tx'), tests.csid('t5'))), '0A000', 'rule d: flag + driver but no submitted pre-shift inspection is still refused');
select tests.reset();
select set_config('app.inspection_transition', tests.al('ty')::text || ':in_use', true);
select tests.act_as('u-tx');
select is(tests.sqlstate_of(format('select * from public.transition_allocation(%L, ''in_use'', null, %L)', tests.al('tx'), tests.csid('t6'))), '0A000', 'rule d: a flag naming another allocation does nothing');
select tests.reset();
select set_config('app.inspection_transition', '', true);
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'in_use', started_at = now() where id = tests.al('tx')$$), '55000', 'direct UPDATE to in_use is refused by the guard');
select set_config('app.allocation_transition', 'on', true);
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'in_use' where id = tests.al('tx')$$), '55000', 'in_use without started_at is refused even inside the transition');
select is(tests.sqlstate_of($$update public.vehicle_allocations set started_at = now() where id = tests.al('tx')$$), '55000', 'started_at alone is refused (it moves with the in_use transition only)');
select is(tests.sqlstate_of($$update public.vehicle_allocations set started_at = now() + interval '1 hour' where id = tests.al('ty')$$), '55000', 'started_at cannot be changed once the allocation is in use');
select set_config('app.allocation_transition', 'off', true);
select tests.act_as('u-ty');
select matches(tests.err_of(format('select * from public.transition_allocation(%L, ''post_inspection_pending'', null, %L)', tests.al('ty'), tests.csid('t7'))), '^0A000:.*post-shift inspection flow — available from Phase 4', 'rule e: the driver cannot move an allocation to post_inspection_pending directly');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select * from public.transition_allocation(%L, ''post_inspection_pending'', ''manual'', %L)', tests.al('ty'), tests.csid('t8'))), '0A000', 'rule e: a manager cannot either');
select tests.reset();
select set_config('app.inspection_transition', tests.al('ty')::text || ':post_inspection_pending', true);
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select * from public.transition_allocation(%L, ''post_inspection_pending'', ''manual'', %L)', tests.al('ty'), tests.csid('t9'))), '0A000', 'rule e: the flag alone is not enough for a non-driver');
select tests.reset();
select set_config('app.inspection_transition', tests.al('tx')::text || ':post_inspection_pending', true);
select tests.act_as('u-ty');
select is(tests.sqlstate_of(format('select * from public.transition_allocation(%L, ''post_inspection_pending'', null, %L)', tests.al('ty'), tests.csid('t10'))), '0A000', 'rule e: a flag naming another allocation does nothing');
select tests.reset();
select set_config('app.inspection_transition', '', true);
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select * from public.transition_allocation(%L, ''closed'', ''manual'', %L)', tests.al('inu'), tests.csid('t11'))), '0A000', 'closing stays unavailable (Phase 5)');
select tests.reset();
select is((select status from public.vehicle_allocations where id = tests.al('tx')), 'pre_inspection_pending', 'nothing moved: tx is still pre_inspection_pending');
select is((select status from public.vehicle_allocations where id = tests.al('ty')), 'in_use', '... and ty is still in_use');


-- ================================================================ 10. void_inspection (allocation.manage; DEC-24)
create temp table cnt (k text primary key, v integer); grant all on cnt to public;
insert into cnt select 'resp', count(*) from public.inspection_responses where inspection_id = tests.ins('p1');
insert into cnt select 'odo', count(*) from public.odometer_evidence where inspection_id = tests.ins('p1');
insert into cnt select 'photo', count(*) from public.inspection_photos where inspection_id = tests.ins('p1');
select tests.act_as('u-p1');
select is(tests.sqlstate_of(format('select public.void_inspection(%L, ''I made a mistake'', %L)', (select v from kv where k = 'p1'), tests.csid('v1'))), '42501', 'void: the driver (no allocation.manage) cannot');
select tests.act_as('sup2');
select is(tests.sqlstate_of(format('select public.void_inspection(%L, ''Wrong vehicle'', %L)', (select v from kv where k = 'p1'), tests.csid('v2'))), '42501', 'void: a supervisor of another branch cannot');
select tests.act_as('ma');
select is(tests.sqlstate_of(format('select public.void_inspection(%L, ''Wrong vehicle'', %L)', (select v from kv where k = 'p1'), tests.csid('v3'))), '42501', 'void: a maintenance administrator (reports.view only) cannot');
select tests.act_as('sm');
select is(tests.sqlstate_of(format('select public.void_inspection(%L, ''Wrong vehicle'', %L)', (select v from kv where k = 'p1'), tests.csid('v4'))), '42501', 'void: senior management (view-only) cannot');
select tests.act_as('sa');
select is(tests.sqlstate_of(format('select public.void_inspection(%L, ''Wrong vehicle'', %L)', (select v from kv where k = 'p1'), tests.csid('v5'))), '42501', 'void: a system administrator (no allocation.manage) cannot');
select tests.act_as('fab');
select is(tests.sqlstate_of(format('select public.void_inspection(%L, ''Wrong vehicle'', %L)', (select v from kv where k = 'p1'), tests.csid('v6'))), 'P0002', 'void: another company cannot see it');
select tests.act_as('sup1');
select matches(tests.err_of(format('select public.void_inspection(%L, ''  '', %L)', (select v from kv where k = 'p1'), tests.csid('v7'))), '^22023:.*reason', 'void: a reason is required');
-- DEC-24: nobody voids their own work (u-p2 holds allocation.manage and completes the inspection on p2)
select tests.act_as('u-p2');
select public.begin_inspection(tests.al('p2'), 'pre_shift', null, false, tests.csid('p2-b'));
select matches(tests.err_of(format('select public.void_inspection(%L, ''Changed my mind'', %L)', tests.ins('p2'), tests.csid('v8'))), '^42501:.*completed yourself', 'void: DEC-24 — a manager who completed the inspection cannot void it');
select tests.act_as('sup1');
select is(public.void_inspection(tests.ins('p1'), 'Wrong vehicle registered', tests.csid('v9')), (select v from kv where k = 'p1'), 'void: allocation.manage for the branch voids a submitted inspection');
select is(public.void_inspection((select v from kv where k = 'p1'), 'Wrong vehicle registered', tests.csid('v9')), (select v from kv where k = 'p1'), 'void: the retry (same client_submission_id) is idempotent');
select tests.reset();
select is((select status || '/' || void_reason || '/' || (voided_by = tests.id('sup1'))::text from public.inspections where id = (select v from kv where k = 'p1')), 'void/Wrong vehicle registered/true', '... status void, the reason and who voided it are recorded');
select is((select voided_at from public.inspections where id = (select v from kv where k = 'p1')), now(), '... voided_at is the server time');
select is((select count(*)::int from public.inspection_responses where inspection_id = (select v from kv where k = 'p1')), (select v from cnt where k = 'resp'), 'a voided inspection keeps all its answers');
select is((select count(*)::int from public.odometer_evidence where inspection_id = (select v from kv where k = 'p1')), (select v from cnt where k = 'odo'), '... all its odometer photos');
select is((select count(*)::int from public.inspection_photos where inspection_id = (select v from kv where k = 'p1')), (select v from cnt where k = 'photo'), '... and all its condition photos');
select is((select status from public.vehicle_allocations where id = tests.al('p1')), 'in_use', 'a voided pre-shift inspection does not move the allocation back (Phase 5 decides corrections)');
select is((select reason from public.audit_logs where entity_type = 'inspections' and entity_id = (select v from kv where k = 'p1') and action = 'update' and after_values ->> 'status' = 'void'), 'Wrong vehicle registered', '... the void is audited with its reason');
select tests.act_as('sup1');
select matches(tests.err_of(format('select public.void_inspection(%L, ''Again'', %L)', (select v from kv where k = 'p1'), tests.csid('v10'))), '^55000:.*already void', 'void: voiding twice is refused');
select tests.reset();
select is(tests.sqlstate_of($$update public.inspections set void_reason = 'edited' where id = (select v from kv where k = 'p1')$$), '55000', 'a voided inspection can no longer change');
select tests.act_as('u-p1');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''pre_shift'', null, false, %L)', tests.al('p1'), tests.csid('p1-again'))), '55000', 'after the void the allocation is still in_use: a new pre-shift inspection is refused');
-- voiding a draft frees the slot: the driver can begin again
select tests.act_as('sup1');
select is(public.void_inspection(tests.ins('p2'), 'Started on the wrong vehicle', tests.csid('v11')) is not null, true, 'void: a draft can be voided by another manager');
select tests.act_as('u-p2');
select isnt(public.begin_inspection(tests.al('p2'), 'pre_shift', null, false, tests.csid('p2-b3')), (select v from kv where k = 'p2'), 'after voiding a draft, a new draft can be begun (a different inspection)');
select tests.reset();
select is((select count(*)::int from public.inspections where allocation_id = tests.al('p2')), 2, '... the voided draft is kept beside the new one');
select is((select count(*)::int from public.inspections where allocation_id = tests.al('p2') and status <> 'void'), 1, '... exactly one non-void');
-- a voided post-shift inspection leaves the allocation post_inspection_pending; a new draft can follow
select tests.act_as('bm1');
select is(public.void_inspection(tests.ins('inu', 'post_shift'), 'Odometer photo was of another vehicle', tests.csid('v12')) is not null, true, 'void: a branch manager voids a submitted post-shift inspection');
select tests.act_as('u-inu');
select is(public.begin_inspection(tests.al('inu'), 'post_shift', null, false, tests.csid('inu-b3')) is not null, true, '... and the driver can begin a new post-shift inspection');
select tests.reset();
select is((select status from public.vehicle_allocations where id = tests.al('inu')), 'post_inspection_pending', '... the allocation stayed post_inspection_pending');

-- ================================================================ 11. RLS: reads
select tests.sc('rb', 'B1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.act_as('u-rb'); select public.begin_inspection(tests.al('rb'), 'pre_shift', null, false, tests.csid('rb-b'));
select tests.reset();
create temp table tot (k text primary key, v integer); grant all on tot to public;
insert into tot select 'A1', count(*) from public.inspections where branch_id = tests.id('A1');
insert into tot select 'coA', count(*) from public.inspections where company_id = tests.id('coA');
insert into tot select 'A1resp', count(*) from public.inspection_responses r join public.inspections i on i.id = r.inspection_id where i.branch_id = tests.id('A1');
insert into tot select 'A1odo', count(*) from public.odometer_evidence where branch_id = tests.id('A1');
insert into tot select 'A1ph', count(*) from public.inspection_photos where branch_id = tests.id('A1');
select tests.act_as('u-l29');
select is((select count(*)::int from public.inspections), 1, 'RLS: a driver sees only their own inspection');
select is((select count(*)::int from public.inspection_responses), 20, '... and only their own answers');
select is((select count(*)::int from public.odometer_evidence), 1, '... and only their own odometer photo row');
select tests.act_as('u-l30');
select is((select count(*)::int from public.inspections where id = tests.ins('l29')), 0, 'RLS: another driver of the same branch cannot see it');
select tests.act_as('sup1');
select is((select count(*)::int from public.inspections), (select v from tot where k = 'A1'), 'RLS: a supervisor sees every inspection of their branch');
select is((select count(*)::int from public.inspection_responses), (select v from tot where k = 'A1resp'), '... and their answers');
select is((select count(*)::int from public.odometer_evidence), (select v from tot where k = 'A1odo'), '... odometer photo rows');
select is((select count(*)::int from public.inspection_photos), (select v from tot where k = 'A1ph'), '... and condition photo rows');
select tests.act_as('sup2');
select is((select count(*)::int from public.inspections), 0, 'RLS: a supervisor of another branch sees none');
select is((select count(*)::int from public.inspection_responses), 0, '... nor answers');
select tests.act_as('bm1');
select is((select count(*)::int from public.inspections), (select v from tot where k = 'A1'), 'RLS: a branch manager sees their branch');
select tests.act_as('fa');
select is((select count(*)::int from public.inspections), (select v from tot where k = 'coA'), 'RLS: a fleet admin sees the whole company');
select tests.act_as('fab');
select is((select count(*)::int from public.inspections), 1, 'RLS: another company sees only its own');
select is((select count(*)::int from public.inspections where company_id = tests.id('coA')), 0, '... and nothing of company A');
select tests.act_as('ma');
select is((select count(*)::int from public.inspections), (select v from tot where k = 'coA'), 'RLS: a maintenance administrator reads inspections (reports.view)...');
select is(tests.sqlstate_of($$update public.inspections set vehicle_confirmed = false$$), '42501', '... and cannot write');
select is(tests.sqlstate_of($$insert into public.inspection_responses (company_id, inspection_id, template_item_id, response_value) select company_id, id, tests.item('tyres'), 'ok' from public.inspections limit 1$$), '42501', '... not even answers');
select tests.act_as('sm');
select is((select count(*)::int from public.inspections), (select v from tot where k = 'coA'), 'RLS: senior management reads inspections (reports.view)...');
select is(tests.sqlstate_of($$delete from public.inspections$$), '42501', '... and cannot delete');
select tests.act_as('sa');
select is((select count(*)::int from public.inspections), 0, 'RLS: a system administrator sees no inspections');
select is((select count(*)::int from public.odometer_evidence), 0, '... no odometer photo rows');
select is((select count(*)::int from public.inspection_photos), 0, '... no photo rows');
select tests.reset();
set local role anon;
select is(tests.sqlstate_of($$select count(*) from public.inspections$$), '42501', 'RLS: anon has no access');
select tests.reset();
select tests.act_as('u-l29');
select is(tests.sqlstate_of($$insert into public.inspections (company_id) values (tests.id('coA'))$$), '42501', 'no client INSERT on inspections');
select is(tests.sqlstate_of($$update public.inspections set late_flag = false$$), '42501', 'no client UPDATE on inspections');
select is(tests.sqlstate_of($$update public.inspection_responses set response_value = 'ok'$$), '42501', 'no client UPDATE on answers');
select is(tests.sqlstate_of($$delete from public.odometer_evidence$$), '42501', 'no client DELETE on odometer photos');
select is(tests.sqlstate_of($$select count(*) from public.inspection_requests$$), '42501', 'the idempotency ledger is not readable by clients');
select tests.reset();

-- ================================================================ 12. read functions
select tests.act_as('u-l29');
select is(jsonb_array_length(public.my_inspection(tests.al('l29'), 'pre_shift') -> 'items'), 20, 'my_inspection: the 20 pre-shift items');
select is(public.my_inspection(tests.al('l29'), 'pre_shift') ->> 'odometer_photo_present', 'true', '... odometer photo present: true');
select is(public.my_inspection(tests.al('l29'), 'pre_shift') #>> '{items,0,answer,value}', 'ok', '... the saved answers come back');
select is(public.my_inspection(tests.al('l29'), 'pre_shift') #>> '{inspection,status}', 'submitted', '... with the inspection status');
select is(jsonb_array_length(public.my_inspection(tests.al('l29'), 'post_shift') -> 'items'), 7, '... and the 7 post-shift items for the other stage');
select is(tests.sqlstate_of(format('select public.my_inspection(%L, ''pre_shift'')', tests.al('l30'))), 'P0002', 'my_inspection: another driver''s allocation is not found');
select is(tests.sqlstate_of(format('select public.my_inspection(%L, ''bogus'')', tests.al('l29'))), '22023', 'my_inspection: unknown stage refused');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select public.my_inspection(%L, ''pre_shift'')', tests.al('l29'))), 'P0002', 'my_inspection: a supervisor is not the driver');
select tests.act_as('u-mir');
select is((select count(*)::int from jsonb_array_elements(public.my_inspection(tests.al('mir'), 'pre_shift') -> 'photo_slots') s where s ->> 'kind' = 'defect_photo' and s ->> 'filled' = 'true'), 1, 'my_inspection: a Defect has a photo slot, filled');
select is((select count(*)::int from jsonb_array_elements(public.my_inspection(tests.al('mir'), 'pre_shift') -> 'photo_slots') s where s ->> 'kind' = 'odometer' and s ->> 'filled' = 'true'), 1, '... and the odometer slot is filled');
select tests.reset();
select tests.sc('prev', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.act_as('u-prev');
select is(public.my_inspection(tests.al('prev'), 'pre_shift') #>> '{inspection}', null, 'my_inspection before beginning: no inspection yet...');
select is(jsonb_array_length(public.my_inspection(tests.al('prev'), 'pre_shift') -> 'items'), 20, '... the template items are shown');
select is(public.my_inspection(tests.al('prev'), 'pre_shift') ->> 'odometer_photo_present', 'false', '... odometer photo present: false');
select tests.act_as('sup1');
select is((select count(*)::int from public.list_inspections(now() - interval '1 day', now() + interval '1 day')), (select v from tot where k = 'A1'), 'list_inspections: a supervisor lists their branch''s inspections');
select is((select late_flag from public.list_inspections(now() - interval '1 day', now() + interval '1 day') where inspection_id = tests.ins('l31')), true, '... with the Late flag');
select is((select safety_defect_flag from public.list_inspections(now() - interval '1 day', now() + interval '1 day') where allocation_id = tests.al('l31')), false, '... and the Safety defect flag');
select is((select count(*)::int from public.list_inspections(now() - interval '1 day', now() + interval '1 day', tests.id('A2'))), 0, '... filtered to another branch: none');
select is(tests.sqlstate_of($$select * from public.list_inspections(now(), now() - interval '1 day')$$), '22023', 'list_inspections: a reversed range is refused');
select is(tests.sqlstate_of($$select * from public.list_inspections(now() - interval '100 days', now())$$), '22023', '... and so is a range over 92 days');
select tests.act_as('ma');
select is((select count(*)::int from public.list_inspections(now() - interval '1 day', now() + interval '1 day')), (select v from tot where k = 'coA'), 'list_inspections: a maintenance administrator lists via reports.view');
select tests.act_as('sa');
select is((select count(*)::int from public.list_inspections(now() - interval '1 day', now() + interval '1 day')), 0, 'list_inspections: a system administrator gets nothing');
select tests.act_as('u-l29');
select is((select count(*)::int from public.list_inspections(now() - interval '1 day', now() + interval '1 day')), 0, 'list_inspections: a driver gets nothing (no management permission)');
select tests.reset();

-- ================================================================ 13. no DELETE / TRUNCATE; audit; function privileges
select is(tests.sqlstate_of($$delete from public.inspections$$), '42501', 'no DELETE on inspections');
select is(tests.sqlstate_of($$delete from public.inspection_responses$$), '42501', 'no DELETE on inspection_responses');
select is(tests.sqlstate_of($$delete from public.odometer_evidence$$), '42501', 'no DELETE on odometer_evidence');
select is(tests.sqlstate_of($$delete from public.inspection_photos$$), '42501', 'no DELETE on inspection_photos');
select is(tests.sqlstate_of($$delete from public.inspection_requests$$), '42501', 'no DELETE on inspection_requests');
select is(tests.sqlstate_of($$truncate public.inspections cascade$$), '42501', 'no TRUNCATE on inspections');
select is(tests.sqlstate_of($$truncate public.inspection_responses$$), '42501', 'no TRUNCATE on inspection_responses');
select is(tests.sqlstate_of($$truncate public.odometer_evidence cascade$$), '42501', 'no TRUNCATE on odometer_evidence');
select is(tests.sqlstate_of($$truncate public.inspection_photos$$), '42501', 'no TRUNCATE on inspection_photos');
select is(tests.sqlstate_of($$truncate public.inspection_requests$$), '42501', 'no TRUNCATE on inspection_requests');
select is(tests.sqlstate_of($$update public.inspection_photos set photo_category = 'other'$$), '42501', 'inspection photos are append-only (no UPDATE)');
select is(tests.sqlstate_of($$update public.inspection_requests set request_hash = 'x'$$), '42501', 'the idempotency ledger is append-only');
select is((select count(*)::int from public.audit_logs where entity_type = 'inspections' and action = 'insert' and entity_id = tests.ins('l29')), 1, 'audit: the inspection insert is audited');
select is((select actor_id from public.audit_logs where entity_type = 'inspections' and action = 'insert' and entity_id = tests.ins('l29')), tests.id('u-l29'), '... by the driver');
select is((select count(*)::int from public.audit_logs where entity_type = 'inspections' and action = 'update' and entity_id = tests.ins('l29') and after_values ->> 'status' = 'submitted'), 1, 'audit: the submission is audited');
select is((select count(*)::int from public.audit_logs where entity_type = 'inspection_responses' and after_values ->> 'inspection_id' = tests.ins('l29')::text), 20, 'audit: every answer is audited');
select is((select count(*)::int from public.audit_logs where entity_type = 'odometer_evidence' and action = 'insert' and after_values ->> 'inspection_id' = tests.ins('l29')::text), 1, 'audit: the odometer photo is audited');
select is((select count(*)::int from public.audit_logs where entity_type = 'inspection_photos' and action = 'insert' and after_values ->> 'inspection_id' = tests.ins('mir')::text), 1, 'audit: the condition photo is audited');
select is((select count(*)::int from public.audit_logs where entity_type = 'inspection_templates' and action = 'update' and company_id = tests.id('coA') and (after_values ->> 'first_used_at') is not null), 1, 'audit: the template''s first use is audited (company A''s template)');
select is((select bool_and(has_function_privilege('authenticated', p, 'execute') and not has_function_privilege('anon', p, 'execute'))
             from unnest(array['public.begin_inspection(uuid,text,timestamptz,boolean,uuid)', 'public.save_inspection_responses(uuid,jsonb,boolean,uuid)',
                               'public.attach_odometer_photo(uuid,uuid,uuid)', 'public.attach_inspection_photo(uuid,uuid,text,uuid,uuid)',
                               'public.submit_inspection(uuid,timestamptz,boolean,uuid)', 'public.void_inspection(uuid,text,uuid)',
                               'public.my_inspection(uuid,text)', 'public.list_inspections(timestamptz,timestamptz,uuid,integer)']) p), true, 'the eight client functions: authenticated only, never anon');
select is((select count(*)::int
             from unnest(array['public.inspection_fail(text,text,text)', 'public.inspection_response_valid(text,text,boolean)', 'public.inspection_check_evidence(uuid,uuid,text[])',
                               'public.inspection_is_late(text,timestamptz,timestamptz,timestamptz,integer,integer)', 'public.inspection_replay(uuid,uuid,uuid,text,text)',
                               'public.inspection_record(uuid,uuid,uuid,text,text,uuid)', 'public.inspection_load_for_driver(uuid)',
                               'public.seed_starter_inspection_template(uuid)', 'public.inspection_template_for(uuid)']) p
            where has_function_privilege('authenticated', p, 'execute') or has_function_privilege('anon', p, 'execute') or has_function_privilege('public', p, 'execute')),
          0, 'the internal functions are not executable by clients');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('begin_inspection', 'save_inspection_responses', 'attach_odometer_photo', 'attach_inspection_photo',
                  'submit_inspection', 'void_inspection', 'my_inspection', 'list_inspections') and (not p.prosecdef or p.proconfig is null or not ('search_path=""' = any (p.proconfig)))), 0,
          'the client functions are SECURITY DEFINER with search_path = ''''');

select * from finish();
rollback;
