-- Phase 1A pgTAP: org/access tables, has_permission, RLS, DEC-23 matrix, DEC-24, audit.
-- (1B: act_as() now carries aal2 so MFA-required users keep their permissions; end-dating uses now().)
-- Fixtures: 2 companies x 2 branches, one synthetic user per role (company A), plus company B
-- users. All data synthetic; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(87);

-- ------------------------------------------------------------------ helpers
create schema tests;
grant usage on schema tests to anon, authenticated, service_role;
create function tests.id(n text) returns uuid language sql immutable as
  $$ select md5('fleetiq-test-' || n)::uuid $$;
create function tests.act_as(n text) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(n), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
end $$;
create function tests.act_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
end $$;
create function tests.act_nobody() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role authenticated;
end $$;
create function tests.reset() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;
-- true when the statement raises any error
create function tests.fails(q text) returns boolean language plpgsql as $$
begin
  execute q;
  return false;
exception when others then
  return true;
end $$;
-- rows touched by a statement
create function tests.affected(q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute q;
  get diagnostics n = row_count;
  return n;
end $$;
create function tests.mk_user(n text, comp text, utype text default 'staff') returns void
language sql as $$
  insert into auth.users (id, email) values (tests.id(n), n || '@example.test');
  insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier)
  values (tests.id(n), tests.id(comp), 'Synthetic ' || n, n || '@example.test', utype, n);
$$;
create function tests.grant_role(n text, role_name text, branch text, by text,
  from_ts timestamptz default now() - interval '1 hour', to_ts timestamptz default null) returns void
language sql as $$
  insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, effective_to, granted_by)
  select tests.id(n), r.id, p.company_id, case when branch is null then null else tests.id(branch) end,
         from_ts, to_ts, tests.id(by)
  from public.roles r, public.profiles p
  where r.name = role_name and r.company_id is null and p.id = tests.id(n);
$$;
create function tests.keys(branch text) returns text[] language sql stable as $$
  select coalesce(array_agg(p.permission_key order by p.permission_key collate "C"), '{}')
  from public.permissions p where public.has_permission(p.permission_key, tests.id(branch));
$$;

-- ------------------------------------------------------------------ fixtures
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'),
  (tests.id('B1'), tests.id('coB'), 'B one', 'B1'), (tests.id('B2'), tests.id('coB'), 'B two', 'B2');
select tests.mk_user('boot_a', 'coA'), tests.mk_user('boot_b', 'coB');
select tests.mk_user('drv', 'coA', 'driver'), tests.mk_user('sup', 'coA'), tests.mk_user('fla', 'coA'),
       tests.mk_user('mnt', 'coA'), tests.mk_user('bm', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('sa', 'coA'),
       tests.mk_user('fla_b', 'coB'), tests.mk_user('sa_b', 'coB'), tests.mk_user('sup_b', 'coB'),
       tests.mk_user('dated', 'coA'), tests.mk_user('locked', 'coA'), tests.mk_user('victim', 'coA');
select tests.grant_role('drv', 'driver', 'A1', 'boot_a'),
       tests.grant_role('sup', 'supervisor', 'A1', 'boot_a'),
       tests.grant_role('fla', 'fleet_admin', null, 'boot_a'),
       tests.grant_role('mnt', 'maintenance_admin', null, 'boot_a'),
       tests.grant_role('bm', 'branch_manager', 'A1', 'boot_a'),
       tests.grant_role('sm', 'senior_management', null, 'boot_a'),
       tests.grant_role('sa', 'system_admin', null, 'boot_a'),
       tests.grant_role('fla_b', 'fleet_admin', null, 'boot_b'),
       tests.grant_role('sa_b', 'system_admin', null, 'boot_b'),
       tests.grant_role('sup_b', 'supervisor', 'B1', 'boot_b'),
       -- effective dating: current driver grant, future senior-mgmt grant, expired maintenance grant
       tests.grant_role('dated', 'driver', 'A1', 'boot_a'),
       tests.grant_role('dated', 'senior_management', null, 'boot_a', now() + interval '1 day'),
       tests.grant_role('dated', 'maintenance_admin', null, 'boot_a', now() - interval '2 days', now() - interval '1 day'),
       tests.grant_role('locked', 'fleet_admin', null, 'boot_a');
update public.profiles set status = 'locked' where id = tests.id('locked');
-- a company-B-only role, to prove roles cannot cross companies
insert into public.roles (id, company_id, name) values (tests.id('b_only'), tests.id('coB'), 'b_only');

-- ------------------------------------------------------------------ 1. structure
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
             and c.relname in ('companies','branches','departments','profiles','roles','permissions',
                               'role_permissions','user_roles','audit_logs')), 9::bigint,
         'RLS enabled on all 9 tables');
