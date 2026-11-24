-- Slice 4B pgTAP: the company device register (migration 041; DEC-35, DEC-24). Synthetic data only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(50);

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
create function tests.fails(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;
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
  select tests.grant_role(n, 'driver', branch, 'boot');
$$;
create function tests.key(n text) returns uuid language sql immutable as $$ select md5('device-key-' || n)::uuid $$;
create function tests.dev(n text) returns uuid language sql stable as $$ select id from public.company_devices where device_key = tests.key(n) $$;
create function tests.reg(who text, branch text, k text, tag text default null, lbl text default null) returns text language sql as $$
  select tests.sqlstate_of(format('select public.register_company_device(%L, %L, %L, %L)', tests.id(branch), tests.key(k), tag, lbl)) $$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('fa', 'coA'), tests.mk_user('bm1', 'coA'), tests.mk_user('bm2', 'coA'),
       tests.mk_user('sup1', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('fab', 'coB'), tests.mk_user('sa', 'coA'), tests.mk_user('ma', 'coA');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'),
       tests.grant_role('bm2', 'branch_manager', 'A2', 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'),
       tests.grant_role('fab', 'fleet_admin', null, 'bootb'), tests.grant_role('sa', 'system_admin', null, 'boot'),
       tests.grant_role('ma', 'maintenance_admin', null, 'boot');
select tests.mk_driver('d1', 'coA', 'E-D1', 'A1'), tests.mk_driver('d2', 'coA', 'E-D2', 'A1'), tests.mk_driver('d3', 'coA', 'E-D3', 'A2');
-- a branch manager who is also a driver (DEC-24: not their own device)
select tests.mk_driver('bmd', 'coA', 'E-BMD', 'A1');
select tests.grant_role('bmd', 'branch_manager', 'A1', 'boot');

-- ================================================================ register
select tests.act_as('fa');
select is(tests.reg('fa', 'A1', 'k1', 'TAG-1', 'Phone 1'), null, 'register: a fleet administrator registers a phone for a branch');
select is(tests.reg('fa', 'A1', 'k1', 'TAG-1', 'Phone 1'), null, 'register: an identical retry is a no-op');
select is(tests.reg('fa', 'A1', 'k1', 'TAG-1', 'Another label'), '23505', 'register: the same key with different details is refused (already registered)');
select is((select count(*)::int from public.company_devices where device_key = tests.key('k1')), 1, '... and there is exactly one row');
select is(tests.reg('fa', 'A2', 'k3', 'TAG-3', 'Phone 3'), null, 'register: and for another branch');
select tests.reg('fa', 'A1', 'k2', 'TAG-2', 'Phone 2');
select tests.reg('fa', 'A1', 'k4', 'TAG-4', 'Phone 4');
select tests.reg('fa', 'A1', 'k5', 'TAG-5', 'Phone 5');
select is(tests.sqlstate_of(format('select public.register_company_device(%L, null, null, null)', tests.id('A1'))), '22023', 'register: a device key is required');
select tests.act_as('bm1');
select is(tests.reg('bm1', 'A1', 'k6', 'TAG-6', 'Phone 6'), null, 'register: a branch manager registers for their own branch');
select is(tests.reg('bm1', 'A2', 'k7'), '42501', 'register: ... not for another branch');
select tests.act_as('sup1');
select is(tests.reg('sup1', 'A1', 'k8'), '42501', 'register: a supervisor (no driver.manage) is refused');
select tests.act_as('d1');
select is(tests.reg('d1', 'A1', 'k9'), '42501', 'register: a driver is refused');
select tests.act_as('sa');
select is(tests.reg('sa', 'A1', 'k10'), '42501', 'register: a system administrator is refused');
select tests.act_as('ma');
select is(tests.reg('ma', 'A1', 'k10'), '42501', 'register: a maintenance administrator is refused');
select tests.act_as('fab');
select is(tests.reg('fab', 'A1', 'k11'), 'P0002', 'register: another company''s branch is not found');
select tests.reset();

-- ================================================================ assign / unassign
select tests.act_as('fa');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k1'), tests.id('d-d1'), 'Issued to the driver')), null, 'assign: a fleet administrator issues a device to a driver');
select tests.reset();
select is((select assigned_driver_id from public.company_devices where device_key = tests.key('k1')), tests.id('d-d1'), '... the assignment is recorded');
select is((select assigned_to from public.company_devices where device_key = tests.key('k1')), null, '... and is open');
select tests.act_as('fa');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k2'), tests.id('d-d1'), 'Second phone')), '23505', 'assign: one issued device per driver');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k1'), tests.id('d-d2'), 'Taken')), '55000', 'assign: an already assigned device must be unassigned first');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k2'), tests.id('d-d3'), 'Wrong branch')), '22023', 'assign: the driver must be in the device''s branch');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, null)', tests.dev('k2'), tests.id('d-d2'))), '22023', 'assign: a reason is required');
select tests.act_as('bm2');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k2'), tests.id('d-d2'), 'Not my branch')), '42501', 'assign: a branch manager of another branch is refused');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k2'), tests.id('d-d2'), 'No permission')), '42501', 'assign: a supervisor is refused');
select tests.act_as('d2');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k2'), tests.id('d-d2'), 'Self')), '42501', 'assign: a driver cannot assign themselves a device');
select tests.act_as('bmd');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k2'), tests.id('d-bmd'), 'To myself')), '42501', 'DEC-24: a manager cannot assign a device to themselves');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k2'), tests.id('d-d2'), 'To a colleague')), null, '... but can to someone else');
select tests.act_as('fa');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k4'), tests.id('d-bmd'), 'Issued to the manager')), null, 'a fleet administrator issues the manager-driver a phone');
select tests.act_as('bmd');
select is(tests.sqlstate_of(format('select public.unassign_company_device(%L, %L)', tests.dev('k4'), 'Self')), '42501', 'DEC-24: nobody unassigns their own device');
select is(tests.sqlstate_of(format('select public.set_company_device_status(%L, %L, %L)', tests.dev('k4'), 'lost', 'Self')), '42501', 'DEC-24: nobody marks their own device lost');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select public.unassign_company_device(%L, %L)', tests.dev('k1'), 'Nope')), '42501', 'unassign: a supervisor is refused');
select tests.act_as('fa');
select is(tests.sqlstate_of(format('select public.unassign_company_device(%L, %L)', tests.dev('k1'), '')), '22023', 'unassign: a reason is required');
select is(tests.sqlstate_of(format('select public.unassign_company_device(%L, %L)', tests.dev('k1'), 'Returned')), null, 'unassign: a fleet administrator unassigns');
select is(tests.sqlstate_of(format('select public.unassign_company_device(%L, %L)', tests.dev('k1'), 'Again')), '55000', 'unassign: a device that is not assigned is refused');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k5'), tests.id('d-d1'), 'New phone')), null, '... and the driver can now be issued another device');

