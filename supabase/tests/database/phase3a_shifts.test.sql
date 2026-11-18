-- Slice 3A pgTAP: shift templates and shifts (migration 027; DB v1.6 §5, §20; PRD v1.11 §4.2, §5.5; AD-06; DEC-23).
-- Synthetic data only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(173);

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;
create function tests.id(n text) returns uuid language sql immutable as $$ select md5('fleetiq-test-' || n)::uuid $$;
create function tests.act_as(n text, aal text default 'aal2') returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(n), 'role', 'authenticated', 'aal', aal)::text, true);
  set local role authenticated;
end $$;
create function tests.act_anon() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims', '', true); set local role anon; end $$;
create function tests.act_service() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims', '', true); set local role service_role; end $$;
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
  select tests.id(n), r.id, p.company_id, case when branch is null then null else tests.id(branch) end,
         now() - interval '5 hours', tests.id(by)
  from public.roles r, public.profiles p where r.name = role_name and r.company_id is null and p.id = tests.id(n);
$$;
-- ids returned by functions, readable by every role the tests act as
create table tests.kv (k text primary key, v uuid);
grant select, insert on tests.kv to public;
create function tests.k(key text) returns uuid language sql stable as $$ select v from tests.kv where k = key $$;
-- audit rows for an entity, limited to this test's own companies (the local seed also writes audit rows)
create function tests.audit_n(tbl text, act text, like_reason text default '%') returns integer language sql as $$
  select count(*)::int from public.audit_logs where entity_type = tbl and action = act and coalesce(reason, '') like like_reason
     and company_id in (tests.id('coA'), tests.id('coB')) $$;

-- ---------------------------------------------------------------- fixtures (synthetic)
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
insert into public.departments (id, company_id, branch_id, name, status) values
  (tests.id('dA1'), tests.id('coA'), tests.id('A1'), 'Dept A1', 'active'),
  (tests.id('dA2'), tests.id('coA'), tests.id('A2'), 'Dept A2', 'active'),
  (tests.id('dCo'), tests.id('coA'), null, 'Dept company-wide', 'active'),
  (tests.id('dOff'), tests.id('coA'), tests.id('A1'), 'Dept inactive', 'inactive'),
  (tests.id('dB'), tests.id('coB'), tests.id('B1'), 'Dept B', 'active');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB');
select tests.mk_user('fa', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'), tests.mk_user('bm1', 'coA'),
       tests.mk_user('ma', 'coA'), tests.mk_user('ma_a2', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('sa', 'coA'),
       tests.mk_user('drv', 'coA', 'driver'), tests.mk_user('fab', 'coB'), tests.mk_user('nobody', 'coA');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'),
       tests.grant_role('sup2', 'supervisor', 'A2', 'boot'), tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'),
       tests.grant_role('ma', 'maintenance_admin', null, 'boot'), tests.grant_role('ma_a2', 'maintenance_admin', 'A2', 'boot'),
       tests.grant_role('sm', 'senior_management', null, 'boot'), tests.grant_role('sa', 'system_admin', null, 'boot'),
       tests.grant_role('drv', 'driver', 'A1', 'boot'), tests.grant_role('fab', 'fleet_admin', null, 'bootb');

-- ================================================================ 1. time calculation (SQL; the TypeScript mirror has identical cases)
select is((select scheduled_start_at || ' / ' || scheduled_end_at from public.shift_times('2026-12-01', '06:00', '18:00')),
          '2026-12-01 04:00:00+00 / 2026-12-01 16:00:00+00', 'day shift 06:00-18:00 on 2026-12-01 (SAST = UTC+2)');
select is((select scheduled_start_at || ' / ' || scheduled_end_at from public.shift_times('2026-12-01', '18:00', '06:00')),
          '2026-12-01 16:00:00+00 / 2026-12-02 04:00:00+00', 'night shift 18:00-06:00 ends the next day');
select is((select scheduled_end_at at time zone 'Africa/Johannesburg' from public.shift_times('2026-12-31', '18:00', '06:00')),
          '2027-01-01 06:00:00'::timestamp, 'night shift on 2026-12-31 ends 2027-01-01 06:00 local (across the year end)');
select is((select scheduled_start_at || ' / ' || scheduled_end_at from public.shift_times('2026-12-31', '22:00', '00:30')),
          '2026-12-31 20:00:00+00 / 2026-12-31 22:30:00+00', '22:00-00:30 ends 00:30 on the next day');
select is(tests.sqlstate_of($$select * from public.shift_times('2026-12-01', '06:00', '06:00')$$), '22023', 'equal start and end refused');
select is(tests.sqlstate_of($$select * from public.shift_times(null, '06:00', '18:00')$$), '22023', 'missing date refused');

-- ================================================================ 2. template CHECKs and constraints (inserted as the owner)
insert into public.shift_templates (id, company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
values (tests.id('t-ok'), tests.id('coA'), tests.id('A1'), 'Direct day', '06:00', '18:00', false, tests.id('boot'));
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
  values (tests.id('coA'), tests.id('A1'), 'Same', '06:00', '06:00', false, tests.id('boot'))$$), '23514', 'equal start and end time refused');
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
  values (tests.id('coA'), tests.id('A1'), 'Wrong flag 1', '06:00', '18:00', true, tests.id('boot'))$$), '23514', 'crosses_midnight = true with end after start refused');
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
  values (tests.id('coA'), tests.id('A1'), 'Wrong flag 2', '18:00', '06:00', false, tests.id('boot'))$$), '23514', 'crosses_midnight = false with end before start refused');
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
  values (tests.id('coA'), tests.id('A1'), ' padded ', '18:00', '06:00', true, tests.id('boot'))$$), '23514', 'untrimmed name refused');
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
  values (tests.id('coA'), tests.id('A1'), repeat('x', 101), '18:00', '06:00', true, tests.id('boot'))$$), '23514', 'name over 100 characters refused');
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by, status)
  values (tests.id('coA'), tests.id('A1'), 'Bad status', '18:00', '06:00', true, tests.id('boot'), 'deleted')$$), '23514', 'status is active | archived only');
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
  values (tests.id('coA'), tests.id('A1'), 'DIRECT DAY', '07:00', '19:00', false, tests.id('boot'))$$), '23505', 'active template name is unique per branch, case-insensitive');
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
  values (tests.id('coA'), tests.id('A2'), 'Direct day', '06:00', '18:00', false, tests.id('boot'))$$), null, 'the same name is fine at another branch');
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
  values (tests.id('coB'), tests.id('A1'), 'Cross company', '06:00', '18:00', false, tests.id('bootb'))$$), '23503', 'a template cannot point at another company''s branch (composite FK)');

