-- Phase 1C pgTAP: carry-over fix 5 (migration 000008) — a manager may cancel a not-yet-started grant.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

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
select tests.mk_user('boot_a', 'coA'), tests.mk_user('boot_b', 'coB'), tests.mk_user('sa', 'coA'), tests.mk_user('fla_b', 'coB'),
       tests.mk_user('f1', 'coA'), tests.mk_user('f2', 'coA'), tests.mk_user('f3', 'coA'), tests.mk_user('z1', 'coA');
select tests.grant_role('sa', 'system_admin', null, 'boot_a'), tests.grant_role('fla_b', 'fleet_admin', null, 'boot_b');
-- future-dated grants (start tomorrow) for f1, f2, f3
select tests.grant_role('f1', 'supervisor', 'A1', 'boot_a', now() + interval '1 day');
select tests.grant_role('f2', 'supervisor', 'A1', 'boot_a', now() + interval '1 day');
select tests.grant_role('f3', 'supervisor', 'A1', 'boot_a', now() + interval '1 day', now() + interval '3 days');
-- an already-started, zero-length (cancelled) grant: must never be effective
select tests.grant_role('z1', 'supervisor', 'A1', 'boot_a', now() - interval '1 hour', now() - interval '1 hour');
-- the manager's own future-dated grant (granted by the bootstrap user)
select tests.grant_role('sa', 'supervisor', 'A1', 'boot_a', now() + interval '1 day');

select tests.act_as('sa');
select is(tests.affected($$ update public.user_roles set effective_to = effective_from where user_id = tests.id('f1') $$), 1::bigint,
          'manager can cancel a future-dated grant (effective_to = effective_from)');
select ok(tests.fails($$ update public.user_roles set effective_to = now() + interval '2 days' where user_id = tests.id('f2') $$),
          'a future grant can only be cancelled, not given another end date');
select ok(tests.fails($$ update public.user_roles set effective_to = null where user_id = tests.id('f1') $$),
          'a cancelled grant cannot be re-activated');
select ok(tests.fails($$ update public.user_roles set effective_to = effective_from + interval '1 day' where user_id = tests.id('f1') $$),
          'a cancelled grant cannot be extended');
select is(tests.affected($$ update public.user_roles set effective_to = effective_from where user_id = tests.id('f3') $$), 1::bigint,
          'a future grant that already has an end date can also be cancelled');
select ok(tests.fails($$ update public.user_roles set effective_to = now() + interval '1 hour' where user_id = tests.id('z1') $$),
          'started grants keep the old rule: cannot be set into the future');
select is(tests.affected($$ update public.user_roles set effective_to = effective_from where user_id = tests.id('sa') and effective_from > now() $$), 0::bigint,
          'a manager cannot cancel their own grant (DEC-24)');
select tests.act_as('fla_b');
select is(tests.affected($$ update public.user_roles set effective_to = effective_from where user_id = tests.id('f2') $$), 0::bigint,
          'another company cannot cancel it');
select tests.reset();
select ok(tests.fails($$ update public.user_roles set effective_to = effective_from + interval '1 hour' where user_id = tests.id('f2') $$),
          'owner is held to the same rule (trigger): a future grant cannot get any other end date');
select is((select count(*) from public.audit_logs where entity_type = 'user_roles' and action = 'update'
           and entity_id = (select id from public.user_roles where user_id = tests.id('f1'))), 1::bigint,
          'the cancellation is audited');
-- a zero-length grant is never effective
select tests.act_as('z1');
select ok(not public.has_permission('evidence.view', tests.id('A1')), 'zero-length (cancelled) grant gives no permission');
select tests.reset();
select ok((select effective_to = effective_from from public.user_roles where user_id = tests.id('f1')),
          'cancelled grant row is kept as history (no delete)');

select * from finish();
rollback;