select ok((select prosecdef from pg_proc where proname = 'has_permission' and pronamespace = 'public'::regnamespace),
          'has_permission is SECURITY DEFINER');
select is((select provolatile::text from pg_proc where proname = 'has_permission' and pronamespace = 'public'::regnamespace),
          's', 'has_permission is STABLE');
select ok((select proconfig @> array['search_path=""'] from pg_proc where proname = 'has_permission' and pronamespace = 'public'::regnamespace),
          'has_permission pins search_path');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where proname = 'current_company_id' and pronamespace = 'public'::regnamespace),
          'current_company_id is SECURITY DEFINER with pinned search_path');
select is((select count(*) from public.roles where company_id is null), 7::bigint, '7 system roles seeded');
select is((select count(*) from public.permissions), 21::bigint, '21 permissions seeded');
select is((select count(*) from public.role_permissions), 54::bigint, 'DEC-23 matrix seeded (54 grants)');
select ok(tests.fails($$ insert into public.companies (name, status) values ('x', 'bogus') $$), 'status CHECK rejects unknown value');
select ok(tests.fails($$ insert into public.branches (company_id, name, branch_code) select id, 'dup', 'A1' from public.companies where name = 'Synthetic Co A' $$),
          'branch_code unique per company');
select lives_ok($$ insert into public.branches (company_id, name, branch_code) select id, 'ok', 'A1' from public.companies where name = 'Synthetic Co B' $$,
          'same branch_code allowed in another company');
select ok(tests.fails($$ insert into public.departments (company_id, branch_id, name) values (tests.id('coA'), tests.id('B1'), 'x') $$),
          'department branch must belong to same company (composite FK)');
select ok(tests.fails($$ insert into public.roles (name) values ('driver') $$), 'system role names unique');
select ok(tests.fails($$ select tests.mk_user('nomail', 'coA') ; update public.profiles set email = null where id = tests.id('nomail') $$),
          'staff profile requires email (DEC-34)');
select ok(tests.fails($$ insert into auth.users (id) values (tests.id('dup')); insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier)
          values (tests.id('dup'), tests.id('coA'), 'd', 'd@example.test', 'staff', 'sa') $$), 'login_identifier unique');
select ok(tests.fails($$ update public.user_roles set user_id = tests.id('victim') where user_id = tests.id('drv') $$),
          'user_roles identity columns immutable even for owner');
select ok(tests.fails($$ update public.profiles set company_id = tests.id('coB') where id = tests.id('drv') $$),
          'profile company_id immutable');

-- ------------------------------------------------------------------ 2. DEC-23 matrix per role (target branch A1)
select tests.act_as('drv');
select is(tests.keys('A1'), array['driver.licence.view_sensitive','evidence.view','incident.record','inspection.submit'], 'matrix: driver');
select tests.act_as('sup');
select is(tests.keys('A1'), array['allocation.manage','driver.licence.view_sensitive','evidence.view','incident.investigate_close','incident.record',
  'inspection.submit','odometer.exception.approve','odometer.exception.review','odometer.no_photo.approve','reports.view'], 'matrix: supervisor');
select tests.act_as('fla');
select is(tests.keys('A1'), array['allocation.manage','audit.view','driver.licence.view_sensitive','driver.manage','evidence.view','incident.investigate_close',
  'incident.record','odometer.adjustment.approve','odometer.correction.approve','odometer.exception.approve','odometer.exception.review',
  'odometer.no_photo.approve','reports.view','service.config.manage','service.record.create','service.record.verify','settings.validation.manage',
  'vehicle.manage','vehicle.transfer.approve'], 'matrix: fleet admin');
select tests.act_as('mnt');
select is(tests.keys('A1'), array['evidence.view','reports.view','service.record.create','service.record.verify'], 'matrix: maintenance admin');
select tests.act_as('bm');
select is(tests.keys('A1'), array['allocation.manage','driver.licence.view_sensitive','driver.manage','evidence.view','incident.investigate_close',
  'incident.record','odometer.correction.approve','odometer.exception.approve','odometer.exception.review','odometer.no_photo.approve','reports.view'], 'matrix: branch manager');
select tests.act_as('sm');
select is(tests.keys('A1'), array['audit.view','evidence.view','reports.view'], 'matrix: senior management (view-only)');
select tests.act_as('sa');
select is(tests.keys('A1'), array['audit.view','settings.validation.manage','users.roles.manage'], 'matrix: system admin');
select ok(not public.has_permission('evidence.view', tests.id('A1')), 'system admin: no evidence access');
select ok(not public.has_permission('reports.view', tests.id('A1')), 'system admin: no reports access');
select ok(not public.has_permission('driver.licence.view_sensitive', tests.id('A1')), 'system admin: no licence access');
select ok(public.has_permission('audit.view', null), 'system admin: can view audit log');