-- ================================================================ 3. shift CHECKs and constraints (inserted as the owner)
insert into public.shifts (id, company_id, branch_id, shift_template_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
values (tests.id('s-ok'), tests.id('coA'), tests.id('A1'), tests.id('t-ok'), '2026-12-01', '2026-12-01 04:00+00', '2026-12-01 16:00+00', tests.id('cs-ok'), tests.id('boot'));
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), '2026-12-02', '2026-12-02 16:00+00', '2026-12-02 04:00+00', tests.id('cs-1'), tests.id('boot'))$$), '23514', 'end before start refused');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), '2026-12-02', '2026-12-02 04:00+00', '2026-12-02 04:00+00', tests.id('cs-2'), tests.id('boot'))$$), '23514', 'end equal to start refused');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), '2026-12-31', '2026-12-31 22:30+00', '2027-01-01 10:30+00', tests.id('cs-3'), tests.id('boot'))$$), '23514',
  'shift_date must be the local start date (22:30 UTC on 31 Dec is already 1 Jan in Johannesburg)');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), '2027-01-01', '2026-12-31 22:30+00', '2027-01-01 10:30+00', tests.id('cs-4'), tests.id('boot'))$$), null,
  'the local start date is accepted (across the year end)');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by, status)
  values (tests.id('coA'), tests.id('A1'), '2026-12-03', '2026-12-03 04:00+00', '2026-12-03 16:00+00', tests.id('cs-5'), tests.id('boot'), 'cancelled')$$), '23514', 'cancelled needs reason, by and at');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by, cancel_reason)
  values (tests.id('coA'), tests.id('A1'), '2026-12-03', '2026-12-03 04:00+00', '2026-12-03 16:00+00', tests.id('cs-6'), tests.id('boot'), 'stray reason')$$), '23514', 'a scheduled shift carries no cancel fields');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by, status)
  values (tests.id('coA'), tests.id('A1'), '2026-12-03', '2026-12-03 04:00+00', '2026-12-03 16:00+00', tests.id('cs-6b'), tests.id('boot'), 'deleted')$$), '23514', 'shift status is scheduled | cancelled only');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_template_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('t-ok'), '2026-12-01', '2026-12-01 04:00+00', '2026-12-01 16:00+00', tests.id('cs-7'), tests.id('boot'))$$), '23505',
  'a second scheduled shift for the same template and date is refused');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), '2026-12-05', '2026-12-05 04:00+00', '2026-12-05 16:00+00', tests.id('cs-ok'), tests.id('boot'))$$), '23505',
  'client_submission_id is unique per company and creator (idempotency)');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, shift_template_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A2'), tests.id('t-ok'), '2026-12-09', '2026-12-09 04:00+00', '2026-12-09 16:00+00', tests.id('cs-8'), tests.id('boot'))$$), '23503',
  'a shift''s template must be in the shift''s branch (composite FK)');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, department_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('dB'), '2026-12-10', '2026-12-10 04:00+00', '2026-12-10 16:00+00', tests.id('cs-9'), tests.id('boot'))$$), '23514',
  'a department of another company is refused (trigger)');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, department_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('dA2'), '2026-12-10', '2026-12-10 04:00+00', '2026-12-10 16:00+00', tests.id('cs-10'), tests.id('boot'))$$), '23514',
  'a department of another branch is refused (trigger)');
