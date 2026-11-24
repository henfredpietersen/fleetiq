-- Slice 4B pgTAP: the device flag on submitted inspections (migration 043; DEC-35). The photo's device is compared with the
-- driver's issued device at submit time; another phone is FLAGGED, never refused. Synthetic data only; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

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
end $$;
create function tests.n(q text) returns integer language plpgsql as $$
declare r integer; begin execute q into r; return r; end $$;

-- an allocation (planned_s .. planned_e) INSIDE a longer shift (shift_s .. shift_e), in the given status
create function tests.sc2(label text, astatus text, shift_s timestamptz, shift_e timestamptz, planned_s timestamptz, planned_e timestamptz) returns void language plpgsql as $$
begin
  perform tests.mk_driver('u-' || label, 'coA', 'E-' || upper(label), 'A1');
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('v-' || label), tests.id('coA'), tests.id('A1'), 'FL-' || label, upper('T4B' || label), 'Make', 'Model', 'bakkie');
  insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('sh-' || label), tests.id('coA'), tests.id('A1'), (shift_s at time zone 'Africa/Johannesburg')::date, shift_s, shift_e, gen_random_uuid(), tests.id('boot'));
  insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, status, started_at,
                                          opened_at, opened_by, licence_class_check, client_submission_id, created_by)
  values (tests.id('al-' || label), tests.id('coA'), tests.id('A1'), tests.id('v-' || label), tests.id('d-u-' || label), tests.id('sh-' || label),
          planned_s, planned_e, astatus, case when astatus in ('in_use', 'post_inspection_pending') then planned_s end,
          planned_s, tests.id('u-' || label), 'matched', gen_random_uuid(), tests.id('boot'));
  perform tests.mk_file('fo-' || label || '-pre', 'u-' || label, 'A1');
  perform tests.mk_file('fo-' || label || '-post', 'u-' || label, 'A1');
end $$;
-- ---------------------------------------------------------------- fixtures
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A');
insert into public.branches (id, company_id, name, branch_code) values (tests.id('A1'), tests.id('coA'), 'A one', 'A1');
select tests.mk_user('boot', 'coA');
select public.seed_starter_inspection_template(tests.id('coA'));
select tests.mk_user('sup1', 'coA');
select tests.grant_role('sup1', 'supervisor', 'A1', 'boot');


-- an odometer file taken on the given company device (null = no / unknown device)
create function tests.mk_filed(n text, uploader text, dev uuid) returns void language sql as $$
  insert into public.evidence_files (id, company_id, branch_id, bucket, object_path, sha256, mime_type, size_bytes, capture_source, exif_gps_stripped, uploaded_by, purpose, device_id)
  select tests.id('f-' || n), p.company_id, tests.id('A1'), 'evidence', 'test/' || n, md5(n) || md5(n), 'image/jpeg', 1000, 'in_app_camera', true, p.id, 'odometer', dev
    from public.profiles p where p.id = tests.id(uploader);
$$;
-- begin + answer everything + confirm + attach the named file => ready to submit (as the driver)
create function tests.prepf(label text, filelabel text) returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.begin_inspection(tests.al(label), 'pre_shift', null, false, tests.csid(label || 'b'));
  perform public.save_inspection_responses(v, tests.answers('pre_shift'), true, tests.csid(label || 's'));
  perform public.attach_odometer_photo(v, tests.id('f-' || filelabel), tests.csid(label || 'o'));
  return v;
end $$;
create function tests.devk(n text) returns uuid language sql immutable as $$ select md5('device-' || n)::uuid $$;
create function tests.flag(label text) returns text language sql stable as $$ select device_flag from public.inspections where allocation_id = tests.al(label) and status <> 'void' $$;

