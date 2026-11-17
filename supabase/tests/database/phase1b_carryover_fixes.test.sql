-- Phase 1B pgTAP: carry-over fixes from the PR #2 review (migration 000006).
--   user_roles end-only grants · audit session_user · role_permissions company_id · audit actor fallback
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;
create function tests.id(n text) returns uuid language sql immutable as $$ select md5('fleetiq-test-' || n)::uuid $$;
create function tests.act_as(n text, aal text default 'aal2') returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', tests.id(n), 'role', 'authenticated', 'aal', aal)::text, true);
  set local role authenticated;
end $$;
create function tests.reset() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims', '', true); end $$;
create function tests.fails(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;
create function tests.affected(q text) returns bigint language plpgsql as $$
declare n bigint; begin execute q; get diagnostics n = row_count; return n; end $$;
create function tests.mk_user(n text, comp text, utype text default 'staff') returns void language sql as $$
  insert into auth.users (id, email) values (tests.id(n), n || '@example.test');
  insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier)
  values (tests.id(n), tests.id(comp), 'Synthetic ' || n, n || '@example.test', utype, n);
$$;
create function tests.grant_role(n text, role_name text, branch text, by text,
  from_ts timestamptz default now() - interval '5 hours', to_ts timestamptz default null) returns void language sql as $$
  insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, effective_to, granted_by)
  select tests.id(n), r.id, p.company_id, case when branch is null then null else tests.id(branch) end, from_ts, to_ts, tests.id(by)
  from public.roles r, public.profiles p where r.name = role_name and r.company_id is null and p.id = tests.id(n);
$$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot_a', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('fla', 'coA'), tests.mk_user('fla_b', 'coB'),
       tests.mk_user('boot_b', 'coB'), tests.mk_user('t1', 'coA'), tests.mk_user('t2', 'coA'), tests.mk_user('t4', 'coA');
select tests.grant_role('sa', 'system_admin', null, 'boot_a'), tests.grant_role('fla', 'fleet_admin', null, 'boot_a'),
       tests.grant_role('fla_b', 'fleet_admin', null, 'boot_b');
-- t1: open grant · t2: already ended 2 hours ago · t4: open grant used by the impersonation check
select tests.grant_role('t1', 'supervisor', 'A1', 'boot_a'), tests.grant_role('t4', 'supervisor', 'A1', 'boot_a');
select tests.grant_role('t2', 'supervisor', 'A1', 'boot_a', now() - interval '5 hours', now() - interval '2 hours');

-- ---------------------------------------------------------------- 1. end-only grants
select tests.act_as('sa');
select ok(tests.fails($$ update public.user_roles set effective_to = now() + interval '1 day' where user_id = tests.id('t1') $$),
          'manager cannot set effective_to in the future');
select ok(tests.fails($$ update public.user_roles set effective_to = null where user_id = tests.id('t2') $$),
          'manager cannot re-activate an ended grant');
select ok(tests.fails($$ update public.user_roles set effective_to = now() - interval '1 hour' where user_id = tests.id('t2') $$),
          'manager cannot extend an ended grant (later than existing effective_to)');
select is(tests.affected($$ update public.user_roles set effective_to = now() - interval '3 hours' where user_id = tests.id('t2') $$), 1::bigint,
          'manager may shorten an ended grant (earlier than existing effective_to)');
select is(tests.affected($$ update public.user_roles set effective_to = now() where user_id = tests.id('t1') $$), 1::bigint,
          'manager can end an open grant at now()');
select tests.reset();
select ok(tests.fails($$ update public.user_roles set effective_to = null where user_id = tests.id('t1') $$),
          'owner cannot re-activate an ended grant (trigger)');
select ok(tests.fails($$ update public.user_roles set effective_to = now() + interval '1 day' where user_id = tests.id('t1') $$),
          'owner cannot extend an ended grant into the future (trigger)');
select lives_ok($$ update public.user_roles set created_at = created_at where user_id = tests.id('t1') $$,
          'unrelated no-op updates are not blocked by the end-only trigger');

-- ---------------------------------------------------------------- 2. audit session_user
select tests.reset();
insert into public.branches (company_id, name, branch_code) values (tests.id('coA'), 'Audit probe', 'AP');
select is((select metadata ->> 'session_user' from public.audit_logs where entity_type = 'branches' and after_values ->> 'branch_code' = 'AP'),
          session_user::text, 'audit metadata records session_user');
select ok((select not (metadata ? 'db_role') from public.audit_logs where entity_type = 'branches' and after_values ->> 'branch_code' = 'AP'),
          'audit metadata no longer carries the meaningless db_role');

-- ---------------------------------------------------------------- 3. role_permissions company_id
insert into public.roles (id, company_id, name) values (tests.id('custom_a'), tests.id('coA'), 'custom_a');
insert into public.role_permissions (role_id, permission_id) select tests.id('custom_a'), id from public.permissions where permission_key = 'reports.view';
select is((select company_id from public.audit_logs where entity_type = 'role_permissions' and entity_id = tests.id('custom_a')),
          tests.id('coA'), 'custom-role permission change carries the role''s company_id');
select is((select count(*) from public.audit_logs where entity_type = 'role_permissions' and company_id is null and metadata ? 'permission_id'),
          (select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.company_id is null),
          'system-role permission rows keep NULL company_id');
select tests.act_as('fla');
select is((select count(*) from public.audit_logs where entity_type = 'role_permissions' and entity_id = tests.id('custom_a')), 1::bigint,
          'company audit.view user sees changes to own custom roles');
select is((select count(*) from public.audit_logs where entity_type = 'role_permissions' and company_id is null), 0::bigint,
          'system-role permission changes stay invisible to clients');
select tests.act_as('fla_b');
select is((select count(*) from public.audit_logs where entity_type = 'role_permissions' and entity_id = tests.id('custom_a')), 0::bigint,
          'other company cannot see them');

-- ---------------------------------------------------------------- 4. audit actor fallback
select tests.reset();
select set_config('app.actor_id', tests.id('boot_a')::text, true);
update public.branches set name = 'Audit probe 2' where branch_code = 'AP' and company_id = tests.id('coA');
select is((select actor_id from public.audit_logs where entity_type = 'branches' and after_values ->> 'name' = 'Audit probe 2'),
          tests.id('boot_a'), 'no auth.uid(): audit actor falls back to app.actor_id');
-- an authenticated caller cannot impersonate someone else through app.actor_id
select tests.act_as('sa');
select set_config('app.actor_id', tests.id('boot_a')::text, true);
select is(tests.affected($$ update public.user_roles set effective_to = now() where user_id = tests.id('t4') $$), 1::bigint, 'forged-actor scenario: update itself succeeds');
select tests.reset();
select is((select actor_id from public.audit_logs where entity_type = 'user_roles' and action = 'update' and before_values ->> 'user_id' = tests.id('t4')::text),
          tests.id('sa'), 'authenticated caller: actor stays auth.uid(), app.actor_id is ignored');

select * from finish();
rollback;