select is(tests.sqlstate_of($$insert into public.shifts (company_id, branch_id, department_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('dCo'), '2026-12-10', '2026-12-10 04:00+00', '2026-12-10 16:00+00', tests.id('cs-11'), tests.id('boot'))$$), null,
  'a company-wide department is accepted');
select is(tests.sqlstate_of($$update public.shifts set shift_date = '2026-12-02', scheduled_start_at = '2026-12-02 04:00+00', scheduled_end_at = '2026-12-02 16:00+00'
  where id = tests.id('s-ok')$$), '23514', 'a shift''s schedule is immutable (even for the owner); cancel and recreate instead');

-- ================================================================ 4. template functions and permissions
select tests.act_as('sup1');
insert into tests.kv select 'dayA1', public.create_shift_template(tests.id('A1'), '  Day  ', '06:00', '18:00');
insert into tests.kv select 'nightA1', public.create_shift_template(tests.id('A1'), 'Night', '18:00', '06:00');
select is((select name || '|' || crosses_midnight from public.shift_templates where id = tests.k('dayA1')), 'Day|false', 'supervisor creates a template in their branch (name trimmed)');
select is((select crosses_midnight from public.shift_templates where id = tests.k('nightA1')), true, 'crosses_midnight is derived from the times');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'dAY', '07:00', '19:00')$$), '23505', 'duplicate active name (case-insensitive) gives a clear error');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A2'), 'Day', '06:00', '18:00')$$), '42501', 'supervisor cannot create a template at another branch');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), '', '06:00', '18:00')$$), '22023', 'blank name refused');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Same', '06:00', '06:00')$$), '22023', 'equal times refused');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('B1'), 'Day', '06:00', '18:00')$$), 'P0002', 'another company''s branch is not found');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Early', '04:00', '12:00')$$), null, 'branch manager creates a template in their branch');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A2'), 'Early', '04:00', '12:00')$$), '42501', 'branch manager cannot create at another branch');
select tests.act_as('fa');
insert into tests.kv select 'dayA2', public.create_shift_template(tests.id('A2'), 'Day', '06:00', '18:00');
insert into tests.kv select 'nightA2', public.create_shift_template(tests.id('A2'), 'Night', '18:00', '06:00');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Fleet admin A1', '06:00', '14:00')$$), null, 'fleet admin creates in any branch of the company');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('B1'), 'Day', '06:00', '18:00')$$), 'P0002', 'fleet admin cannot reach another company''s branch');
select tests.act_as('fab');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Other company', '06:00', '18:00')$$), 'P0002', 'a fleet admin of company B cannot create in company A');
select is(tests.sqlstate_of($$select public.update_shift_template(tests.k('dayA1'), 'Hacked', '06:00', '18:00')$$), 'P0002', 'cross-company update: template not found');
select is(tests.sqlstate_of($$select public.archive_shift_template(tests.k('dayA1'), 'Hacked')$$), 'P0002', 'cross-company archive: template not found');
select is(tests.sqlstate_of($$select * from public.generate_shifts(tests.k('dayA1'), '2026-12-01', '2026-12-02', tests.id('x-fab'))$$), 'P0002', 'cross-company generate: template not found');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), null, '2026-12-01', '06:00', '18:00', tests.id('x-fab2'))$$), 'P0002', 'cross-company ad hoc shift: branch not found');
-- people who may not write
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Maint', '06:00', '18:00')$$), '42501', 'maintenance admin cannot create a template');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), null, '2026-12-01', '06:00', '18:00', tests.id('x-ma'))$$), '42501', 'maintenance admin cannot create a shift');
select tests.act_as('sm');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Senior', '06:00', '18:00')$$), '42501', 'senior management (view-only) cannot create a template');
select is(tests.sqlstate_of($$select public.archive_shift_template(tests.k('dayA1'), 'no')$$), '42501', 'senior management cannot archive');
select tests.act_as('drv');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Driver', '06:00', '18:00')$$), '42501', 'a driver cannot create a template');
select is(tests.sqlstate_of($$select * from public.generate_shifts(tests.k('dayA1'), '2026-12-01', '2026-12-02', tests.id('x-drv'))$$), '42501', 'a driver cannot generate shifts');
select tests.act_as('sa');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Sysadmin', '06:00', '18:00')$$), '42501', 'system admin cannot create a template');
select tests.act_as('nobody');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Nobody', '06:00', '18:00')$$), '42501', 'a user with no role cannot create a template');
select tests.act_anon();
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'Anon', '06:00', '18:00')$$), '42501', 'anon cannot execute the functions');
select is(tests.sqlstate_of($$select * from public.shift_times('2026-12-01', '06:00', '18:00')$$), '42501', 'anon cannot execute shift_times either');
select tests.reset();