select tests.sc2('iss',   'pre_inspection_pending', now() - interval '1 hour', now() + interval '9 hours', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc2('oth',   'pre_inspection_pending', now() - interval '1 hour', now() + interval '9 hours', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc2('unk',   'pre_inspection_pending', now() - interval '1 hour', now() + interval '9 hours', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc2('noi',   'pre_inspection_pending', now() - interval '1 hour', now() + interval '9 hours', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc2('noi2',  'pre_inspection_pending', now() - interval '1 hour', now() + interval '9 hours', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc2('lost',  'pre_inspection_pending', now() - interval '1 hour', now() + interval '9 hours', now() - interval '10 minutes', now() + interval '8 hours');
select tests.sc2('pst',   'in_use', now() - interval '10 hours', now() + interval '1 hour', now() - interval '9 hours', now() - interval '10 minutes');
select tests.sc2('rtk',   'pre_inspection_pending', now() - interval '1 hour', now() + interval '9 hours', now() - interval '10 minutes', now() + interval '8 hours');

-- the register: dA -> iss, dB -> oth, dD -> unk, dF -> rtk, dE (lost, assignment closed) was lost's, dC a spare phone nobody holds
insert into public.company_devices (id, company_id, branch_id, device_key, label, assigned_driver_id, assigned_from, assigned_to, status, created_by) values
  (tests.id('dA'), tests.id('coA'), tests.id('A1'), tests.devk('A'), 'A', tests.id('d-u-iss'), now() - interval '2 days', null, 'active', tests.id('boot')),
  (tests.id('dB'), tests.id('coA'), tests.id('A1'), tests.devk('B'), 'B', tests.id('d-u-oth'), now() - interval '2 days', null, 'active', tests.id('boot')),
  (tests.id('dC'), tests.id('coA'), tests.id('A1'), tests.devk('C'), 'C (spare)', null, null, null, 'active', tests.id('boot')),
  (tests.id('dD'), tests.id('coA'), tests.id('A1'), tests.devk('D'), 'D', tests.id('d-u-unk'), now() - interval '2 days', null, 'active', tests.id('boot')),
  (tests.id('dE'), tests.id('coA'), tests.id('A1'), tests.devk('E'), 'E (lost)', tests.id('d-u-lost'), now() - interval '2 days', now() - interval '1 day', 'lost', tests.id('boot')),
  (tests.id('dF'), tests.id('coA'), tests.id('A1'), tests.devk('F'), 'F', tests.id('d-u-rtk'), now() - interval '2 days', null, 'active', tests.id('boot'));
select tests.mk_filed('iss',   'u-iss',  tests.id('dA'));
select tests.mk_filed('oth',   'u-oth',  tests.id('dC'));
select tests.mk_filed('unk',   'u-unk',  null);
select tests.mk_filed('noi',   'u-noi',  tests.id('dC'));
select tests.mk_filed('noi2',  'u-noi2', null);
select tests.mk_filed('lost',  'u-lost', tests.id('dE'));
select tests.mk_filed('rtk1',  'u-rtk',  tests.id('dC'));
select tests.mk_filed('rtk2',  'u-rtk',  tests.id('dF'));

-- ================================================================ the comparison, as a function
select is(public.inspection_device_flag(tests.id('coA'), tests.id('d-u-iss'), tests.id('dA')), 'issued_device', 'flag: the driver''s own issued device');
select is(public.inspection_device_flag(tests.id('coA'), tests.id('d-u-iss'), tests.id('dC')), 'other_device', 'flag: a registered device that is not theirs');
select is(public.inspection_device_flag(tests.id('coA'), tests.id('d-u-iss'), null), 'unknown_device', 'flag: no registered device on the photo');
select is(public.inspection_device_flag(tests.id('coA'), tests.id('d-u-noi'), tests.id('dC')), 'no_issued_device', 'flag: the driver has no issued device (even with a registered phone)');
select is(public.inspection_device_flag(tests.id('coA'), tests.id('d-u-lost'), tests.id('dE')), 'no_issued_device', 'flag: a lost device is no longer an issued device');

-- ================================================================ through submit_inspection
select tests.act_as('u-iss'); select tests.prepf('iss', 'iss');
select tests.reset();
select is((select device_flag from public.inspections where allocation_id = tests.al('iss')), null, 'a draft has no device flag yet');
select ok(tests.sqlstate_of(format('update public.inspections set device_flag = ''issued_device'' where allocation_id = %L', tests.al('iss'))) = '23514', 'a draft''s device flag cannot be set by hand (only submit_inspection does)');
select ok(tests.sqlstate_of(format('update public.inspections set device_flag = ''nonsense'' where allocation_id = %L', tests.al('iss'))) is not null, 'an unknown flag value is refused');
select tests.act_as('u-iss'); select is(tests.submit('iss'), null, 'submit from the issued device succeeds');
select tests.act_as('u-oth'); select tests.prepf('oth', 'oth'); select is(tests.submit('oth'), null, 'submit from ANOTHER device succeeds: a flag never blocks');
select tests.act_as('u-unk'); select tests.prepf('unk', 'unk'); select is(tests.submit('unk'), null, 'submit with no registered device succeeds');
select tests.act_as('u-noi'); select tests.prepf('noi', 'noi'); select is(tests.submit('noi'), null, 'submit by a driver with no issued device succeeds');
select tests.act_as('u-noi2'); select tests.prepf('noi2', 'noi2'); select is(tests.submit('noi2'), null, 'submit by a driver with no issued device and no registered phone succeeds');
select tests.act_as('u-lost'); select tests.prepf('lost', 'lost'); select is(tests.submit('lost'), null, 'submit from a lost device succeeds');
select tests.act_as('u-rtk'); select tests.prepf('rtk', 'rtk1');
select tests.reset();
select tests.act_as('u-rtk');
select public.attach_odometer_photo(tests.ins('rtk'), tests.id('f-rtk2'), tests.csid('rtk-retake'));
select is(tests.submit('rtk'), null, 'a retaken odometer photo (new device) then submit succeeds');
select tests.reset();
select is(tests.flag('iss'), 'issued_device', 'stored: issued_device');
select is(tests.flag('oth'), 'other_device', 'stored: other_device');
select is(tests.flag('unk'), 'unknown_device', 'stored: unknown_device');
select is(tests.flag('noi'), 'no_issued_device', 'stored: no_issued_device (registered phone, no issue)');
select is(tests.flag('noi2'), 'no_issued_device', 'stored: no_issued_device (nothing at all)');
select is(tests.flag('lost'), 'no_issued_device', 'stored: no_issued_device (the issued phone was marked lost)');
select is(tests.flag('rtk'), 'issued_device', 'stored: the CURRENT odometer photo decides (the retake was on the issued device)');
select is((select device_id from public.inspections where allocation_id = tests.al('iss')), tests.id('dA'), 'inspections.device_id is the photo''s device');
select is((select device_id from public.inspections where allocation_id = tests.al('oth')), tests.id('dC'), '... also when it is another device');
select is((select device_id from public.inspections where allocation_id = tests.al('unk')), null, '... and null when unknown');
select is((select status from public.vehicle_allocations where id = tests.al('oth')), 'in_use', 'the allocation still starts when the device is flagged');
select ok(tests.sqlstate_of(format('update public.inspections set device_flag = ''issued_device'' where allocation_id = %L', tests.al('oth'))) = '55000', 'a submitted inspection''s flag is immutable');

-- ================================================================ the driver's card: post-shift submitted (migration 045)
select tests.act_as('u-iss');
select is((select post_shift_submitted from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, 'my_allocations: no post-shift inspection yet');
select tests.act_as('u-pst'); select tests.prep('pst', 'post_shift');
select is((select post_shift_submitted from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, 'my_allocations: a post-shift DRAFT is not "submitted" (the allocation is already post-inspection pending)');
select is(tests.submit('pst', 'post_shift'), null, 'the post-shift inspection submits');
select is((select post_shift_submitted from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), true, 'my_allocations: submitted -> the card can say "Awaiting post-shift closure"');
select is((select status from public.vehicle_allocations where id = tests.al('pst')), 'post_inspection_pending', '... and the allocation stays post-inspection pending (closure is Phase 5)');
select tests.reset();

-- ================================================================ the supervisor's list carries the flag
select tests.act_as('sup1');
select is((select device_flag from public.list_inspections(now() - interval '1 day', now() + interval '1 day', tests.id('A1')) where inspection_id = tests.ins('oth')), 'other_device', 'list_inspections shows the device flag');
select is((select count(*)::int from public.list_inspections(now() - interval '1 day', now() + interval '1 day', tests.id('A1'))), 8, '... and still lists the branch''s inspections');
select tests.reset();
select ok(not has_function_privilege('authenticated', 'public.inspection_device_flag(uuid, uuid, uuid)', 'EXECUTE'), 'inspection_device_flag is internal (no client grant)');
select ok(has_function_privilege('authenticated', 'public.submit_inspection(uuid, timestamptz, boolean, uuid)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.submit_inspection(uuid, timestamptz, boolean, uuid)', 'EXECUTE'), 'submit_inspection keeps its signature and ACL');
select ok(has_function_privilege('authenticated', 'public.list_inspections(timestamptz, timestamptz, uuid, integer)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.list_inspections(timestamptz, timestamptz, uuid, integer)', 'EXECUTE'), 'list_inspections keeps its ACL');

select * from finish();
rollback;