-- ================================================================ status
select is(tests.sqlstate_of(format('select public.set_company_device_status(%L, %L, %L)', tests.dev('k5'), 'lost', 'Reported lost')), null, 'status: mark lost');
select tests.reset();
select is((select assigned_to is not null from public.company_devices where device_key = tests.key('k5')), true, '... a lost phone''s assignment is closed');
select tests.act_as('fa');
select is(tests.sqlstate_of(format('select public.assign_company_device(%L, %L, %L)', tests.dev('k5'), tests.id('d-d2'), 'Lost')), '55000', 'a lost device cannot be assigned');
select is(tests.sqlstate_of(format('select public.set_company_device_status(%L, %L, %L)', tests.dev('k5'), 'retired', 'Written off')), null, 'status: retire');
select is(tests.sqlstate_of(format('select public.set_company_device_status(%L, %L, %L)', tests.dev('k5'), 'active', 'Oops')), '55000', 'status: a retired device is final');
select tests.act_as('d1');
select is(tests.sqlstate_of(format('select public.set_company_device_status(%L, %L, %L)', tests.dev('k2'), 'lost', 'Driver')), '42501', 'status: a driver is refused');

-- ================================================================ visibility, no direct writes, no delete, audit
select tests.act_as('bm1');
select is((select count(*)::int from public.list_company_devices()), 5, 'list: a branch manager sees their own branch''s five devices and not branch A2''s');
select is((select count(*)::int from public.company_devices where branch_id = tests.id('A2')), 0, 'RLS: ... and none of branch A2');
select tests.act_as('fa');
select is((select count(*)::int from public.list_company_devices()), 6, 'list: a fleet administrator sees every branch');
select tests.act_as('sup1');
select is((select count(*)::int from public.list_company_devices()) + (select count(*)::int from public.company_devices), 0, 'a supervisor sees no devices');
select tests.act_as('fab');
select is((select count(*)::int from public.list_company_devices()) + (select count(*)::int from public.company_devices), 0, 'another company sees no devices');
select tests.act_as('fa');
select ok(tests.fails($$ insert into public.company_devices (company_id, branch_id, device_key, created_by) select company_id, id, gen_random_uuid(), auth.uid() from public.branches limit 1 $$), 'no direct INSERT for clients');
select ok(tests.fails($$ update public.company_devices set label = 'x' $$), 'no direct UPDATE for clients');
select ok(tests.fails($$ delete from public.company_devices $$), 'no DELETE for clients');
select tests.reset();
select ok(tests.fails($$ delete from public.company_devices $$), 'no DELETE even for the table owner (trigger)');
select ok((select count(*) from public.audit_logs where entity_type = 'company_devices' and action = 'insert') >= 5, 'every registration is audited');
select ok((select count(*) from public.audit_logs where entity_type = 'company_devices' and action = 'update' and reason like 'device assigned:%') >= 1, '... and every assignment, with its reason');

select * from finish();
rollback;
