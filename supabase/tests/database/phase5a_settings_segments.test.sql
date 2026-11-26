-- Slice 5A pgTAP: odometer validation settings and segments (migration 051; DEC-12..18, DEC-23, DEC-24).
-- One company-default row in effect, a category row wins, overlap refused, allocation_settings reads the table, history kept, audit, segments.
-- Synthetic data only; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(52);

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
create function tests.mk_vehicle(label text, comp text, branch text, category text default 'bakkie') returns void language sql as $$
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('v-' || label), tests.id(comp), tests.id(branch), 'FL-' || label, upper('T5A' || label), 'Make', 'Model', category);
$$;
create function tests.cs(n text) returns uuid language sql immutable as $$ select md5('cs-' || n)::uuid $$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('fa', 'coA'), tests.mk_user('fa-a1', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('sup', 'coA'),
       tests.mk_user('ma', 'coA'), tests.mk_user('bm', 'coA'), tests.mk_user('fab', 'coB'), tests.mk_user('bootb', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('fa-a1', 'fleet_admin', 'A1', 'boot'), tests.grant_role('sa', 'system_admin', null, 'boot'),
       tests.grant_role('sup', 'supervisor', 'A1', 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'), tests.grant_role('bm', 'branch_manager', 'A1', 'boot'),
       tests.grant_role('fab', 'fleet_admin', null, 'bootb');
select tests.mk_vehicle('bk', 'coA', 'A1', 'bakkie'), tests.mk_vehicle('tr', 'coA', 'A1', 'truck');

-- ================================================================ 1. the seeded company default (DEC-12..18)
select is((select count(*)::int from public.odometer_validation_settings where company_id = tests.id('coA') and effective_to is null), 1, 'a new company gets exactly one version in effect (trigger)');
select is((select version || '/' || ocr_driver_tolerance_km || '/' || unaccounted_tolerance_km || '/' || pre_shift_late_minutes || '/' || post_shift_late_minutes || '/' || stale_reading_days
             from public.odometer_validation_settings where company_id = tests.id('coA')), '1/0/5/30/60/7', 'version 1 = 0 / 5 / 30 / 60 / 7 (DEC-14, 16, 17, 18)');
select is((select max_km_per_allocation is null and ocr_min_confidence is null and vehicle_category is null from public.odometer_validation_settings where company_id = tests.id('coA')), true, 'DEC-13 / DEC-15: no default (both null), company default (null category)');
select is((select count(*)::int from public.odometer_validation_settings where company_id = tests.id('coB')), 1, 'every company has one');
select is((select count(*)::int from (select company_id from public.odometer_validation_settings where vehicle_category is null and effective_to is null group by company_id having count(*) <> 1) x), 0, 'one row in effect per company');

-- ================================================================ 2. lookups: the category row wins, else the company default; ONE place
select is((select id from public.validation_settings_for(tests.id('v-bk'))), (select id from public.odometer_validation_settings where company_id = tests.id('coA') and version = 1), 'no category row: the company default applies');
select tests.act_as('fa');
select public.set_validation_settings('bakkie', 900, null, 0, 8, 20, 40, 3, 'Tests: bakkies', tests.cs('s1'));
select tests.reset();
select is((select unaccounted_tolerance_km || '/' || max_km_per_allocation from public.validation_settings_for(tests.id('v-bk'))), '8/900', 'a category row wins for a vehicle of that category');
select is((select unaccounted_tolerance_km from public.validation_settings_for(tests.id('v-tr'))), 5, 'another category still gets the company default');
select is((select vehicle_category from public.company_validation_settings(tests.id('coA'))), null, 'company_validation_settings is the company default row');

-- ================================================================ 3. allocation_settings reads the table (the late window has ONE source)
select is((select pre_shift_late_minutes || '/' || post_shift_late_minutes || '/' || open_before_start_minutes || '/' || no_show_grace_minutes from public.allocation_settings(tests.id('coA'))), '30/60/60/30', 'allocation_settings: 30 / 60 from the seeded row, 60 / 30 unchanged (DEC-40)');
select tests.act_as('fa');
select public.set_validation_settings(null, null, null, 0, 5, 45, 90, 7, 'Tests: wider late window', tests.cs('s2'));
select tests.reset();
select is((select pre_shift_late_minutes || '/' || post_shift_late_minutes from public.allocation_settings(tests.id('coA'))), '45/90', 'allocation_settings follows the company default row in effect now');
select is((select pre_shift_late_minutes || '/' || post_shift_late_minutes from public.allocation_settings(tests.id('coB'))), '30/60', 'another company is unaffected');
select is(has_function_privilege('authenticated', 'public.allocation_settings(uuid)', 'execute'), false, 'allocation_settings stays internal (no client grant)');
select is((select count(*)::int from public.odometer_validation_settings where company_id = tests.id('coA') and vehicle_category is null and effective_to is null), 1, 'still exactly one company-default row in effect');

-- ================================================================ 4. who may change settings; history; audit
select tests.act_as('fa-a1');
select is(tests.err_of(format('select public.set_validation_settings(null, null, null, 0, 5, 30, 60, 7, %L, %L)', 'Tests: x', tests.cs('x1'))) like '42501:%', true, 'a branch-scoped grant is not enough: company-wide only');
select tests.act_as('sup');
select is(tests.err_of(format('select public.set_validation_settings(null, null, null, 0, 5, 30, 60, 7, %L, %L)', 'Tests: x', tests.cs('x2'))) like '42501:%', true, 'a supervisor cannot change settings');
select tests.act_as('bm');
select is(tests.err_of(format('select public.set_validation_settings(null, null, null, 0, 5, 30, 60, 7, %L, %L)', 'Tests: x', tests.cs('x3'))) like '42501:%', true, 'a branch manager cannot');
select tests.act_as('ma');
select is(tests.err_of(format('select public.set_validation_settings(null, null, null, 0, 5, 30, 60, 7, %L, %L)', 'Tests: x', tests.cs('x4'))) like '42501:%', true, 'a maintenance administrator cannot');
select tests.act_as('sa');
select is(tests.err_of(format('select public.set_validation_settings(null, 700, null, 0, 5, 45, 90, 7, %L, %L)', 'Tests: system admin sets the maximum', tests.cs('x5'))), null, 'a system administrator (settings.validation.manage) can');
select tests.act_as('fa');
select matches(tests.err_of(format('select public.set_validation_settings(null, null, null, 0, 5, 30, 60, 7, null, %L)', tests.cs('x6'))), '^22023:.*reason', 'a reason is required');
select matches(tests.err_of(format('select public.set_validation_settings(null, null, null, -1, 5, 30, 60, 7, %L, %L)', 'r', tests.cs('x7'))), '^22023:', 'a negative value is refused');
select matches(tests.err_of(format('select public.set_validation_settings(null, null, 1.5, 0, 5, 30, 60, 7, %L, %L)', 'r', tests.cs('x8'))), '^22023:', 'a confidence above 1 is refused');
select is(tests.err_of(format('select public.set_validation_settings(null, null, null, 0, 5, 30, 60, 7, %L, null)', 'r')) like '22023:%', true, 'client_submission_id is required');
select tests.act_as('sa');
select is(public.set_validation_settings(null, 700, null, 0, 5, 45, 90, 7, 'Tests: system admin sets the maximum', tests.cs('x5')), (select id from public.odometer_validation_settings where client_submission_id = tests.cs('x5')), 'idempotent: the same id and values return the same version');
select matches(tests.err_of(format('select public.set_validation_settings(null, 701, null, 0, 5, 45, 90, 7, %L, %L)', 'Tests: system admin sets the maximum', tests.cs('x5'))), '^22023:.*already used', 'the same id with other values is refused');
select tests.act_as('fab');
select tests.reset();
select is((select count(*)::int from public.odometer_validation_settings where company_id = tests.id('coA') and vehicle_category is null), 3, 'history is kept: versions 1 (seed), 2 and 3 of the company default');
select is((select count(*)::int from public.odometer_validation_settings where company_id = tests.id('coA') and vehicle_category is null and effective_to is not null), 2, 'every superseded version is closed (effective_to set), none deleted');
select is((select array_agg(version order by version) from public.odometer_validation_settings where company_id = tests.id('coA') and vehicle_category is null), array[1, 2, 3], 'versions count up');
select is((select effective_to = (select effective_from from public.odometer_validation_settings s2 where s2.company_id = s.company_id and s2.vehicle_category is null and s2.version = 2) from public.odometer_validation_settings s where s.company_id = tests.id('coA') and s.vehicle_category is null and s.version = 1), true, 'the next version starts exactly when the previous one ends');
select is(tests.sqlstate_of(format('update public.odometer_validation_settings set unaccounted_tolerance_km = 99 where company_id = %L and vehicle_category is null and version = 3', tests.id('coA'))), '23514', 'a version''s values cannot be edited');
select is(tests.sqlstate_of(format('update public.odometer_validation_settings set effective_to = now() where company_id = %L and version = 1', tests.id('coA'))), '55000', 'a closed version cannot change');
select is(tests.sqlstate_of('delete from public.odometer_validation_settings'), '42501', 'settings are never deleted');
select is(tests.sqlstate_of(format($q$insert into public.odometer_validation_settings (company_id, vehicle_category, version, effective_from) values (%L, null, 9, now() - interval '1 day')$q$, tests.id('coA'))), '23P01', 'overlapping effective ranges per (company, category) are refused');
select is(tests.sqlstate_of(format($q$insert into public.odometer_validation_settings (company_id, vehicle_category, version, effective_from, ocr_min_confidence) values (%L, 'x', 1, now(), 1.5)$q$, tests.id('coA'))), '23514', 'confidence must be between 0 and 1 (CHECK)');
select is(tests.sqlstate_of(format($q$insert into public.odometer_validation_settings (company_id, vehicle_category, version, effective_from, unaccounted_tolerance_km) values (%L, 'x', 1, now(), -1)$q$, tests.id('coA'))), '23514', 'distances must be non-negative (CHECK)');
select is(tests.sqlstate_of(format($q$insert into public.odometer_validation_settings (company_id, vehicle_category, version, effective_from, effective_to) values (%L, 'x', 1, now(), now() - interval '1 hour')$q$, tests.id('coA'))), '23514', 'effective_to must be after effective_from');
select ok((select count(*) from public.audit_logs where entity_type = 'odometer_validation_settings' and reason = 'Tests: wider late window') >= 1, 'audited: the change and its reason are in the audit log');
select tests.act_as('fa');
select tests.act_as('sup');
select is((select count(*)::int from public.odometer_validation_settings), 0, 'a supervisor reads no settings rows (RLS)');
select tests.act_as('fa-a1');
select is((select count(*)::int from public.odometer_validation_settings), 0, 'a branch-scoped holder reads none (company-wide only)');
select tests.act_as('sa');
select ok((select count(*)::int from public.odometer_validation_settings) >= 4, 'a settings manager reads the history');
select tests.reset();

-- ================================================================ 5. segments
select is((select count(*)::int from public.odometer_segments where vehicle_id = tests.id('v-bk') and ends_at is null and segment_number = 1 and offset_km = 0), 1, 'a new vehicle gets segment 1 (offset 0) automatically');
select is((select starts_at from public.odometer_segments where vehicle_id = tests.id('v-bk')), (select created_at from public.vehicles where id = tests.id('v-bk')), 'starting at the vehicle''s created_at');
select is((select count(*)::int from public.vehicles v where (select count(*) from public.odometer_segments s where s.vehicle_id = v.id and s.ends_at is null) <> 1), 0, 'every vehicle has exactly one open segment');
select is(tests.sqlstate_of(format('insert into public.odometer_segments (company_id, vehicle_id, segment_number, starts_at, offset_km) values (%L, %L, 2, now(), 0)', tests.id('coA'), tests.id('v-bk'))), '23505', 'a second open segment for a vehicle is refused');
select is(public.odometer_lifetime_km((select id from public.odometer_segments where vehicle_id = tests.id('v-bk')), 12345), 12345, 'lifetime_km = displayed + offset (offset 0)');
update public.odometer_segments set ends_at = now() + interval '1 second' where vehicle_id = tests.id('v-tr');
insert into public.odometer_segments (company_id, vehicle_id, segment_number, starts_at, offset_km) values (tests.id('coA'), tests.id('v-tr'), 2, now() + interval '1 second', 50000);
select is(public.odometer_lifetime_km((select id from public.odometer_segments where vehicle_id = tests.id('v-tr') and ends_at is null), 120), 50120, 'lifetime_km = displayed + offset (offset 50 000)');
select is(tests.sqlstate_of(format('update public.odometer_segments set offset_km = 7 where vehicle_id = %L and segment_number = 2', tests.id('v-tr'))), '23514', 'a segment''s offset cannot change');
select is(tests.sqlstate_of('delete from public.odometer_segments'), '42501', 'segments are never deleted');
select tests.act_as('sup');
select ok((select count(*) from public.odometer_segments) >= 2, 'a supervisor reads the segments of their branch''s vehicles');
select tests.act_as('ma');
select is((select count(*)::int from public.odometer_segments), 0, 'a maintenance administrator does not');
select tests.act_as('sup');
select is(tests.sqlstate_of('insert into public.odometer_segments (company_id, vehicle_id, segment_number, starts_at) values (gen_random_uuid(), gen_random_uuid(), 1, now())'), '42501', 'no client write on segments');
select tests.reset();
select ok(exists (select 1 from public.audit_logs where entity_type = 'odometer_segments' and action = 'insert'), 'segment creation is audited');
select * from finish();
rollback;
