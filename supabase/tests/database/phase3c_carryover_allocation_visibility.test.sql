-- Slice 3C carry-over C1: a maintenance administrator holds reports.view, so they CAN read allocations in their scope and
-- CANNOT write (migration 031; DEC-23, PRD §4.2). Synthetic data only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

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

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('fa', 'coA'), tests.mk_user('maAll', 'coA'),
       tests.mk_user('maA1', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('maB', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('maAll', 'maintenance_admin', null, 'boot'),
       tests.grant_role('maA1', 'maintenance_admin', 'A1', 'boot'), tests.grant_role('sm', 'senior_management', null, 'boot'),
       tests.grant_role('sa', 'system_admin', null, 'boot'), tests.grant_role('maB', 'maintenance_admin', null, 'bootb');
select tests.mk_user('dA1', 'coA', 'driver'), tests.mk_user('dA2', 'coA', 'driver');
insert into public.drivers (id, company_id, profile_id, employee_number, branch_id) values
  (tests.id('d-dA1'), tests.id('coA'), tests.id('dA1'), 'C1E01', tests.id('A1')),
  (tests.id('d-dA2'), tests.id('coA'), tests.id('dA2'), 'C1E02', tests.id('A2'));
insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
values (tests.id('v-a1'), tests.id('coA'), tests.id('A1'), 'FL-C1A1', 'TC1A1', 'Make', 'Model', 'bakkie'),
       (tests.id('v-a2'), tests.id('coA'), tests.id('A2'), 'FL-C1A2', 'TC1A2', 'Make', 'Model', 'bakkie');
insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
select tests.id('sh-' || b.branch_code), b.company_id, b.id, (now() at time zone 'Africa/Johannesburg')::date + 20,
       ((now() at time zone 'Africa/Johannesburg')::date + 20 + time '06:00') at time zone 'Africa/Johannesburg',
       ((now() at time zone 'Africa/Johannesburg')::date + 20 + time '18:00') at time zone 'Africa/Johannesburg', gen_random_uuid(), tests.id('boot')
  from public.branches b where b.company_id = tests.id('coA');
insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
                                        licence_class_check, client_submission_id, created_by)
select tests.id('al-' || b.branch_code), s.company_id, s.branch_id, tests.id('v-' || lower(b.branch_code)), tests.id('d-d' || b.branch_code),
       s.id, s.scheduled_start_at, s.scheduled_end_at, 'matched', gen_random_uuid(), tests.id('fa')
  from public.shifts s join public.branches b on b.id = s.branch_id;
insert into public.allocation_events (company_id, allocation_id, event_type, new_value, actor_id)
select company_id, id, 'created', '{"status":"planned"}'::jsonb, tests.id('fa') from public.vehicle_allocations;

-- the permission matrix (DEC-23): maintenance administrator holds reports.view, not allocation.manage
select tests.act_as('maAll');
select is(public.has_permission('reports.view', tests.id('A1')), true, 'maintenance admin holds reports.view for a branch');
select is(public.has_permission('allocation.manage', tests.id('A1')), false, '... and not allocation.manage');

-- READ: company-wide maintenance admin sees every branch of the company
select is((select count(*)::int from public.vehicle_allocations), 2, 'company-wide maintenance admin reads allocations of every branch');
select is((select count(*)::int from public.allocation_events), 2, '... and their events');
-- WRITE: nothing
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, licence_class_check, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-a1'), tests.id('d-dA1'), tests.id('sh-A1'), now(), now() + interval '1 hour', 'matched', gen_random_uuid(), tests.id('maAll'))$$), '42501', 'maintenance admin cannot INSERT allocations');
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'cancelled'$$), '42501', '... cannot UPDATE them');
select is(tests.sqlstate_of($$delete from public.vehicle_allocations$$), '42501', '... cannot DELETE them');
select is(tests.sqlstate_of($$insert into public.allocation_events (company_id, allocation_id, event_type, actor_id) values (tests.id('coA'), tests.id('al-A1'), 'created', tests.id('maAll'))$$), '42501', '... cannot write events');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-A1'), tests.id('v-a1'), tests.id('d-dA1'), null, null, null, gen_random_uuid())$$), '42501', '... cannot create through request_allocation either');

-- READ in branch scope: a branch-scoped maintenance admin sees only their branch
select tests.act_as('maA1');
select is((select count(*)::int from public.vehicle_allocations), 1, 'branch-scoped maintenance admin (A1) reads allocations of A1');
select is((select count(*)::int from public.vehicle_allocations where branch_id = tests.id('A2')), 0, '... and none of A2');
select is((select count(*)::int from public.allocation_events), 1, '... and only the events of A1');
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'cancelled'$$), '42501', '... cannot UPDATE');

-- the contrasts that make the rule precise
select tests.act_as('sm');
select is((select count(*)::int from public.vehicle_allocations), 2, 'senior management reads through reports.view as well');
select tests.act_as('sa');
select is((select count(*)::int from public.vehicle_allocations), 0, 'system administrator reads no allocations');
select tests.act_as('maB');
select is((select count(*)::int from public.vehicle_allocations), 0, 'a maintenance admin of another company reads nothing');
select tests.act_as('dA2');
select is((select count(*)::int from public.vehicle_allocations), 1, 'a driver reads only their own allocation');

-- the real rule is recorded in the database
select tests.reset();
select is((select obj_description('public.vehicle_allocations'::regclass, 'pg_class') like '%maintenance administrator%reports.view%'), true, 'the table comment states the real rule');
select is((select count(*)::int from pg_policy p join pg_description d on d.objoid = p.oid
            where p.polname in ('va_select', 'allocation_events_select') and d.description like '%reports.view%'), 2, 'both read policies carry the corrected comment');
select * from finish();
rollback;