-- ================================================================ 5. update (supervisor of A1)
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select public.update_shift_template(tests.k('dayA1'), 'Day shift', '05:30', '17:30')$$), null, 'supervisor edits a template in their branch');
select is((select name || '|' || start_time || '|' || end_time || '|' || crosses_midnight from public.shift_templates where id = tests.k('dayA1')),
          'Day shift|05:30:00|17:30:00|false', 'the edit is applied');
select is(tests.sqlstate_of($$select public.update_shift_template(tests.k('dayA1'), 'Day shift', '17:30', '05:30')$$), null, 'an edit that makes it cross midnight is accepted ...');
select is((select crosses_midnight from public.shift_templates where id = tests.k('dayA1')), true, '... and crosses_midnight follows');
select is(tests.sqlstate_of($$select public.update_shift_template(tests.k('dayA1'), 'Night', '17:30', '05:30')$$), '23505', 'renaming onto another active template''s name is refused');
select is(tests.sqlstate_of($$select public.update_shift_template(tests.k('dayA1'), 'Day shift', '05:30', '05:30')$$), '22023', 'edit with equal times refused');
select is(tests.sqlstate_of($$select public.update_shift_template(tests.k('dayA2'), 'Stolen', '06:00', '18:00')$$), '42501', 'supervisor cannot edit another branch''s template');
select is(tests.sqlstate_of($$select public.update_shift_template(gen_random_uuid(), 'Nope', '06:00', '18:00')$$), 'P0002', 'unknown template: not found');
select public.update_shift_template(tests.k('dayA1'), 'Day', '06:00', '18:00');
select tests.reset();
select is(tests.audit_n('shift_templates', 'insert'), 8, 'template creates are audited (2 direct inserts + 6 function creates)');
select ok(tests.audit_n('shift_templates', 'update', 'shift template edited%') >= 3, 'template edits are audited with a reason');

-- ================================================================ 6. generate_shifts
select tests.act_as('sup1');
select is((select created || '/' || skipped from public.generate_shifts(tests.k('dayA1'), '2026-12-01', '2026-12-07', tests.id('g-1'))), '7/0', 'generates one shift per day');
select is((select count(*)::int from public.shifts where shift_template_id = tests.k('dayA1')), 7, 'seven shifts exist');
select is((select count(*)::int from public.shifts where shift_template_id = tests.k('dayA1')
              and scheduled_start_at = (shift_date + time '06:00') at time zone 'Africa/Johannesburg'
              and scheduled_end_at = (shift_date + time '18:00') at time zone 'Africa/Johannesburg'), 7, 'times come from shift_times (06:00-18:00 local)');
