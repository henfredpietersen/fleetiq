-- Slice 4C pgTAP: the supervisor completes the POST-shift inspection on the driver's behalf (migration 048; DEC-09, DEC-24, DEC-35, DEC-41).
-- Who may, the allocation move (rule e), the driver's draft that must be voided first, the completer check on every write, the device flag
-- (stored, never blocking), the read path, audit. Synthetic data only; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(72);

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

alter function tests.ins(text, text) security definer;
create function tests.ob_begin(label text, reason text, c text) returns text language sql as $$
  select tests.err_of(format('select public.begin_inspection_on_behalf(%L, %L, null, false, %L)', tests.al(label), reason, tests.csid(c))) $$;
create function tests.sfile(n text, uploader text, branch text default 'A1') returns void language sql as $$ select tests.mk_file(n, uploader, branch, 'odometer') $$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('fa', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'),
       tests.mk_user('sup3', 'coA'), tests.mk_user('bm1', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('fab', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sup2', 'supervisor', 'A1', 'boot'),
       tests.grant_role('sup3', 'supervisor', 'A2', 'boot'), tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'),
       tests.grant_role('fab', 'fleet_admin', null, 'bootb');
select public.seed_starter_inspection_template(tests.id('coA')), public.seed_starter_inspection_template(tests.id('coB'));
-- in_use allocations (the driver ended the shift but could not finish); 'dr' already has the driver's post-shift draft; 'sb' has a submitted post-shift inspection
select tests.sc('w1', 'A1', 'in_use', now() - interval '4 hours', now() + interval '4 hours');
select tests.sc('w2', 'A1', 'in_use', now() - interval '4 hours', now() + interval '4 hours');
select tests.sc('w3', 'A1', 'in_use', now() - interval '4 hours', now() + interval '4 hours');
select tests.sc('pp', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc('pl', 'A1', 'planned', now() + interval '30 minutes', now() + interval '9 hours');
select tests.sc('dr', 'A1', 'in_use', now() - interval '4 hours', now() + interval '4 hours');
select tests.sc('sb', 'A1', 'in_use', now() - interval '4 hours', now() + interval '4 hours');
select tests.sc('sp', 'A1', 'in_use', now() - interval '4 hours', now() + interval '4 hours');   -- the driver is also a supervisor
select tests.sc('b1', 'B1', 'in_use', now() - interval '4 hours', now() + interval '4 hours');
select tests.grant_role('u-sp', 'supervisor', 'A1', 'boot');
select tests.sfile('so1', 'sup1'), tests.sfile('so2', 'sup1'), tests.sfile('so3', 'sup1'), tests.sfile('so4', 'sup2'), tests.sfile('so5', 'sup1'), tests.sfile('so6', 'sup1');

-- ================================================================ 1. who may complete on behalf (post-shift only)
select tests.act_as('u-w1');
select is(tests.ob_begin('w1', 'Driver ended the shift without finishing', 'x0') like '42501:%', true, 'on behalf: the allocation''s own driver cannot use it');
select tests.act_as('u-w2');
select is(tests.ob_begin('w1', 'Driver ended the shift without finishing', 'x1') like '42501:%', true, 'on behalf: another driver (no allocation.manage) is refused');
select tests.act_as('fa');
select is(tests.ob_begin('w1', 'Driver ended the shift without finishing', 'x2') like '42501:%', true, 'on behalf: a fleet administrator (allocation.manage but no inspection.submit) is refused');
select tests.act_as('bm1');
select is(tests.ob_begin('w1', 'Driver ended the shift without finishing', 'x3') like '42501:%', true, 'on behalf: a branch manager (no inspection.submit) is refused');
select tests.act_as('ma');
select is(tests.ob_begin('w1', 'Driver ended the shift without finishing', 'x4') like '42501:%', true, 'on behalf: a maintenance administrator is refused');
select tests.act_as('sup3');
select is(tests.ob_begin('w1', 'Driver ended the shift without finishing', 'x5') like '42501:%', true, 'on behalf: a supervisor of another branch is refused');
select tests.act_as('fab');
select is(tests.ob_begin('w1', 'Driver ended the shift without finishing', 'x6') like 'P0002:%', true, 'on behalf: another company''s user cannot see the allocation');
select tests.act_as('u-sp');
select is(tests.ob_begin('sp', 'Own allocation', 'x7') like '42501:%', true, 'on behalf: a supervisor cannot complete their own allocation on their own behalf (DEC-24)');
select tests.act_as('sup1');
select is(tests.ob_begin('w1', null, 'x8') like '22023:%', true, 'on behalf: a reason is required');
select is(tests.ob_begin('w1', '   ', 'x9') like '22023:%', true, 'on behalf: a blank reason is refused');
select is(tests.ob_begin('w1', repeat('r', 501), 'x10') like '22023:%', true, 'on behalf: a reason over 500 characters is refused');
select is(tests.ob_begin('pp', 'Driver unwell', 'x11') like '55000:%', true, 'on behalf: a pre_inspection_pending allocation is refused (post-shift only, in use)');
select is(tests.ob_begin('pl', 'Driver unwell', 'x12') like '55000:%', true, 'on behalf: a planned allocation is refused');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''pre_shift'', null, false, %L)', tests.al('pp'), tests.csid('x13'))), '42501', 'the pre-shift inspection cannot be completed on behalf: begin_inspection is still the driver''s only');
select is(tests.sqlstate_of(format('select public.begin_inspection(%L, ''post_shift'', null, false, %L)', tests.al('w1'), tests.csid('x14'))), '42501', 'begin_inspection still refuses a supervisor');
select is(tests.sqlstate_of(format('select public.transition_allocation(%L, ''post_inspection_pending'', ''x'', %L)', tests.al('w1'), tests.csid('x15'))), '0A000', 'rule e: a supervisor cannot move the allocation without the on-behalf flow');
select tests.act_as('fa');
select set_config('app.inspection_transition', tests.al('w1')::text || ':post_inspection_pending:on_behalf', true);
select is(tests.sqlstate_of(format('select public.transition_allocation(%L, ''post_inspection_pending'', ''x'', %L)', tests.al('w1'), tests.csid('x16'))), '0A000', 'rule e: even with the flag set, a caller without inspection.submit is refused');
select set_config('app.inspection_transition', '', true);
select tests.act_as('u-w1');
select set_config('app.inspection_transition', tests.al('w1')::text || ':post_inspection_pending:on_behalf', true);
select is(tests.sqlstate_of(format('select public.transition_allocation(%L, ''post_inspection_pending'', ''x'', %L)', tests.al('w1'), tests.csid('x17'))), '0A000', 'rule e: the driver cannot use the on-behalf flag');
select set_config('app.inspection_transition', '', true);
select tests.reset();
select is((select status from public.vehicle_allocations where id = tests.al('w1')), 'in_use', 'none of the refusals moved the allocation');

-- ================================================================ 2. begin on behalf: the allocation moves, the flags are stored, audit
select tests.act_as('sup1');
create temp table kv (k text primary key, v uuid); grant all on kv to public;
insert into kv select 'w1', public.begin_inspection_on_behalf(tests.al('w1'), 'Driver ended the shift without finishing', '2026-01-01 05:00+00', false, tests.csid('w1-b'));
select is(public.begin_inspection_on_behalf(tests.al('w1'), 'Driver ended the shift without finishing', '2026-01-01 05:00+00', false, tests.csid('w1-b')), (select v from kv where k = 'w1'), 'begin: the retry returns the same inspection');
select is(public.begin_inspection_on_behalf(tests.al('w1'), 'Driver ended the shift without finishing', null, false, tests.csid('w1-b2')), (select v from kv where k = 'w1'), 'begin: resuming your own on-behalf draft returns it');
select matches(tests.ob_begin('w1', 'A different reason', 'w1-b'), '^22023:.*already used', 'begin: the same id with another reason is refused');
select tests.reset();
select is((select status from public.vehicle_allocations where id = tests.al('w1')), 'post_inspection_pending', 'begin: in_use -> post_inspection_pending (rule e, on-behalf path)');
select is((select completed_by_role || '/' || on_behalf_reason || '/' || inspection_stage || '/' || status from public.inspections where id = (select v from kv where k = 'w1')),
          'supervisor_on_behalf/Driver ended the shift without finishing/post_shift/draft', 'begin: completed_by_role, the reason and the stage are stored');
select is((select submitted_by from public.inspections where id = (select v from kv where k = 'w1')), tests.id('sup1'), 'begin: submitted_by is the supervisor');
select is((select (metadata ->> 'on_behalf')::boolean from public.allocation_events where allocation_id = tests.al('w1') and new_value ->> 'status' = 'post_inspection_pending'), true, 'begin: the allocation event records on_behalf');
select is((select reason from public.allocation_events where allocation_id = tests.al('w1') and new_value ->> 'status' = 'post_inspection_pending'), 'Driver ended the shift without finishing', 'begin: ... and the reason');
select is((select count(*)::int from public.audit_logs where entity_type = 'inspections' and entity_id = (select v from kv where k = 'w1') and reason like 'completed on behalf of the driver: Driver ended the shift without finishing'), 1, 'audit: the reason is in audit_logs (app.audit_reason)');
select is((select count(*)::int from public.audit_logs where entity_type = 'vehicle_allocations' and entity_id = tests.al('w1') and reason = 'Driver ended the shift without finishing'), 1, 'audit: ... and on the allocation move');
select tests.act_as('sup2');
select is(tests.ob_begin('w1', 'I will do it', 'w1-other') like '55000:%another manager%', true, 'begin: a second manager is told someone else is already completing it');
select tests.act_as('u-w1');
select is(public.begin_inspection(tests.al('w1'), 'post_shift', null, false, tests.csid('w1-drv')), (select v from kv where k = 'w1'), 'the driver''s own begin just returns the existing live inspection (one per stage); section 3 shows they cannot change it');
select tests.reset();

-- ================================================================ 3. the completer check: only the supervisor changes it; the driver cannot
select tests.act_as('u-w1');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, true, %L)', (select v from kv where k = 'w1'), tests.answers('post_shift'), tests.csid('w1-d1'))), '42501', 'completer: the driver can no longer save answers');
select is(tests.sqlstate_of(format('select public.confirm_known_damage_reviewed(%L, %L)', (select v from kv where k = 'w1'), tests.csid('w1-d2'))), '42501', 'completer: ... nor confirm the known damage list');
select is(tests.sqlstate_of(format('select public.attach_odometer_photo(%L, %L, %L)', (select v from kv where k = 'w1'), tests.id('f-fo-w1-post'), tests.csid('w1-d3'))), '42501', 'completer: ... nor attach a photo');
select is(tests.sqlstate_of(format('select * from public.submit_inspection(%L, null, false, %L)', (select v from kv where k = 'w1'), tests.csid('w1-d4'))), '42501', 'completer: ... nor submit');
select is(tests.sqlstate_of(format('select public.report_damage(%L, ''roof'', ''minor'', ''x'', %L::uuid[], null, false, %L)', (select v from kv where k = 'w1'), array[tests.id('f-fo-w1-post')], tests.csid('w1-d5'))), '42501', 'completer: ... nor report damage');
select tests.act_as('sup2');
select is(tests.sqlstate_of(format('select public.save_inspection_responses(%L, %L, true, %L)', (select v from kv where k = 'w1'), tests.answers('post_shift'), tests.csid('w1-o1'))), '42501', 'completer: another manager cannot change it either');
select is(tests.sqlstate_of(format('select public.my_inspection(%L, ''post_shift'')', tests.al('w1'))), 'P0002', 'read: another manager cannot read the form document');
select tests.act_as('u-w2');
select is(tests.sqlstate_of(format('select public.my_inspection(%L, ''post_shift'')', tests.al('w1'))), 'P0002', 'read: another driver cannot read it');
select tests.act_as('u-w1');
select is((public.my_inspection(tests.al('w1'), 'post_shift') -> 'inspection' ->> 'completed_by_role'), 'supervisor_on_behalf', 'read: the allocation''s driver can still read (read-only) and sees completed_by_role');
select tests.act_as('sup1');
select is((public.my_inspection(tests.al('w1'), 'post_shift') -> 'inspection' ->> 'on_behalf_reason'), 'Driver ended the shift without finishing', 'read: the on-behalf completer reads the form document, with the reason');
select is(jsonb_typeof(public.my_inspection(tests.al('w1'), 'post_shift') -> 'known_damage'), 'array', 'read: ... including the known damage list');
select tests.act_as('sup1');
select is(public.save_inspection_responses((select v from kv where k = 'w1'), tests.answers('post_shift'), true, tests.csid('w1-s1')), (select v from kv where k = 'w1'), 'completer: the supervisor saves the answers');
select is(public.attach_odometer_photo((select v from kv where k = 'w1'), tests.id('f-so1'), tests.csid('w1-o2')) is not null, true, 'completer: ... attaches the odometer photo (their own camera photo)');
select matches(tests.err_of(format('select * from public.submit_inspection(%L, null, false, %L)', (select v from kv where k = 'w1'), tests.csid('w1-x1'))), '^IN007:', 'submit on behalf: the known damage list must be confirmed too (IN007)');
select is(public.confirm_known_damage_reviewed((select v from kv where k = 'w1'), tests.csid('w1-k')), (select v from kv where k = 'w1'), 'completer: the supervisor confirms the known damage list');
select is(tests.sqlstate_of(format('select public.void_inspection(%L, ''x'', %L)', (select v from kv where k = 'w1'), tests.csid('w1-v1'))), '42501', 'DEC-24: the supervisor cannot void the inspection they completed');
select public.record_driver_reading((select v from kv where k = 'w1'), 1000, null, false, gen_random_uuid());   -- 5A: the completer's reading (IN015)
select is(tests.sqlstate_of(format('select * from public.submit_inspection(%L, ''2026-01-01 06:00+00'', false, %L)', (select v from kv where k = 'w1'), tests.csid('w1-x2'))), null::text, 'submit on behalf: succeeds (a device flag never blocks)');
select tests.reset();
select is((select status || '/' || completed_by_role from public.inspections where id = (select v from kv where k = 'w1')), 'submitted/supervisor_on_behalf', 'submit: submitted, still flagged as completed by the supervisor');
select is((select device_flag is not null from public.inspections where id = (select v from kv where k = 'w1')), true, 'device flag: stored, as computed against the DRIVER''s device (the UI shows it neutrally)');
select is((select device_flag from public.inspections where id = (select v from kv where k = 'w1')), 'no_issued_device', '... here the driver has no issued device');
select is((select status from public.vehicle_allocations where id = tests.al('w1')), 'post_inspection_pending', 'submit: the allocation stays post_inspection_pending (closure is Phase 5)');
select is(tests.sqlstate_of(format('update public.inspections set on_behalf_reason = %L where id = %L', 'edited', (select v from kv where k = 'w1'))), '23514', 'the on-behalf reason is immutable');
select is(tests.sqlstate_of(format('update public.inspections set completed_by_role = %L where id = %L', 'driver', (select v from kv where k = 'w1'))), '23514', 'completed_by_role is immutable (permanently flagged)');
select tests.act_as('sup1');
select is(tests.ob_begin('w1', 'Again', 'w1-again') like '55000:%already been submitted%', true, 'begin: once submitted, another on-behalf attempt is refused');
select tests.act_as('sup2');
select is(tests.sqlstate_of(format('select public.void_inspection(%L, ''Wrong vehicle photographed'', %L)', (select v from kv where k = 'w1'), tests.csid('w1-v2'))), null::text, 'void: a DIFFERENT manager can void it (DEC-24 only bars the completer)');
select tests.reset();

-- ================================================================ 4. the driver's own draft must be voided first
select tests.act_as('u-dr');
select public.begin_inspection(tests.al('dr'), 'post_shift', null, false, tests.csid('dr-b'));
select tests.act_as('sup1');
select matches(tests.ob_begin('dr', 'Driver could not finish', 'dr-x1'), '^55000:.*driver.*Void the driver''s draft first', 'draft: refused with a clear message while the driver''s draft exists');
select is(public.void_inspection(tests.ins('dr', 'post_shift'), 'Driver could not finish; supervisor will complete it', tests.csid('dr-v')), tests.ins('dr', 'post_shift'), 'draft: the supervisor may void the driver''s draft (they did not complete it)');
select is(tests.ob_begin('dr', 'Driver could not finish', 'dr-x2'), null, 'draft: after the void, completing on behalf succeeds');
select tests.reset();
select is((select count(*)::int from public.inspections where allocation_id = tests.al('dr') and inspection_stage = 'post_shift' and status <> 'void'), 1, 'draft: one live post-shift inspection');
select is((select count(*)::int from public.inspections where allocation_id = tests.al('dr') and inspection_stage = 'post_shift' and status = 'void'), 1, 'draft: the voided draft is kept, never deleted');
select is((select completed_by_role from public.inspections where allocation_id = tests.al('dr') and inspection_stage = 'post_shift' and status <> 'void'), 'supervisor_on_behalf', 'draft: the live one is the supervisor''s');
-- a submitted driver inspection
select tests.act_as('u-sb'); select tests.prep('sb', 'post_shift'); select is(tests.submit('sb', 'post_shift'), null, 'setup: the driver submits their post-shift inspection');
select tests.act_as('sup1');
select matches(tests.ob_begin('sb', 'Redo it for me', 'sb-x'), '^55000:.*already been submitted', 'submitted: a submitted post-shift inspection cannot be redone on behalf');
select tests.reset();

-- ================================================================ 5. the allocation already post_inspection_pending (driver confirmed, could not finish)
select tests.sc('pip', 'A1', 'post_inspection_pending', now() - interval '4 hours', now() + interval '4 hours');
select tests.act_as('sup1');
select is(tests.ob_begin('pip', 'Driver went off sick', 'pip-x'), null, 'begin: an allocation already post_inspection_pending is accepted (no second move)');
select tests.reset();
select is((select count(*)::int from public.allocation_events where allocation_id = tests.al('pip') and new_value ->> 'status' = 'post_inspection_pending'), 0, '... and no status event is written');
-- other company
select tests.act_as('sup1');
select is(tests.ob_begin('b1', 'x', 'b1-x') like 'P0002:%', true, 'begin: a user cannot reach another company''s allocation');
select tests.reset();

-- ================================================================ 6. lists and privileges
select tests.act_as('sup1');
select is((select count(*)::int from public.list_inspections(now() - interval '1 day', now() + interval '1 day') where completed_by_role = 'supervisor_on_behalf'), 3, 'list_inspections: the on-behalf inspections are listed with completed_by_role');
select is((select count(*)::int from public.list_inspections(now() - interval '1 day', now() + interval '1 day') f where f.new_damage_flag), 0, 'list_inspections: new_damage_flag is a column');
select tests.reset();
select ok(has_function_privilege('authenticated', 'public.begin_inspection_on_behalf(uuid,text,timestamptz,boolean,uuid)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.begin_inspection_on_behalf(uuid,text,timestamptz,boolean,uuid)', 'EXECUTE'), 'begin_inspection_on_behalf: authenticated yes, anon no');
select ok(has_function_privilege('authenticated', 'public.my_inspection(uuid,text)', 'EXECUTE') and not has_function_privilege('anon', 'public.my_inspection(uuid,text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.inspection_load_for_driver(uuid)', 'EXECUTE'), 'my_inspection keeps its ACL; the completer check stays internal');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('inspection_load_for_driver', 'my_inspection', 'transition_allocation', 'submit_inspection') group by p.proname having count(*) > 1), 'no overloads: the replaced functions keep one signature each');

select * from finish();
rollback;