-- ------------------------------------------------------------------ 3. scope, company boundary, dates
select tests.act_as('bm');
select ok(public.has_permission('odometer.correction.approve', tests.id('A1')), 'branch manager approves in own branch');
select ok(not public.has_permission('odometer.correction.approve', tests.id('A2')), 'branch manager denied in other branch (same company)');
select ok(not public.has_permission('odometer.correction.approve', tests.id('B1')), 'branch manager denied in other company branch');
select ok(not public.has_permission('odometer.correction.approve', null), 'branch-scoped grant is not company-wide');
select tests.act_as('fla');
select ok(public.has_permission('odometer.correction.approve', tests.id('A2')), 'company-wide grant covers every branch');
select ok(public.has_permission('odometer.correction.approve', null), 'company-wide grant satisfies NULL target');
select ok(not public.has_permission('odometer.correction.approve', tests.id('B1')), 'company-wide grant stops at the company boundary');
select tests.act_as('fla_b');
select ok(not public.has_permission('odometer.correction.approve', tests.id('A1')), 'company B admin denied in company A branch');
select tests.act_as('dated');
select ok(public.has_permission('inspection.submit', tests.id('A1')), 'currently effective grant works');
select ok(not public.has_permission('reports.view', null), 'future-dated grant is not yet effective');
select ok(not public.has_permission('service.record.create', null), 'expired grant is no longer effective');
select tests.act_as('locked');
select ok(not public.has_permission('audit.view', null), 'locked profile has no permissions');
select tests.act_nobody();
select ok(not public.has_permission('audit.view', null), 'no authenticated user -> false');
select is(public.current_company_id(), null::uuid, 'no user -> no company');
select tests.act_anon();
select ok(tests.fails($$ select public.has_permission('audit.view', null) $$), 'anon cannot execute has_permission');
select tests.act_as('sa');
select is(public.current_company_id(), tests.id('coA'), 'current_company_id resolves company A');
select tests.act_as('sa_b');
select is(public.current_company_id(), tests.id('coB'), 'current_company_id resolves company B');

-- ------------------------------------------------------------------ 4. RLS visibility
select tests.act_anon();
select ok(tests.fails($$ select count(*) from public.companies $$), 'anon has no table access');
select tests.act_as('sa');
select is((select count(*) from public.companies), 1::bigint, 'only own company visible');
select is((select count(*) from public.branches where company_id <> tests.id('coA')), 0::bigint, 'no cross-company branches');
select is((select count(*) from public.profiles where company_id <> tests.id('coA')), 0::bigint, 'user manager sees no other-company profiles');
select cmp_ok((select count(*) from public.profiles), '>', 1::bigint, 'user manager sees company profiles');
select is((select count(*) from public.user_roles where company_id <> tests.id('coA')), 0::bigint, 'no cross-company user_roles');
select is((select count(*) from public.roles where name = 'b_only'), 0::bigint, 'other company roles hidden');
select tests.act_as('drv');
select is((select count(*) from public.profiles), 1::bigint, 'driver reads only own profile');
select is((select count(*) from public.user_roles), 1::bigint, 'driver reads only own grants');
select is((select count(*) from public.audit_logs), 0::bigint, 'driver cannot read audit log');
select tests.act_as('bm');
select is((select count(*) from public.audit_logs), 0::bigint, 'branch manager cannot read audit log');
select tests.act_as('fla');
select cmp_ok((select count(*) from public.audit_logs), '>', 0::bigint, 'fleet admin reads company audit log');
select is((select count(*) from public.audit_logs where company_id <> tests.id('coA')), 0::bigint, 'audit log stops at company boundary');
select is((select count(*) from public.profiles), 1::bigint, 'fleet admin has no user-management profile access');
select tests.act_as('sa_b');
select is((select count(*) from public.audit_logs where company_id = tests.id('coA')), 0::bigint, 'company B cannot read company A audit log');

-- ------------------------------------------------------------------ 5. user_roles: no self-granting (DEC-24)
select tests.act_as('sa');
select ok(tests.fails($$ insert into public.user_roles (user_id, role_id, company_id, granted_by)
  select tests.id('sa'), id, tests.id('coA'), tests.id('sa') from public.roles where name = 'fleet_admin' $$), 'cannot grant self a role (granted_by = self)');
select ok(tests.fails($$ insert into public.user_roles (user_id, role_id, company_id, granted_by)
  select tests.id('sa'), id, tests.id('coA'), tests.id('boot_a') from public.roles where name = 'fleet_admin' $$), 'cannot grant self a role via forged granted_by');