select is((select created || '/' || skipped from public.generate_shifts(tests.k('dayA1'), '2026-12-01', '2026-12-07', tests.id('g-2'))), '0/7', 're-running with a new submission id creates none and skips all');
select is((select created || '/' || skipped from public.generate_shifts(tests.k('dayA1'), '2026-12-01', '2026-12-07', tests.id('g-1'))), '7/0', 'retrying the first submission id returns the first result (idempotent)');
select is((select count(*)::int from public.shifts where shift_template_id = tests.k('dayA1')), 7, 'the retry created nothing');
select is((select created || '/' || skipped from public.generate_shifts(tests.k('dayA1'), '2026-12-05', '2026-12-10', tests.id('g-3'))), '3/3', 'an overlapping range creates only the missing days (3 new, 3 skipped)');
select is(tests.sqlstate_of($$select * from public.generate_shifts(tests.k('dayA1'), '2026-12-01', '2027-01-01', tests.id('g-4'))$$), '22023', '32 days refused');
select is(tests.sqlstate_of($$select * from public.generate_shifts(tests.k('dayA1'), '2026-12-10', '2026-12-01', tests.id('g-5'))$$), '22023', 'end before start refused');
select is(tests.sqlstate_of($$select * from public.generate_shifts(tests.k('dayA1'), '2027-03-01', '2027-03-31', tests.id('g-6'))$$), null, 'exactly 31 days is accepted');
select is(tests.sqlstate_of($$select * from public.generate_shifts(tests.k('dayA1'), '2027-04-01', '2027-04-02', null)$$), '22023', 'a submission id is required');
select is(tests.sqlstate_of($$select * from public.generate_shifts(tests.k('dayA2'), '2026-12-01', '2026-12-02', tests.id('g-7'))$$), '42501', 'supervisor cannot generate for another branch''s template');
select is((select created || '/' || skipped from public.generate_shifts(tests.k('nightA1'), '2026-12-31', '2027-01-01', tests.id('g-8'))), '2/0', 'night template generated across the year end');
select is((select scheduled_start_at || ' / ' || scheduled_end_at || ' / ' || shift_date from public.shifts
            where shift_template_id = tests.k('nightA1') and shift_date = '2026-12-31'),
          '2026-12-31 16:00:00+00 / 2027-01-01 04:00:00+00 / 2026-12-31', 'night shift: dated by its local start, ends next morning');
select tests.reset();
-- shifts already created keep their own times when the template changes or is archived
select tests.act_as('sup1');
select public.update_shift_template(tests.k('dayA1'), 'Day', '07:00', '15:00');
select is((select count(*)::int from public.shifts where shift_template_id = tests.k('dayA1') and shift_date < '2027-01-01'
              and scheduled_start_at = (shift_date + time '06:00') at time zone 'Africa/Johannesburg'), 10, 'editing a template does not change shifts already created');
select tests.reset();
select ok(tests.audit_n('shifts', 'insert', 'generated from shift template%') >= 12, 'generated shifts are audited with the template as reason');
-- cancelled date can be generated again
select tests.act_as('sup1');
insert into tests.kv select 'cancelMe', id from public.shifts where shift_template_id = tests.k('dayA1') and shift_date = '2026-12-02';
select public.cancel_shift(tests.k('cancelMe'), 'Public holiday');
select is((select created || '/' || skipped from public.generate_shifts(tests.k('dayA1'), '2026-12-02', '2026-12-02', tests.id('g-9'))), '1/0', 'after the shift is cancelled the date can be generated again');
select is((select count(*)::int from public.shifts where shift_template_id = tests.k('dayA1') and shift_date = '2026-12-02'), 2, 'the cancelled shift is kept next to the new one');
select is(tests.sqlstate_of($$insert into public.shifts select * from public.shifts where false$$), '42501', 'no direct INSERT for authenticated');
select tests.reset();

-- ================================================================ 7. archive
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select public.archive_shift_template(tests.k('nightA1'), '   ')$$), '22023', 'archiving needs a reason');
select is(tests.sqlstate_of($$select public.archive_shift_template(tests.k('nightA2'), 'not mine')$$), '42501', 'supervisor cannot archive another branch''s template');
select is(tests.sqlstate_of($$select public.archive_shift_template(tests.k('nightA1'), 'Night shift discontinued')$$), null, 'supervisor archives a template with a reason');
select is((select status from public.shift_templates where id = tests.k('nightA1')), 'archived', 'status is archived (the row stays)');
select is(tests.sqlstate_of($$select public.archive_shift_template(tests.k('nightA1'), 'again')$$), '55000', 'an archived template cannot be archived again');
select is(tests.sqlstate_of($$select public.update_shift_template(tests.k('nightA1'), 'Night', '18:00', '06:00')$$), '55000', 'an archived template cannot be edited');
select is(tests.sqlstate_of($$select * from public.generate_shifts(tests.k('nightA1'), '2027-02-01', '2027-02-03', tests.id('g-10'))$$), '55000', 'an archived template cannot generate shifts');
select is((select count(*)::int from public.shifts where shift_template_id = tests.k('nightA1')), 2, 'archiving leaves existing shifts alone');
select is(tests.sqlstate_of($$select public.create_shift_template(tests.id('A1'), 'night', '19:00', '07:00')$$), null, 'the name of an archived template can be reused');
select tests.reset();
select is(tests.sqlstate_of($$update public.shift_templates set status = 'active' where id = '$$ || tests.k('nightA1') || $$'$$), '55000', 'an archived template cannot be re-activated, even by the owner');
select is(tests.audit_n('shift_templates', 'update', 'shift template archived: Night shift discontinued'), 1, 'the archive is audited with its reason');

