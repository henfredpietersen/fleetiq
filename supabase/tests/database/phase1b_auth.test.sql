-- Phase 1B pgTAP: sign-in data model and authorisation gates (migration 000007).
--   auth_login_attempts · lockout counting · service-role-only admin functions · forced PIN change
--   · MFA (AAL2) requirement for administrators and approvers (DEC-34) · DEC-24 on PIN reset.
-- All data synthetic; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(86);

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;
create function tests.id(n text) returns uuid language sql immutable as $$ select md5('fleetiq-test-' || n)::uuid $$;
create function tests.hash(n text) returns text language sql immutable as $$ select encode(extensions.digest('h-' || n, 'sha256'), 'hex') $$;
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
create function tests.fails(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;
create function tests.affected(q text) returns bigint language plpgsql as $$
declare n bigint; begin execute q; get diagnostics n = row_count; return n; end $$;
create function tests.mk_user(n text, comp text, utype text default 'staff') returns void language sql as $$
  insert into auth.users (id, email) values (tests.id(n), n || '@example.test');
  insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier)
  values (tests.id(n), tests.id(comp), 'Synthetic ' || n, case when utype = 'staff' then n || '@example.test' end, utype, n);
$$;
create function tests.grant_role(n text, role_name text, branch text, by text,
  from_ts timestamptz default now() - interval '5 hours', to_ts timestamptz default null) returns void language sql as $$
  insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, effective_to, granted_by)
  select tests.id(n), r.id, p.company_id, case when branch is null then null else tests.id(branch) end, from_ts, to_ts, tests.id(by)
  from public.roles r, public.profiles p where r.name = role_name and r.company_id is null and p.id = tests.id(n);
$$;
create function tests.role_id(n text) returns uuid language sql security definer as $$
  select id from public.roles where name = n and company_id is null $$;
create function tests.attempt(emp text, ip text, ok boolean, ago interval) returns void language sql as $$
  insert into public.auth_login_attempts (employee_number_attempted, ip_hash, succeeded, occurred_at)
  values (tests.hash(emp), tests.hash(ip), ok, now() - ago);
$$;