select ok(tests.fails($$ insert into public.user_roles (user_id, role_id, company_id, granted_by)
  select tests.id('victim'), id, tests.id('coA'), tests.id('boot_a') from public.roles where name = 'driver' $$), 'granted_by must be the caller');
select ok(tests.fails($$ insert into public.user_roles (user_id, role_id, company_id, granted_by)
  select tests.id('sup_b'), id, tests.id('coB'), tests.id('sa') from public.roles where name = 'driver' $$), 'cannot grant in another company');
select ok(tests.fails($$ insert into public.user_roles (user_id, role_id, company_id, granted_by)
  values (tests.id('victim'), tests.id('b_only'), tests.id('coA'), tests.id('sa')) $$), 'cannot assign another company''s role');
select is(tests.affected($$ update public.user_roles set effective_to = now() where user_id = tests.id('sa') $$), 0::bigint, 'cannot end-date own grants');
select ok(tests.fails($$ delete from public.user_roles where user_id = tests.id('drv') $$), 'user_roles has no client DELETE');
select ok(tests.fails($$ update public.user_roles set role_id = role_id where user_id = tests.id('drv') $$), 'only effective_to is client-updatable');
select lives_ok($$ insert into public.user_roles (user_id, role_id, company_id, branch_id, granted_by, effective_from)
  select tests.id('victim'), id, tests.id('coA'), tests.id('A1'), tests.id('sa'), now() - interval '1 hour' from public.roles where name = 'supervisor' $$, 'user manager can grant to another user');
select is(tests.affected($$ update public.user_roles set effective_to = now() where user_id = tests.id('victim') $$), 1::bigint, 'user manager can end-date another user''s grant');
select tests.act_as('fla');
select ok(tests.fails($$ insert into public.user_roles (user_id, role_id, company_id, granted_by)
  select tests.id('victim'), id, tests.id('coA'), tests.id('fla') from public.roles where name = 'driver' $$), 'fleet admin cannot manage roles');
select is(tests.affected($$ update public.user_roles set effective_to = now() where user_id = tests.id('victim') $$), 0::bigint, 'fleet admin cannot end-date grants');
select tests.act_as('sa');
select ok(tests.fails($$ update public.profiles set display_name = 'x' where id = tests.id('victim') $$), 'no client writes to profiles');
select ok(tests.fails($$ update public.companies set name = 'x' $$), 'no client writes to companies');
select ok(tests.fails($$ insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.name = 'driver' and p.permission_key = 'audit.view' $$),
          'no client writes to role_permissions');

-- ------------------------------------------------------------------ 6. audit
select tests.reset();
select is((select count(*) from public.audit_logs where entity_type = 'user_roles' and action = 'insert' and actor_id = tests.id('sa')), 1::bigint,
          'grant audited with actor = auth.uid()');
select is((select before_values ->> 'effective_to' from public.audit_logs
           where entity_type = 'user_roles' and action = 'update' and actor_id = tests.id('sa') and before_values ->> 'user_id' = tests.id('victim')::text), null::text,
          'update audit keeps before values (effective_to was null)');
select isnt((select after_values ->> 'effective_to' from public.audit_logs
           where entity_type = 'user_roles' and action = 'update' and actor_id = tests.id('sa') and before_values ->> 'user_id' = tests.id('victim')::text), null::text,
          'update audit keeps after values');
select is((select branch_id from public.audit_logs where entity_type = 'branches' and entity_id = tests.id('A1') and action = 'insert'), tests.id('A1'),
          'branch audit rows carry branch_id');
select ok((select count(*) > 0 from public.audit_logs where entity_type = 'role_permissions' and metadata ? 'permission_id'), 'role_permissions changes audited');
select tests.act_as('sa');
select ok(tests.fails($$ insert into public.audit_logs (action, entity_type) values ('insert', 'x') $$), 'client cannot insert audit rows');
select ok(tests.fails($$ update public.audit_logs set reason = 'x' $$), 'client cannot update audit rows');
select ok(tests.fails($$ delete from public.audit_logs $$), 'client cannot delete audit rows');
select tests.reset();
select ok(tests.fails($$ update public.audit_logs set reason = 'x' $$), 'owner cannot update audit rows (trigger)');
select ok(tests.fails($$ delete from public.audit_logs $$), 'owner cannot delete audit rows (trigger)');
select ok(tests.fails($$ truncate public.audit_logs $$), 'owner cannot truncate audit rows (trigger)');
set local role service_role;
select ok(tests.fails($$ delete from public.audit_logs $$), 'service role cannot delete audit rows');
select tests.reset();

select * from finish();
rollback;