-- ================================================================ 8. ad hoc shifts
select tests.act_as('sup1');
insert into tests.kv select 'adhoc', public.create_shift(tests.id('A1'), tests.id('dA1'), '2026-12-20', '22:00', '00:30', tests.id('a-1'));
select is((select scheduled_start_at || ' / ' || scheduled_end_at || ' / ' || shift_date || ' / ' || (shift_template_id is null) from public.shifts where id = tests.k('adhoc')),
          '2026-12-20 20:00:00+00 / 2026-12-20 22:30:00+00 / 2026-12-20 / true', 'ad hoc 22:00-00:30 uses the same time function');
select is(public.create_shift(tests.id('A1'), tests.id('dA1'), '2026-12-20', '22:00', '00:30', tests.id('a-1')), tests.k('adhoc'), 'retrying the same submission id returns the same shift');
select is((select count(*)::int from public.shifts where client_submission_id = tests.id('a-1')), 1, 'no duplicate from the retry');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), tests.id('dCo'), '2026-12-21', '06:00', '18:00', tests.id('a-2'))$$), null, 'a company-wide department is accepted');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), null, '2026-12-21', '06:00', '18:00', tests.id('a-3'))$$), null, 'no department is fine');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), tests.id('dA2'), '2026-12-21', '06:00', '18:00', tests.id('a-4'))$$), 'P0002', 'another branch''s department is refused');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), tests.id('dB'), '2026-12-21', '06:00', '18:00', tests.id('a-5'))$$), 'P0002', 'another company''s department is refused');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), tests.id('dOff'), '2026-12-21', '06:00', '18:00', tests.id('a-6'))$$), '22023', 'an inactive department is refused');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), null, '2026-12-21', '06:00', '06:00', tests.id('a-7'))$$), '22023', 'equal times refused');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), null, '2026-12-21', '06:00', '18:00', null)$$), '22023', 'a submission id is required');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A2'), null, '2026-12-21', '06:00', '18:00', tests.id('a-8'))$$), '42501', 'supervisor cannot create a shift at another branch');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A1'), null, '2026-12-22', '06:00', '18:00', tests.id('a-9'))$$), null, 'branch manager creates a shift in their branch');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A2'), null, '2026-12-22', '06:00', '18:00', tests.id('a-10'))$$), '42501', 'branch manager cannot at another branch');
select tests.act_as('fa');
select is(tests.sqlstate_of($$select public.create_shift(tests.id('A2'), tests.id('dCo'), '2026-12-22', '06:00', '18:00', tests.id('a-11'))$$), null, 'fleet admin creates a shift at any branch');
select tests.reset();

-- ================================================================ 9. cancel
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select public.cancel_shift(tests.k('adhoc'), '')$$), '22023', 'cancelling needs a reason');
select is(tests.sqlstate_of($$select public.cancel_shift(tests.k('adhoc'), repeat('x', 501))$$), '22023', 'a reason over 500 characters is refused');
select tests.act_as('sup2');
select is(tests.sqlstate_of($$select public.cancel_shift(tests.k('adhoc'), 'not my branch')$$), '42501', 'a supervisor of another branch cannot cancel');
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.cancel_shift(tests.k('adhoc'), 'maintenance')$$), '42501', 'maintenance admin cannot cancel');
select tests.act_as('fab');
select is(tests.sqlstate_of($$select public.cancel_shift(tests.k('adhoc'), 'other company')$$), 'P0002', 'another company cannot cancel (not found)');
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select public.cancel_shift(tests.k('adhoc'), '  Vehicle pool closed  ')$$), null, 'supervisor cancels a shift in their branch');
select is((select status || '|' || cancel_reason || '|' || (cancelled_by = tests.id('sup1')) || '|' || (cancelled_at is not null) from public.shifts where id = tests.k('adhoc')),
          'cancelled|Vehicle pool closed|true|true', 'cancel fields are set (reason trimmed)');
select is(tests.sqlstate_of($$select public.cancel_shift(tests.k('adhoc'), 'again')$$), '55000', 'a cancelled shift cannot be cancelled again');
select tests.reset();
select is(tests.sqlstate_of($$update public.shifts set cancel_reason = 'edited' where id = '$$ || tests.k('adhoc') || $$'$$), '55000', 'a cancelled shift cannot be edited, even by the owner');
select is(tests.audit_n('shifts', 'update', 'shift cancelled: Vehicle pool closed'), 1, 'the cancel is audited with its reason');
select is(tests.sqlstate_of($$select public.shift_has_active_allocations(gen_random_uuid())$$), null, 'the slice 3B hook exists (owner can call it)');
select is(public.shift_has_active_allocations(gen_random_uuid()), false, '... and is false until allocations exist');
select is(has_function_privilege('authenticated', 'public.shift_has_active_allocations(uuid)', 'execute'), false, 'the hook is internal: authenticated cannot call it');