-- ------------------------------------------------------------------ fixtures
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot_a', 'coA'), tests.mk_user('boot_b', 'coB'),
       tests.mk_user('drv', 'coA', 'driver'), tests.mk_user('drv2', 'coA', 'driver'), tests.mk_user('drv_b', 'coB', 'driver'),
       tests.mk_user('sup', 'coA'), tests.mk_user('bm', 'coA'), tests.mk_user('fla', 'coA'), tests.mk_user('mnt', 'coA'),
       tests.mk_user('sa', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('future', 'coA'), tests.mk_user('expired', 'coA'),
       tests.mk_user('inactive_admin', 'coA');
select tests.grant_role('drv', 'driver', 'A1', 'boot_a'), tests.grant_role('drv2', 'driver', 'A1', 'boot_a'),
       tests.grant_role('sup', 'supervisor', 'A1', 'boot_a'), tests.grant_role('bm', 'branch_manager', 'A1', 'boot_a'),
       tests.grant_role('fla', 'fleet_admin', null, 'boot_a'), tests.grant_role('mnt', 'maintenance_admin', null, 'boot_a'),
       tests.grant_role('sa', 'system_admin', null, 'boot_a'), tests.grant_role('sm', 'senior_management', null, 'boot_a'),
       tests.grant_role('future', 'driver', 'A1', 'boot_a'),
       tests.grant_role('future', 'supervisor', 'A1', 'boot_a', now() + interval '1 day'),
       tests.grant_role('expired', 'driver', 'A1', 'boot_a'),
       tests.grant_role('expired', 'fleet_admin', null, 'boot_a', now() - interval '3 days', now() - interval '1 day'),
       tests.grant_role('inactive_admin', 'fleet_admin', null, 'boot_a');
update public.profiles set status = 'disabled' where id = tests.id('inactive_admin');

-- ------------------------------------------------------------------ 1. auth_login_attempts: append-only, deny by default
select ok((select relrowsecurity from pg_class where oid = 'public.auth_login_attempts'::regclass), 'RLS enabled on auth_login_attempts');
select is((select count(*) from pg_policy where polrelid = 'public.auth_login_attempts'::regclass), 0::bigint, 'no client policies on auth_login_attempts');
select tests.act_anon();
select ok(tests.fails($$ select count(*) from public.auth_login_attempts $$), 'anon cannot read attempts');
select ok(tests.fails($$ select public.auth_login_record(null, tests.hash('x'), null, tests.hash('ip'), false) $$), 'anon cannot record attempts');
select tests.act_as('fla');
select ok(tests.fails($$ select count(*) from public.auth_login_attempts $$), 'authenticated (even fleet admin) cannot read attempts');
select ok(tests.fails($$ insert into public.auth_login_attempts (employee_number_attempted, ip_hash, succeeded) values (tests.hash('x'), tests.hash('ip'), false) $$),
          'authenticated cannot insert attempts');
select tests.act_service();
select lives_ok($$ select public.auth_login_record(tests.id('coA'), tests.hash('E1001'), tests.id('drv'), tests.hash('ip1'), false) $$, 'service role records an attempt');
select is((select count(*) from public.auth_login_attempts), 1::bigint, 'service role can read attempts');
select ok(tests.fails($$ update public.auth_login_attempts set succeeded = true $$), 'service role cannot update attempts');
select ok(tests.fails($$ delete from public.auth_login_attempts $$), 'service role cannot delete attempts');
select tests.reset();
select ok(tests.fails($$ update public.auth_login_attempts set succeeded = true $$), 'owner cannot update attempts (trigger)');
select ok(tests.fails($$ delete from public.auth_login_attempts $$), 'owner cannot delete attempts (trigger)');
select ok(tests.fails($$ truncate public.auth_login_attempts $$), 'owner cannot truncate attempts (trigger)');
select ok(tests.fails($$ insert into public.auth_login_attempts (employee_number_attempted, ip_hash, succeeded) values ('E1001', tests.hash('ip'), false) $$),
          'raw employee number is rejected: only 64-hex hashes can be stored');
select ok(tests.fails($$ insert into public.auth_login_attempts (employee_number_attempted, ip_hash, succeeded) values (tests.hash('x'), '203.0.113.9', false) $$),
          'raw IP address is rejected: only 64-hex hashes can be stored');

-- ------------------------------------------------------------------ 2. lockout counting
select tests.attempt('E2000', 'ipA', false, interval '3 minutes');
select tests.attempt('E2000', 'ipA', false, interval '2 minutes');
select tests.attempt('E2000', 'ipB', false, interval '1 minute');
select tests.attempt('E2000', 'ipA', false, interval '40 minutes');      -- outside a 15-minute window
select tests.act_service();
select is((select account_failures from public.auth_login_counts(tests.hash('E2000'), tests.hash('ipZ'), interval '15 minutes')), 3,
          'account failures counted inside the window only');
select is((select ip_failures from public.auth_login_counts(tests.hash('E2000'), tests.hash('ipA'), interval '15 minutes')), 2, 'per-IP failures counted separately');
select is((select ip_failures from public.auth_login_counts(tests.hash('E2000'), tests.hash('ipB'), interval '15 minutes')), 1, 'a different IP has its own count');
select ok((select account_last_failure > now() - interval '90 seconds' from public.auth_login_counts(tests.hash('E2000'), tests.hash('ipZ'), interval '15 minutes')),
          'last failure timestamp is reported');
select is((select account_failures from public.auth_login_counts(tests.hash('NOBODY'), tests.hash('ipZ'), interval '15 minutes')), 0,
          'a number that never existed has a count too (same shape as a real one)');
select tests.reset();
select tests.attempt('E2000', 'ipC', true, interval '30 seconds');       -- a success resets the account count
select tests.act_service();
select is((select account_failures from public.auth_login_counts(tests.hash('E2000'), tests.hash('ipZ'), interval '15 minutes')), 0, 'success resets the account failure count');
select is((select ip_failures from public.auth_login_counts(tests.hash('E2000'), tests.hash('ipA'), interval '15 minutes')), 2, 'success does not reset the IP count');
select tests.reset();
select tests.attempt('E3000', 'ipD', false, interval '2 minutes');
select tests.attempt('E3000', 'ipD', false, interval '1 minute');
update public.profiles set pin_set_at = now() - interval '30 seconds' where id = tests.id('drv2');
select tests.act_service();
select is((select account_failures from public.auth_login_counts(tests.hash('E3000'), tests.hash('ipZ'), interval '15 minutes', tests.id('drv2'))), 0,
          'a PIN issue/reset after the failures restarts the account count');
select is((select account_failures from public.auth_login_counts(tests.hash('E3000'), tests.hash('ipZ'), interval '15 minutes')), 2,
          'without the profile floor the failures still count');

-- ------------------------------------------------------------------ 3. admin functions are service-role only
select tests.act_as('fla');
select ok(tests.fails($$ select * from public.auth_login_counts(tests.hash('a'), tests.hash('b'), interval '1 minute') $$), 'authenticated cannot call auth_login_counts');
select ok(tests.fails($$ select public.auth_lock_profile(tests.id('drv'), now() + interval '1 hour') $$), 'authenticated cannot call auth_lock_profile');
select ok(tests.fails($$ select public.auth_issue_pin_flags(tests.id('drv'), tests.id('fla'), 'reset') $$), 'authenticated cannot call auth_issue_pin_flags');
select ok(tests.fails($$ select public.auth_complete_pin_change(tests.id('drv')) $$), 'authenticated cannot call auth_complete_pin_change');
select tests.act_anon();
select ok(tests.fails($$ select public.auth_issue_pin_flags(tests.id('drv'), tests.id('fla'), 'reset') $$), 'anon cannot call auth_issue_pin_flags');
select ok(tests.fails($$ select public.user_requires_mfa(tests.id('sup')) $$), 'internal user_requires_mfa is not callable by clients');
select ok(tests.fails($$ select public.access_cleared(tests.id('sup')) $$), 'internal access_cleared is not callable by clients');

-- ------------------------------------------------------------------ 4. lockout is audited
select tests.act_service();
select lives_ok($$ select public.auth_lock_profile(tests.id('drv'), now() + interval '15 minutes') $$, 'service role can lock a driver profile');
select tests.reset();
select ok((select locked_until > now() from public.profiles where id = tests.id('drv')), 'locked_until set');
select is((select reason from public.audit_logs where entity_type = 'profiles' and entity_id = tests.id('drv') and action = 'update' and after_values ->> 'locked_until' is not null),
          'sign-in lockout: repeated failed PIN attempts', 'lockout audited with its reason');
select tests.act_service();
select lives_ok($$ select public.auth_lock_profile(tests.id('drv'), now() + interval '1 minute') $$, 'a shorter lock request is accepted but ignored');
select tests.reset();
select ok((select locked_until > now() + interval '10 minutes' from public.profiles where id = tests.id('drv')), 'an existing longer lock is never shortened');
select tests.act_service();
select lives_ok($$ select public.auth_lock_profile(tests.id('sup'), now() + interval '1 hour') $$, 'locking a staff id is a no-op, not an error');
select tests.reset();
select is((select locked_until from public.profiles where id = tests.id('sup')), null::timestamptz, 'staff profiles are never locked by the driver lockout');

-- ------------------------------------------------------------------ 5. PIN issue / reset (DEC-24) and forced change
select tests.act_service();
select ok(tests.fails($$ select public.auth_issue_pin_flags(tests.id('drv'), tests.id('drv'), 'reset') $$), 'cannot reset own PIN (self)');
select ok(tests.fails($$ select public.auth_issue_pin_flags(tests.id('fla'), tests.id('fla'), 'reset') $$), 'cannot reset own PIN (staff admin)');
select ok(tests.fails($$ select public.auth_issue_pin_flags(tests.id('sup'), tests.id('fla'), 'reset') $$), 'PINs belong to driver profiles only');
select ok(tests.fails($$ select public.auth_issue_pin_flags(tests.id('drv_b'), tests.id('fla'), 'reset') $$), 'cannot reset a driver in another company');
select ok(tests.fails($$ select public.auth_issue_pin_flags(tests.id('drv'), tests.id('inactive_admin'), 'reset') $$), 'inactive actor refused');
select ok(tests.fails($$ select public.auth_issue_pin_flags(tests.id('drv'), tests.id('fla'), 'whatever') $$), 'unknown mode refused');
select ok(tests.fails($$ select public.auth_issue_pin_flags(tests.id('drv'), gen_random_uuid(), 'reset') $$), 'unknown actor refused');
select lives_ok($$ select public.auth_issue_pin_flags(tests.id('drv'), tests.id('fla'), 'reset') $$, 'administrator can reset a driver PIN');
select tests.reset();
select ok((select must_change_pin from public.profiles where id = tests.id('drv')), 'must_change_pin set after reset');
select is((select locked_until from public.profiles where id = tests.id('drv')), null::timestamptz, 'reset clears the lockout');
select ok((select pin_set_at is not null from public.profiles where id = tests.id('drv')), 'pin_set_at recorded');
select is((select actor_id from public.audit_logs where entity_type = 'profiles' and entity_id = tests.id('drv') and reason = 'driver PIN reset by administrator'),
          tests.id('fla'), 'reset audited with the administrator as actor');
select is((select (after_values ->> 'must_change_pin') from public.audit_logs where entity_type = 'profiles' and entity_id = tests.id('drv') and reason = 'driver PIN reset by administrator'),
          'true', 'audit keeps the before/after flag change');
select ok((select not (after_values ? 'pin') and not (after_values ? 'password') from public.audit_logs where entity_type = 'profiles' and entity_id = tests.id('drv') and reason = 'driver PIN reset by administrator'),
          'audit row holds no PIN/password field');

-- forced change is enforced by RLS / has_permission, not only the UI
select tests.act_as('drv');
select ok(not public.has_permission('inspection.submit', tests.id('A1')), 'must_change_pin: no permissions until the PIN is changed');
select is(public.current_company_id(), null::uuid, 'must_change_pin: no company access until the PIN is changed');
select is((select count(*) from public.branches), 0::bigint, 'must_change_pin: reference data hidden');
select is((select count(*) from public.profiles), 1::bigint, 'the driver can still read their own profile (needed for the change-PIN screen)');
select tests.act_service();
select lives_ok($$ select public.auth_complete_pin_change(tests.id('drv')) $$, 'server completes the PIN change');
select tests.act_as('drv');
select ok(public.has_permission('inspection.submit', tests.id('A1')), 'after the change the driver has their permissions again');
select is(public.current_company_id(), tests.id('coA'), 'and company access');
select tests.reset();
select is((select actor_id from public.audit_logs where entity_type = 'profiles' and entity_id = tests.id('drv') and reason = 'driver changed own PIN'),
          tests.id('drv'), 'own PIN change audited with the driver as actor');
select ok(not (select must_change_pin from public.profiles where id = tests.id('drv')), 'flag cleared');

-- ------------------------------------------------------------------ 6. MFA requirement as data (DEC-34)
select is((select string_agg(name, ',' order by name) from public.roles where requires_mfa and company_id is null),
          'fleet_admin,maintenance_admin,system_admin', 'administrator roles require MFA');
select is((select string_agg(permission_key, ',' order by permission_key) from public.permissions where requires_mfa),
          'odometer.adjustment.approve,odometer.correction.approve,odometer.exception.approve,odometer.no_photo.approve,service.record.verify,vehicle.transfer.approve',
          'approval permissions require MFA');
select tests.act_as('sup');
select ok(public.current_user_requires_mfa(), 'supervisor (holds an approval permission) requires MFA');
select tests.act_as('bm');
select ok(public.current_user_requires_mfa(), 'branch manager requires MFA');
select tests.act_as('fla');
select ok(public.current_user_requires_mfa(), 'fleet admin requires MFA');
select tests.act_as('mnt');
select ok(public.current_user_requires_mfa(), 'maintenance admin requires MFA');
select tests.act_as('sa');
select ok(public.current_user_requires_mfa(), 'system admin requires MFA');
select tests.act_as('sm');
select ok(not public.current_user_requires_mfa(), 'senior management (view-only) does not');
select tests.act_as('drv2');
select ok(not public.current_user_requires_mfa(), 'driver does not');
select tests.act_as('future');
select ok(not public.current_user_requires_mfa(), 'a future-dated approver grant does not require MFA yet');
select tests.act_as('expired');
select ok(not public.current_user_requires_mfa(), 'an expired admin grant no longer requires MFA');
select tests.act_anon();
select ok(tests.fails($$ select public.current_user_requires_mfa() $$), 'anon cannot call current_user_requires_mfa');

-- AAL1 sessions of MFA-required users get nothing; AAL2 restores it
select tests.act_as('sup', 'aal1');
select ok(not public.has_permission('inspection.submit', tests.id('A1')), 'approver at AAL1: has_permission false');
select ok(not public.has_permission('odometer.exception.approve', tests.id('A1')), 'approver at AAL1: approval permission false');
select is(public.current_company_id(), null::uuid, 'approver at AAL1: no company boundary access');
select is((select count(*) from public.user_roles), 1::bigint, 'approver at AAL1 can still read their own grants (needed to explain what is required)');
select tests.act_as('sup', 'aal2');
select ok(public.has_permission('odometer.exception.approve', tests.id('A1')), 'approver at AAL2: has_permission true');
select tests.act_as('bm', 'aal1');
select ok(not public.has_permission('driver.manage', tests.id('A1')), 'branch manager at AAL1: driver.manage false (server-side PIN admin is gated)');
select tests.act_as('bm', 'aal2');
select ok(public.has_permission('driver.manage', tests.id('A1')), 'branch manager at AAL2: driver.manage true');
select tests.act_as('sa', 'aal1');
select ok(not public.has_permission('users.roles.manage', null), 'system admin at AAL1: users.roles.manage false');
select ok(tests.fails($$ insert into public.user_roles (user_id, role_id, company_id, branch_id, granted_by)
  select tests.id('drv2'), tests.role_id('supervisor'), tests.id('coA'), tests.id('A1'), tests.id('sa') $$), 'system admin at AAL1 cannot grant roles (RLS)');
select tests.act_as('sa', 'aal2');
select lives_ok($$ insert into public.user_roles (user_id, role_id, company_id, branch_id, granted_by)
  select tests.id('drv2'), tests.role_id('supervisor'), tests.id('coA'), tests.id('A1'), tests.id('sa') $$, 'system admin at AAL2 can grant roles');
select tests.act_as('sm', 'aal1');
select ok(public.has_permission('reports.view', tests.id('A1')), 'view-only senior management works at AAL1');
select tests.act_as('drv', 'aal1');
select ok(public.has_permission('inspection.submit', tests.id('A1')), 'driver (no MFA requirement) keeps permissions at AAL1');
select tests.reset();
select set_config('request.jwt.claims', json_build_object('sub', tests.id('fla'), 'role', 'authenticated')::text, true);
set local role authenticated;
select ok(not public.has_permission('audit.view', null), 'a token without an aal claim is treated as AAL1');
select tests.reset();

select * from finish();
rollback;
