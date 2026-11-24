-- Slice 4A carry-over C1 pgTAP (migration 036; DEC-40 amended 2026-11-18): an allocation cannot be started when its vehicle
-- is no longer available. Synthetic data only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

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
create function tests.err_of(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlstate || ':' || sqlerrm; end $$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A');
insert into public.branches (id, company_id, name, branch_code) values (tests.id('A1'), tests.id('coA'), 'A one', 'A1');
insert into auth.users (id, email) select tests.id(n), n || '@example.test' from unnest(array['boot','sup1','d1','d2','d3']) n;
insert into public.profiles (id, company_id, display_name, email, phone, user_type, login_identifier)
select tests.id(n), tests.id('coA'), 'Synthetic ' || n, n || '@example.test', '0000000', case when n like 'd%' then 'driver' else 'staff' end, n
  from unnest(array['boot','sup1','d1','d2','d3']) n;
insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, granted_by)
select tests.id(x.n), r.id, tests.id('coA'), tests.id('A1'), now() - interval '5 hours', tests.id('boot')
  from (values ('sup1', 'supervisor'), ('d1', 'driver'), ('d2', 'driver'), ('d3', 'driver')) x(n, rn)
  join public.roles r on r.name = x.rn and r.company_id is null;
insert into public.drivers (id, company_id, profile_id, employee_number, branch_id)
select tests.id('drv-' || n), tests.id('coA'), tests.id(n), 'E-' || upper(n), tests.id('A1') from unnest(array['d1','d2','d3']) n;
insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, prdp_required, verification_status,
                                    client_submission_id, created_by, verified_by, verified_at)
select tests.id('coA'), tests.id('drv-' || n), 'SYN-' || n, 'B', current_date - 3000, current_date + 400, false, 'verified', gen_random_uuid(), tests.id('boot'), tests.id('sup1'), now()
  from unnest(array['d1','d2','d3']) n;
insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category, required_licence_code)
select tests.id('v-' || n), tests.id('coA'), tests.id('A1'), 'FL-' || n, upper('T4A' || n), 'Make', 'Model', 'bakkie', 'B' from unnest(array['d1','d2','d3']) n;
insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
select tests.id('sh-' || n), tests.id('coA'), tests.id('A1'), (now() at time zone 'Africa/Johannesburg')::date,
       now() + interval '10 minutes', now() + interval '8 hours', gen_random_uuid(), tests.id('boot') from unnest(array['d1','d2','d3']) n;
insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
                                        licence_class_check, client_submission_id, created_by)
select tests.id('al-' || n), tests.id('coA'), tests.id('A1'), tests.id('v-' || n), tests.id('drv-' || n), tests.id('sh-' || n),
       now() + interval '10 minutes', now() + interval '8 hours', 'matched', gen_random_uuid(), tests.id('boot') from unnest(array['d1','d2','d3']) n;

-- the vehicle goes into maintenance AFTER the allocation was made
update public.vehicles set administrative_status = 'in_maintenance' where id = tests.id('v-d1');
update public.vehicles set administrative_status = 'in_maintenance' where id = tests.id('v-d2');

select is(public.allocation_start_blockers(tests.id('al-d1'), now()), array['vehicle_not_available'], 'blockers: vehicle_not_available');
select is(public.allocation_start_blockers(tests.id('al-d3'), now()), '{}'::text[], 'blockers: none while the vehicle is available');

select tests.act_as('d1');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, 'my_allocations.can_open is false when the vehicle is in maintenance');
select is(split_part(tests.err_of(format('select * from public.transition_allocation(%L, ''pre_inspection_pending'', null, %L)', tests.id('al-d1'), gen_random_uuid())), ':', 1),
          '55000', 'driver start refused (55000)');
select matches(tests.err_of(format('select * from public.transition_allocation(%L, ''pre_inspection_pending'', null, %L)', tests.id('al-d1'), gen_random_uuid())),
               'the vehicle is not available', 'driver start refused with the vehicle_not_available message');
select tests.reset();
select is((select status from public.vehicle_allocations where id = tests.id('al-d1')), 'planned', '... the allocation stays planned');

select tests.act_as('sup1');
select matches(tests.err_of(format('select * from public.transition_allocation(%L, ''pre_inspection_pending'', ''Driver at depot'', %L)', tests.id('al-d1'), gen_random_uuid())),
               '^55000:the vehicle is not available', 'on-behalf start (with a reason) refused with the same message');
select tests.reset();
select is((select status from public.vehicle_allocations where id = tests.id('al-d1')), 'planned', '... still planned');

-- the other maintenance states and archive are refused as well
update public.vehicles set administrative_status = 'out_of_service' where id = tests.id('v-d2');
select is(public.allocation_start_blockers(tests.id('al-d2'), now()), array['vehicle_not_available'], 'out_of_service: vehicle_not_available');
update public.vehicles set administrative_status = 'available', archived_at = now() where id = tests.id('v-d2');
select is(public.allocation_start_blockers(tests.id('al-d2'), now()), array['vehicle_not_available'], 'archived: vehicle_not_available');
update public.vehicles set archived_at = null where id = tests.id('v-d2');

-- back to available: the start succeeds, and can_open follows
update public.vehicles set administrative_status = 'available' where id = tests.id('v-d1');
select tests.act_as('d1');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), true, 'back to available: can_open is true');
select is(tests.err_of(format('select * from public.transition_allocation(%L, ''pre_inspection_pending'', null, %L)', tests.id('al-d1'), gen_random_uuid())), null, '... and the driver start succeeds');
select tests.reset();
select is((select status from public.vehicle_allocations where id = tests.id('al-d1')), 'pre_inspection_pending', '... status pre_inspection_pending');

select * from finish();
rollback;
