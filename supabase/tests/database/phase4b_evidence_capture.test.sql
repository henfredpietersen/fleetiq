-- Slice 4B pgTAP: evidence capture context — restricted location, captured_offline, device, column grants, reviewer-only
-- evidence_capture_location(), the camera notice (migrations 042, 044; DEC-06, DEC-29, DEC-35). Synthetic data only; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(61);

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;
create function tests.id(n text) returns uuid language sql immutable as $$ select md5('fleetiq-test-' || n)::uuid $$;
create function tests.act_as(n text) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(n), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
end $$;
create function tests.as_service() returns void language plpgsql as $$
begin reset role; set local role service_role; end $$;
create function tests.reset() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims', '', true); end $$;
create function tests.sqlstate_of(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlstate; end $$;
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
create function tests.key(n text) returns uuid language sql immutable as $$ select md5('device-key-' || n)::uuid $$;
-- request a slot as `usr` (with the given context) and register it the way the server does; returns the evidence file id
create function tests.mk_file(lbl text, usr text, br text, lat numeric default null, lon numeric default null, acc numeric default null,
                              off boolean default false, dkey uuid default null) returns uuid language plpgsql as $$
declare s public.evidence_upload_slots; f uuid;
begin
  perform tests.act_as(usr);
  s := public.request_evidence_upload_slot('odometer', tests.id(br), 'in_app_camera', 'image/jpeg', 1000, tests.id('csid-' || lbl),
                                           null, 15, lat, lon, acc, off, dkey);
  perform tests.reset();
  f := public.register_evidence_file(s.id, tests.id(usr), md5(lbl) || md5(lbl), 'image/jpeg', 1000, 100, 100, true);
  return f;
end $$;
create function tests.fid(lbl text) returns uuid language sql stable security definer as $$
  select f.id from public.evidence_files f join public.evidence_upload_slots s on s.evidence_file_id = f.id where s.client_submission_id = tests.id('csid-' || lbl) $$;
create function tests.loc(who text, lbl text) returns text language plpgsql as $$
begin
  perform tests.act_as(who);
  return (select coalesce(latitude::text, 'null') || '|' || coalesce(longitude::text, 'null') || '|' || coalesce(accuracy_m::text, 'null') from public.evidence_capture_location(tests.fid(lbl)));
end $$;
create function tests.logs(lbl text) returns integer language sql stable security definer as $$
  select count(*)::int from public.evidence_access_log where evidence_file_id = tests.fid(lbl) and access_type = 'location_viewed' $$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('drv', 'coA', 'driver'), tests.mk_user('drv2', 'coA', 'driver'),
       tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'), tests.mk_user('supdrv', 'coA'), tests.mk_user('bm1', 'coA'), tests.mk_user('fa', 'coA'),
       tests.mk_user('ma', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('fab', 'coB');
select tests.grant_role('drv', 'driver', 'A1', 'boot'), tests.grant_role('drv2', 'driver', 'A1', 'boot'),
       tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sup2', 'supervisor', 'A2', 'boot'),
       tests.grant_role('supdrv', 'supervisor', 'A1', 'boot'), tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'),
       tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'),
       tests.grant_role('sa', 'system_admin', null, 'boot'), tests.grant_role('sm', 'senior_management', null, 'boot'),
       tests.grant_role('fab', 'fleet_admin', null, 'bootb');
-- a registered company device (as the register would hold it)
insert into public.company_devices (id, company_id, branch_id, device_key, label, created_by)
values (tests.id('dev1'), tests.id('coA'), tests.id('A1'), tests.key('known'), 'Synthetic phone', tests.id('boot'));

-- ================================================================ what is stored
select tests.mk_file('loc', 'drv', 'A1', -26.204103, 28.047305, 12.5, true, tests.key('known'));
select tests.mk_file('noloc', 'drv', 'A1');
select tests.mk_file('badloc', 'drv', 'A1', 200, 28.0, 5, false, tests.key('stranger'));
select tests.mk_file('half', 'drv', 'A1', -26.2, null, 5);
select is((select capture_latitude::text || '|' || capture_longitude::text || '|' || capture_location_accuracy_m::text from public.evidence_upload_slots where client_submission_id = tests.id('csid-loc')),
          '-26.204103|28.047305|12.5', 'slot: the location the phone sent is kept (six decimals, accuracy to 0.1 m)');
select is((select capture_latitude::text || '|' || capture_longitude::text || '|' || capture_location_accuracy_m::text from public.evidence_files where id = tests.fid('loc')),
          '-26.204103|28.047305|12.5', 'register copies the location to evidence_files');
select is((select captured_offline from public.evidence_files where id = tests.fid('loc')), true, 'captured_offline is stored when the phone says so');
select is((select device_id from public.evidence_files where id = tests.fid('loc')), tests.id('dev1'), 'a known device key resolves to company_devices.id and is stored');
select is((select capture_latitude is null and capture_longitude is null and capture_location_accuracy_m is null from public.evidence_files where id = tests.fid('noloc')), true, 'no location sent: the columns stay null');
select is((select captured_offline from public.evidence_files where id = tests.fid('noloc')), false, '... captured_offline defaults to false');
select is((select device_id from public.evidence_files where id = tests.fid('noloc')), null, '... and no device key means no device');
select is((select capture_latitude is null and capture_longitude is null from public.evidence_files where id = tests.fid('badloc')), true, 'an out-of-range location is not stored (and does not block the capture)');
select is((select device_id from public.evidence_files where id = tests.fid('badloc')), null, 'an unknown device key resolves to null, never an error');
select is((select capture_latitude is null and capture_longitude is null and capture_location_accuracy_m is null from public.evidence_files where id = tests.fid('half')), true, 'half a location (latitude only) is not stored');
select is((select exif_gps_stripped from public.evidence_files where id = tests.fid('loc')), true, 'exif_gps_stripped is kept: the stored file never carries GPS');
select is((select count(*)::int from pg_proc where proname = 'request_evidence_upload_slot' and pronamespace = 'public'::regnamespace), 1, 'one request_evidence_upload_slot (the old signature was dropped, no overload)');
select is((select count(*)::int from pg_proc where proname = 'register_evidence_file' and pronamespace = 'public'::regnamespace), 1, 'one register_evidence_file');
select tests.act_as('drv');
select is((select (public.request_evidence_upload_slot('odometer', tests.id('A1'), 'in_app_camera', 'image/jpeg', 1000, tests.id('csid-old'))).status), 'issued', 'the six-argument Phase 1 call still works (new parameters are optional)');
select is((select (public.request_evidence_upload_slot('odometer', tests.id('A1'), 'in_app_camera', 'image/jpeg', 1000, tests.id('csid-loc'), null, 15, 1, 1, 1, true, null)).status), 'registered',
          'an idempotent retry returns the same (registered) slot whatever context it carries');
select tests.reset();
select ok(not exists (select 1 from public.audit_logs where entity_type = 'evidence_files' and (after_values ? 'capture_latitude' or after_values ? 'capture_longitude' or after_values ? 'capture_location_accuracy_m')),
          'audit_logs never receives a capture location');
select ok(exists (select 1 from public.audit_logs where entity_type = 'evidence_files' and action = 'insert'), '... though evidence inserts are still audited');

-- ================================================================ the location columns are readable by NO role through the table
select ok(not has_column_privilege('authenticated', 'public.evidence_files', 'capture_latitude', 'SELECT')
          and not has_column_privilege('authenticated', 'public.evidence_files', 'capture_longitude', 'SELECT')
          and not has_column_privilege('authenticated', 'public.evidence_files', 'capture_location_accuracy_m', 'SELECT'), 'authenticated has no SELECT on the evidence_files location columns');
select ok(not has_column_privilege('service_role', 'public.evidence_files', 'capture_latitude', 'SELECT')
          and not has_column_privilege('service_role', 'public.evidence_files', 'capture_longitude', 'SELECT')
          and not has_column_privilege('service_role', 'public.evidence_files', 'capture_location_accuracy_m', 'SELECT'), 'service_role has none either');
select ok(not has_column_privilege('anon', 'public.evidence_files', 'capture_latitude', 'SELECT'), 'anon has none');
select ok(has_column_privilege('authenticated', 'public.evidence_files', 'id', 'SELECT') and has_column_privilege('authenticated', 'public.evidence_files', 'device_id', 'SELECT')
          and has_column_privilege('authenticated', 'public.evidence_files', 'captured_offline', 'SELECT'), 'the other columns stay readable (RLS still decides which rows)');
select ok(not has_column_privilege('authenticated', 'public.evidence_upload_slots', 'capture_latitude', 'SELECT')
          and not has_column_privilege('authenticated', 'public.evidence_upload_slots', 'capture_longitude', 'SELECT')
          and not has_column_privilege('authenticated', 'public.evidence_upload_slots', 'capture_location_accuracy_m', 'SELECT')
          and not has_column_privilege('service_role', 'public.evidence_upload_slots', 'capture_latitude', 'SELECT'), 'the slot''s location columns are closed too');
select tests.act_as('sup1');
select is(tests.sqlstate_of('select capture_latitude from public.evidence_files'), '42501', 'a supervisor reading the column through the table is refused');
select is(tests.sqlstate_of('select * from public.evidence_files'), '42501', '... and so is select * (explicit columns are required)');
select cmp_ok((select count(*)::int from (select id, device_id, captured_offline from public.evidence_files) q), '>', 0, '... while the granted columns work');
select tests.act_as('drv');
select is(tests.sqlstate_of('select capture_longitude from public.evidence_files'), '42501', 'the uploader cannot read their own file''s location through the table');
select is(tests.sqlstate_of('select capture_latitude from public.evidence_upload_slots'), '42501', '... nor from their slot');
select tests.as_service();
select is(tests.sqlstate_of('select capture_location_accuracy_m from public.evidence_files'), '42501', 'the service role cannot read the column through the table either');
select cmp_ok((select count(*)::int from (select bucket, object_path from public.evidence_files) q), '>', 0, '... but still reads the columns the cleanup job needs');
select tests.reset();

-- ================================================================ evidence_capture_location: reviewers only, always logged
select is(tests.logs('loc'), 0, 'no location views logged yet');
select is(tests.loc('sup1', 'loc'), '-26.204103|28.047305|12.5', 'a supervisor of the branch can see the location');
select is(tests.logs('loc'), 1, '... and the view is logged (location_viewed)');
select tests.reset();
select is((select accessed_by from public.evidence_access_log where evidence_file_id = tests.fid('loc') and access_type = 'location_viewed' limit 1), tests.id('sup1'), '... against the reviewer');
select is(tests.loc('bm1', 'loc'), '-26.204103|28.047305|12.5', 'a branch manager of the branch can see it');
select is(tests.loc('fa', 'loc'), '-26.204103|28.047305|12.5', 'a fleet administrator can see it');
select is(tests.logs('loc'), 3, '... every call logged');
select is(tests.loc('sup1', 'noloc'), 'null|null|null', 'a file without a location returns nulls (and the call is logged)') ;
select is(tests.logs('noloc'), 1, '... logged');
select tests.mk_file('own', 'supdrv', 'A1', -26.1, 28.1, 5);
select tests.act_as('supdrv');
select is(tests.sqlstate_of(format('select * from public.evidence_capture_location(%L)', tests.fid('own'))), '42501', 'DEC-29: even a supervisor never sees the location of a photo they took themselves');
select tests.act_as('drv');
select is(tests.sqlstate_of(format('select * from public.evidence_capture_location(%L)', tests.fid('loc'))), '42501', 'the uploading driver is refused');
select tests.act_as('drv2');
select is(tests.sqlstate_of(format('select * from public.evidence_capture_location(%L)', tests.fid('loc'))), '42501', 'another driver is refused');
select tests.act_as('sup2');
select is(tests.sqlstate_of(format('select * from public.evidence_capture_location(%L)', tests.fid('loc'))), '42501', 'a supervisor of another branch is refused');
select tests.act_as('ma');
select is(tests.sqlstate_of(format('select * from public.evidence_capture_location(%L)', tests.fid('loc'))), '42501', 'a maintenance administrator is refused');
select tests.act_as('sa');
select is(tests.sqlstate_of(format('select * from public.evidence_capture_location(%L)', tests.fid('loc'))), '42501', 'a system administrator is refused');
select tests.act_as('sm');
select is(tests.sqlstate_of(format('select * from public.evidence_capture_location(%L)', tests.fid('loc'))), '42501', 'senior management (view-only, no review permission) is refused');
select tests.act_as('fab');
select is(tests.sqlstate_of(format('select * from public.evidence_capture_location(%L)', tests.fid('loc'))), '42501', 'another company''s administrator is refused');
select is(tests.sqlstate_of(format('select * from public.evidence_capture_location(%L)', gen_random_uuid())), '42501', 'an unknown file looks the same (nothing to learn)');
select tests.reset();
select is(tests.logs('loc'), 3, 'refused calls are not logged as views');
select tests.act_as('sup1');
select is(public.evidence_object_readable('evidence', (select object_path from public.evidence_files where id = tests.fid('loc'))), false, 'a location view does not open the photo (only a signed_url_issued grant does)');
select tests.reset();
select ok(tests.sqlstate_of($$ insert into public.evidence_access_log (company_id, branch_id, evidence_file_id, accessed_by, access_type) select company_id, branch_id, id, uploaded_by, 'bogus' from public.evidence_files limit 1 $$) = '23514', 'access_type still only accepts the known kinds');
select ok(has_function_privilege('authenticated', 'public.request_evidence_upload_slot(text, uuid, text, text, bigint, uuid, timestamptz, integer, numeric, numeric, numeric, boolean, uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.register_evidence_file(uuid, uuid, text, text, bigint, integer, integer, boolean)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.register_evidence_file(uuid, uuid, text, text, bigint, integer, integer, boolean)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.evidence_capture_location(uuid)', 'EXECUTE'), 'ACLs: request = users, register = service role only, location = signed-in users (and checked inside)');

-- ================================================================ the camera notice (PRD §6)
select tests.act_as('drv');
select is(public.camera_notice_acknowledged('2026-11-24'), false, 'notice: not acknowledged before the driver taps "I understand"');
select is(tests.sqlstate_of($$ select public.acknowledge_camera_notice('2026-11-24') $$), null, 'notice: acknowledging records it');
select is(tests.sqlstate_of($$ select public.acknowledge_camera_notice('2026-11-24') $$), null, 'notice: acknowledging again is harmless');
select is(public.camera_notice_acknowledged('2026-11-24'), true, '... acknowledged');
select is(public.camera_notice_acknowledged('2027-01-01'), false, '... per notice version (a new text is asked again)');
select is((select count(*)::int from public.camera_notice_acknowledgements), 1, 'one row per person and version');
select tests.act_as('drv2');
select is((select count(*)::int from public.camera_notice_acknowledgements), 0, 'nobody sees another person''s acknowledgement');
select tests.act_as('drv');
select ok(tests.sqlstate_of($$ update public.camera_notice_acknowledgements set notice_version = 'x' $$) is not null, 'acknowledgements cannot be updated by clients');
select ok(tests.sqlstate_of($$ insert into public.camera_notice_acknowledgements (company_id, profile_id, notice_version) select company_id, id, 'z' from public.profiles limit 1 $$) is not null, '... or inserted directly');
select tests.reset();
select ok(tests.sqlstate_of($$ delete from public.camera_notice_acknowledgements $$) is not null, 'append-only even for the table owner');

select * from finish();
rollback;