-- ================================================================ 10. reads (RLS)
-- data: A1 has templates + shifts, A2 has templates; one company-B template
select tests.act_as('fab');
select public.create_shift_template(tests.id('B1'), 'Day', '06:00', '18:00');
select tests.reset();
select is((select count(*)::int from public.shift_templates where branch_id = tests.id('A1')) > 0, true, 'fixture: A1 has templates');
select is((select count(*)::int from public.shifts where branch_id = tests.id('A2')) > 0, true, 'fixture: A2 has shifts');
select tests.act_as('sup1');
select is((select count(*)::int from public.shift_templates where branch_id = tests.id('A2')), 0, 'supervisor does not read another branch''s templates');
select is((select count(*)::int from public.shifts where branch_id = tests.id('A2')), 0, 'supervisor does not read another branch''s shifts');
select is((select count(*)::int from public.shifts where branch_id = tests.id('A1')) > 0, true, 'supervisor reads their own branch''s shifts');
select is((select count(*)::int from public.shift_templates where company_id = tests.id('coB')), 0, 'supervisor does not read another company''s templates');
select tests.act_as('bm1');
select is((select count(*)::int from public.shifts where branch_id = tests.id('A2')), 0, 'branch manager does not read another branch''s shifts');
select is((select count(*)::int from public.shifts where branch_id = tests.id('A1')) > 0, true, 'branch manager reads their branch''s shifts');
select tests.act_as('fa');
select is((select count(distinct branch_id)::int from public.shifts), 2, 'fleet admin reads every branch of the company');
select is((select count(*)::int from public.shift_templates where company_id = tests.id('coB')), 0, 'fleet admin does not read another company''s templates');
select tests.act_as('fab');
select is((select count(*)::int from public.shifts where company_id = tests.id('coA')), 0, 'company B does not read company A shifts');
select is((select count(*)::int from public.shift_templates where company_id = tests.id('coA')), 0, 'company B does not read company A templates');
select is((select count(*)::int from public.shift_templates where company_id = tests.id('coB')), 1, 'company B reads its own template');
select tests.act_as('ma');
select is((select count(distinct branch_id)::int from public.shifts), 2, 'maintenance admin (reports.view) can read shifts company-wide');
select is((select count(*)::int from public.shift_templates) > 0, true, 'maintenance admin can read templates');
select tests.act_as('ma_a2');
select is((select count(*)::int from public.shifts where branch_id = tests.id('A1')), 0, 'a branch-scoped reports.view holder does not read other branches');
select is((select count(*)::int from public.shifts where branch_id = tests.id('A2')) > 0, true, 'a branch-scoped reports.view holder reads their branch');
select tests.act_as('sm');
select is((select count(distinct branch_id)::int from public.shifts), 2, 'senior management reads shifts');
select tests.act_as('drv');
select is((select count(*)::int from public.shifts), 0, 'a driver has no direct access to shifts');
select is((select count(*)::int from public.shift_templates), 0, 'a driver has no direct access to templates');
select tests.act_as('sa');
select is((select count(*)::int from public.shifts), 0, 'system admin has no access to shifts');
select tests.act_as('nobody');
select is((select count(*)::int from public.shifts), 0, 'a user with no role sees no shifts');
select tests.act_anon();
select is(tests.sqlstate_of($$select count(*) from public.shifts$$), '42501', 'anon has no table privilege on shifts');
select is(tests.sqlstate_of($$select count(*) from public.shift_templates$$), '42501', 'anon has no table privilege on shift_templates');

-- ================================================================ 10b. shift_access (drives the screens and the navigation)
select tests.act_as('sup1');
select is((select string_agg(branch_name || ':' || can_manage || ':' || can_view, ',' order by branch_name) from public.shift_access()),
          'A one:true:true,A two:false:false', 'supervisor: manage + view for their branch only');
select tests.act_as('fa');
select is((select string_agg(branch_name || ':' || can_manage || ':' || can_view, ',' order by branch_name) from public.shift_access()),
          'A one:true:true,A two:true:true', 'fleet admin: manage + view for every branch');
select tests.act_as('ma');
select is((select string_agg(branch_name || ':' || can_manage || ':' || can_view, ',' order by branch_name) from public.shift_access()),
          'A one:false:true,A two:false:true', 'maintenance admin: view only (reports.view)');
select tests.act_as('drv');
select is((select count(*)::int from public.shift_access() where can_view or can_manage), 0, 'driver: no access');
select tests.act_as('sa');
select is((select count(*)::int from public.shift_access() where can_view or can_manage), 0, 'system admin: no access');
select tests.act_as('fab');
select is((select string_agg(branch_name, ',') from public.shift_access()), 'B one', 'company B sees only its own branches');
select tests.act_anon();
select is(tests.sqlstate_of($$select * from public.shift_access()$$), '42501', 'anon cannot call shift_access');
select tests.reset();

-- ================================================================ 11. no direct writes, no deletes, privileges, audit
select tests.act_as('fa');
select is(tests.sqlstate_of($$insert into public.shift_templates (company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
  values (tests.id('coA'), tests.id('A1'), 'Direct', '06:00', '18:00', false, tests.id('fa'))$$), '42501', 'even a fleet admin has no direct INSERT on templates');
select is(tests.sqlstate_of($$update public.shift_templates set name = 'Direct' where company_id = tests.id('coA')$$), '42501', 'no direct UPDATE on templates');
select is(tests.sqlstate_of($$update public.shifts set status = 'cancelled' where company_id = tests.id('coA')$$), '42501', 'no direct UPDATE on shifts');
select is(tests.sqlstate_of($$update public.shifts set actual_start_at = now() where company_id = tests.id('coA')$$), '42501', 'actual_start_at / actual_end_at are not writable by clients');
select is(tests.sqlstate_of($$delete from public.shifts$$), '42501', 'no DELETE on shifts for authenticated');
select is(tests.sqlstate_of($$delete from public.shift_templates$$), '42501', 'no DELETE on templates for authenticated');
select tests.reset();
select is(tests.sqlstate_of($$delete from public.shifts$$), '42501', 'no DELETE on shifts, not even for the owner (trigger)');
select is(tests.sqlstate_of($$delete from public.shift_templates$$), '42501', 'no DELETE on templates, not even for the owner (trigger)');
select ok(tests.sqlstate_of($$truncate public.shifts$$) in ('42501', '0A000'), 'no TRUNCATE on shifts (the no_truncate trigger, or, since 3B, the FK from vehicle_allocations, stops it)');
select ok(tests.sqlstate_of($$truncate public.shift_templates$$) in ('42501', '0A000'), 'no TRUNCATE on templates (the no_truncate trigger, or the FK from shifts, stops it)');
select tests.act_service();
select is(tests.sqlstate_of($$delete from public.shifts$$), '42501', 'the service role cannot delete shifts either');
select tests.reset();
select ok((select relrowsecurity from pg_class where oid = 'public.shifts'::regclass) and (select relrowsecurity from pg_class where oid = 'public.shift_templates'::regclass), 'RLS is enabled on both tables');
select is((select count(*)::int from information_schema.table_privileges where table_schema = 'public' and table_name in ('shifts', 'shift_templates')
             and grantee in ('anon', 'authenticated', 'PUBLIC') and privilege_type <> 'SELECT'), 0, 'no table privilege beyond SELECT for anon / authenticated / public');
select is((select count(*)::int from information_schema.table_privileges where table_schema = 'public' and table_name in ('shifts', 'shift_templates')
             and grantee in ('anon', 'PUBLIC')), 0, 'anon and public have no table privileges at all');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname in ('shifts_guard', 'shift_templates_guard')
             and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))), 0, 'trigger functions are granted to nobody');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname in ('create_shift_template', 'update_shift_template', 'archive_shift_template', 'generate_shifts', 'create_shift', 'cancel_shift')
             and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')), 6, 'the six write functions: authenticated yes, anon no');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname in ('create_shift_template', 'update_shift_template', 'archive_shift_template', 'generate_shifts', 'create_shift', 'cancel_shift')
             and (not p.prosecdef or p.proconfig is null or not ('search_path=""' = any (p.proconfig)))), 0, 'the six write functions are SECURITY DEFINER with an empty search_path');
select is((select count(*)::int from pg_trigger where tgrelid in ('public.shifts'::regclass, 'public.shift_templates'::regclass) and tgname like '%audit'), 2, 'audit triggers on both tables');
select ok(tests.audit_n('shifts', 'insert') >= 20 and tests.audit_n('shifts', 'update') >= 2 and tests.audit_n('shift_templates', 'insert') >= 6
          and tests.audit_n('shift_templates', 'update') >= 4, 'audit rows exist for create, update, archive and cancel');
select is((select count(*)::int from public.audit_logs where entity_type = 'shifts' and branch_id is null and company_id = tests.id('coA')), 0, 'audit rows carry the branch');

select * from finish();
rollback;
