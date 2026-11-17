-- Phase 2A pgTAP: vehicle register + approvals (migrations 000014, 000015).
--   uniqueness + CHECKs · overlapping assignment rejected · a transfer does not move the vehicle until a
--   fleet administrator approves · requester cannot approve own transfer (DEC-24) · branch manager /
--   supervisor / others cannot approve (DEC-31, fleet admin only) · cross-branch and cross-company
--   read/write denied · caches not user-writable · audit rows written · no deletes
begin;
create extension if not exists pgtap with schema extensions;
select plan(161);

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
create function tests.sqlstate(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlstate; end $$;
create function tests.affected(q text) returns bigint language plpgsql as $$
declare n bigint; begin execute q; get diagnostics n = row_count; return n; end $$;
create function tests.mk_user(n text, comp text, utype text default 'staff') returns void language sql as $$
  insert into auth.users (id, email) values (tests.id(n), n || '@example.test');
  insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier)
  values (tests.id(n), tests.id(comp), 'Synthetic ' || n, n || '@example.test', utype, n);
$$;
create function tests.grant_role(n text, role_name text, branch text, by text) returns void language sql as $$
  insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, granted_by)
  select tests.id(n), r.id, p.company_id, case when branch is null then null else tests.id(branch) end, now() - interval '5 hours', tests.id(by)
  from public.roles r, public.profiles p where r.name = role_name and r.company_id is null and p.id = tests.id(n);
$$;
-- lookups that bypass RLS (definer) so tests can address rows a user may not be able to see
create function tests.vid(reg text) returns uuid language sql security definer set search_path = '' as
  $$ select id from public.vehicles where registration_number = reg $$;
create function tests.apid(reg text, st text default 'pending') returns uuid language sql security definer set search_path = '' as
  $$ select id from public.approvals where entity_id = tests.vid(reg) and status = st order by created_at desc limit 1 $$;
create function tests.mk_evidence(lbl text, usr text, br text, purp text) returns uuid language plpgsql as $$
declare s public.evidence_upload_slots; f uuid;
begin
  perform tests.act_as(usr);
  s := public.request_evidence_upload_slot(purp, tests.id(br), 'file_upload', 'image/jpeg', 1000, tests.id('csid-' || lbl));
  perform tests.reset();
  f := public.register_evidence_file(s.id, tests.id(usr), md5(lbl) || md5(lbl), 'image/jpeg', 1000, 100, 100, true);
  return f;
end $$;
create function tests.create_v(reg text, fleet text, br text, usr text) returns uuid language plpgsql as $$
declare v public.vehicles;
begin
  perform tests.act_as(usr);
  v := public.create_vehicle(tests.id(br), fleet, reg, 'Toyota', 'Hilux', 'bakkie');
  perform tests.reset();
  return v.id;
end $$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'),
  (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot_a', 'coA'), tests.mk_user('boot_b', 'coB'),
       tests.mk_user('fla', 'coA'), tests.mk_user('fla2', 'coA'), tests.mk_user('fla_a1', 'coA'),
       tests.mk_user('bm_a1', 'coA'), tests.mk_user('sup_a1', 'coA'), tests.mk_user('sup_a2', 'coA'),
       tests.mk_user('drv_a1', 'coA', 'driver'), tests.mk_user('drv_a2', 'coA', 'driver'),
       tests.mk_user('mnt', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('fla_b', 'coB');
select tests.grant_role('fla', 'fleet_admin', null, 'boot_a'), tests.grant_role('fla2', 'fleet_admin', null, 'boot_a'),
       tests.grant_role('fla_a1', 'fleet_admin', 'A1', 'boot_a'),
       tests.grant_role('bm_a1', 'branch_manager', 'A1', 'boot_a'), tests.grant_role('sup_a1', 'supervisor', 'A1', 'boot_a'),
       tests.grant_role('sup_a2', 'supervisor', 'A2', 'boot_a'),
       tests.grant_role('drv_a1', 'driver', 'A1', 'boot_a'), tests.grant_role('drv_a2', 'driver', 'A2', 'boot_a'),
       tests.grant_role('mnt', 'maintenance_admin', null, 'boot_a'), tests.grant_role('sa', 'system_admin', null, 'boot_a'),
       tests.grant_role('fla_b', 'fleet_admin', null, 'boot_b');

-- ================================================================ 1. structure, RLS, privileges
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname in ('approvals', 'vehicles', 'vehicle_branch_assignments', 'vehicle_documents')
             and c.relrowsecurity), 4::bigint, 'RLS enabled on all four new tables');
select is((select count(*) from pg_constraint c
           where c.contype = 'f' and c.conrelid in ('public.approvals'::regclass, 'public.vehicles'::regclass,
                 'public.vehicle_branch_assignments'::regclass, 'public.vehicle_documents'::regclass)
             and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indisvalid
                             and (i.indkey::text || ' ') like array_to_string(c.conkey, ' ') || ' %')),
          0::bigint, 'every foreign key has a covering index in FK column order (013 convention)');
select is((select count(*) from pg_policies where schemaname = 'public'
           and tablename in ('approvals', 'vehicles', 'vehicle_branch_assignments', 'vehicle_documents') and cmd = 'DELETE'),
          0::bigint, 'no DELETE policy on any new table');
select ok(not has_table_privilege('authenticated', 'public.vehicles', 'DELETE')
          and not has_table_privilege('authenticated', 'public.vehicle_branch_assignments', 'DELETE')
          and not has_table_privilege('authenticated', 'public.vehicle_documents', 'DELETE')
          and not has_table_privilege('authenticated', 'public.approvals', 'DELETE'), 'no DELETE grant to application users');
select ok(not has_table_privilege('authenticated', 'public.vehicles', 'INSERT')
          and not has_table_privilege('authenticated', 'public.vehicle_branch_assignments', 'INSERT')
          and not has_table_privilege('authenticated', 'public.approvals', 'INSERT')
          and not has_table_privilege('authenticated', 'public.approvals', 'UPDATE'),
          'no direct INSERT on vehicles/assignments/approvals and no UPDATE on approvals: functions only');
select ok(not has_column_privilege('authenticated', 'public.vehicles', 'current_branch_id', 'UPDATE')
          and not has_column_privilege('authenticated', 'public.vehicles', 'current_odometer_km', 'UPDATE')
          and not has_column_privilege('authenticated', 'public.vehicles', 'current_odometer_reading_id', 'UPDATE')
          and has_column_privilege('authenticated', 'public.vehicles', 'make', 'UPDATE'),
          'cache columns are not updatable by users; editable columns are');
select ok(not has_table_privilege('anon', 'public.vehicles', 'SELECT') and not has_table_privilege('anon', 'public.approvals', 'SELECT'),
          'anon has no access');
select is(public.approval_decide_permission('branch_transfer'), 'vehicle.transfer.approve', 'branch_transfer is decided with vehicle.transfer.approve (DEC-31)');
select is(public.approval_decide_permission('odometer_exception'), null, 'types without a handler fail closed');

-- ================================================================ 2. vehicles: uniqueness + CHECKs (direct, as owner)
insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category, vin)
values (tests.id('vX'), tests.id('coA'), tests.id('A1'), 'FX-1', 'T2AX01-GP', 'Ford', 'Ranger', 'bakkie', 'T2AVINX000000001');
select is(tests.sqlstate($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('coA'), tests.id('A1'), 'FX-2', 'T2AX01-GP', 'Ford', 'Ranger', 'bakkie') $$), '23505', 'duplicate registration in a company rejected');
select is(tests.sqlstate($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('coA'), tests.id('A1'), 'FX-1', 'T2AX02-GP', 'Ford', 'Ranger', 'bakkie') $$), '23505', 'duplicate fleet number in a company rejected');
select is(tests.sqlstate($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category, vin)
  values (tests.id('coA'), tests.id('A1'), 'FX-3', 'T2AX03-GP', 'Ford', 'Ranger', 'bakkie', 'T2AVINX000000001') $$), '23505', 'duplicate VIN in a company rejected');
select lives_ok($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('coA'), tests.id('A1'), 'FX-4', 'T2AX04-GP', 'Ford', 'Ranger', 'bakkie'),
         (tests.id('coA'), tests.id('A1'), 'FX-5', 'T2AX05-GP', 'Ford', 'Ranger', 'bakkie') $$, 'VIN is unique only where not null (two vehicles without VIN)');
select lives_ok($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category, vin)
  values (tests.id('coB'), tests.id('B1'), 'FX-1', 'T2AX01-GP', 'Ford', 'Ranger', 'bakkie', 'T2AVINX000000001') $$,
  'the same registration, fleet number and VIN are fine in another company');
select is(tests.sqlstate($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('coA'), tests.id('B1'), 'FX-6', 'T2AX06-GP', 'Ford', 'Ranger', 'bakkie') $$), '23503', 'vehicle cannot sit in a branch of another company (composite FK)');
select is(tests.sqlstate($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('coA'), tests.id('A1'), 'FX-7', 'testx07-gp', 'Ford', 'Ranger', 'bakkie') $$), '23514', 'registration must be upper-case and trimmed');
select is(tests.sqlstate($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category, current_odometer_km)
  values (tests.id('coA'), tests.id('A1'), 'FX-8', 'T2AX08-GP', 'Ford', 'Ranger', 'bakkie', -1) $$), '23514', 'current_odometer_km >= 0');
select is(tests.sqlstate($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category, administrative_status)
  values (tests.id('coA'), tests.id('A1'), 'FX-9', 'T2AX09-GP', 'Ford', 'Ranger', 'bakkie', 'allocated') $$), '23514', 'administrative_status is a stored status only (derived ones are rejected, AD-06)');
select is(tests.sqlstate($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category, model_year)
  values (tests.id('coA'), tests.id('A1'), 'FX-10', 'T2AX10-GP', 'Ford', 'Ranger', 'bakkie', 3000) $$), '23514', 'model_year range');

-- ================================================================ 3. create_vehicle (first assignment with the vehicle)
select tests.act_as('fla');
select is((select (public.create_vehicle(tests.id('A1'), 'FL-001', 'T2A001-GP', 'Toyota', 'Hilux', 'bakkie', p_vin => 'T2AVIN0000000001')).current_branch_id),
          tests.id('A1'), 'fleet admin creates a vehicle in a branch');
select tests.reset();
select is((select count(*) from public.vehicle_branch_assignments where vehicle_id = tests.vid('T2A001-GP') and effective_to is null
           and approval_id is null and branch_id = tests.id('A1')), 1::bigint, 'the first assignment is created with the vehicle, without an approval');
select is((select current_odometer_km from public.vehicles where id = tests.vid('T2A001-GP')), 0, 'odometer cache starts at 0');
select tests.act_as('fla');
select ok(tests.fails($$ select public.create_vehicle(tests.id('A1'), 'FL-001', 'T2A099-GP', 'Toyota', 'Hilux', 'bakkie') $$), 'duplicate fleet number refused');
select ok(tests.fails($$ select public.create_vehicle(tests.id('A1'), 'FL-099', 'T2A001-GP', 'Toyota', 'Hilux', 'bakkie') $$), 'duplicate registration refused');
select ok(tests.fails($$ select public.create_vehicle(tests.id('B1'), 'FL-098', 'T2A098-GP', 'Toyota', 'Hilux', 'bakkie') $$), 'cannot create a vehicle in another company''s branch');
select tests.act_as('fla_a1');
select ok(tests.fails($$ select public.create_vehicle(tests.id('A2'), 'FL-097', 'T2A097-GP', 'Toyota', 'Hilux', 'bakkie') $$), 'branch-scoped fleet admin cannot create in another branch');
select lives_ok($$ select public.create_vehicle(tests.id('A1'), 'FL-002', 'T2A002-GP', 'Isuzu', 'D-Max', 'bakkie') $$, 'branch-scoped fleet admin creates in own branch');
select tests.reset();
select tests.act_as('bm_a1');
select is(tests.sqlstate($$ select public.create_vehicle(tests.id('A1'), 'FL-096', 'T2A096-GP', 'Toyota', 'Hilux', 'bakkie') $$), '42501', 'branch manager cannot create a vehicle (vehicle.manage is fleet admin only)');
select tests.act_as('sup_a1');
select is(tests.sqlstate($$ select public.create_vehicle(tests.id('A1'), 'FL-095', 'T2A095-GP', 'Toyota', 'Hilux', 'bakkie') $$), '42501', 'supervisor cannot create a vehicle');
select tests.act_as('mnt');
select is(tests.sqlstate($$ select public.create_vehicle(tests.id('A1'), 'FL-094', 'T2A094-GP', 'Toyota', 'Hilux', 'bakkie') $$), '42501', 'maintenance admin cannot create a vehicle');
select tests.act_as('sa');
select is(tests.sqlstate($$ select public.create_vehicle(tests.id('A1'), 'FL-093', 'T2A093-GP', 'Toyota', 'Hilux', 'bakkie') $$), '42501', 'system admin cannot create a vehicle');
select tests.act_as('drv_a1');
select is(tests.sqlstate($$ select public.create_vehicle(tests.id('A1'), 'FL-092', 'T2A092-GP', 'Toyota', 'Hilux', 'bakkie') $$), '42501', 'driver cannot create a vehicle');
select tests.act_as('fla_b');
select is(tests.sqlstate($$ select public.create_vehicle(tests.id('A1'), 'FL-091', 'T2A091-GP', 'Toyota', 'Hilux', 'bakkie') $$), '42501', 'other-company fleet admin cannot create in company A');
select tests.reset();
-- more vehicles for later: A2 vehicles and a company B vehicle
select tests.create_v('T2A003-GP', 'FL-003', 'A2', 'fla');
select tests.create_v('T2A004-GP', 'FL-004', 'A1', 'fla');
select tests.create_v('T2A005-GP', 'FL-005', 'A1', 'fla');
select tests.create_v('T2AB01-GP', 'FB-001', 'B1', 'fla_b');
select tests.act_as('fla');
select ok(tests.fails($$ insert into public.vehicles (company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('coA'), tests.id('A1'), 'FL-777', 'TEST777-GP', 'x', 'y', 'z') $$), 'no direct INSERT into vehicles, even for a fleet admin');
select ok(tests.fails($$ insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, created_by)
  values (tests.id('coA'), tests.vid('T2A001-GP'), tests.id('A2'), now(), tests.id('fla')) $$), 'no direct INSERT into assignments, even for a fleet admin');
select tests.reset();

-- ================================================================ 4. assignments: overlap / approval rules (as owner)
-- T2AX04-GP / T2AX05-GP were inserted directly above and have no assignment yet.
select lives_ok($$ insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, created_by)
  values (tests.id('coA'), tests.vid('T2AX04-GP'), tests.id('A1'), now() - interval '10 days', tests.id('fla')),
         (tests.id('coA'), tests.vid('T2AX05-GP'), tests.id('A1'), now() - interval '10 days', tests.id('fla')) $$, 'first assignments need no approval');
select is(tests.sqlstate($$ insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, effective_to, created_by)
  values (tests.id('coA'), tests.vid('T2AX04-GP'), tests.id('A2'), now() - interval '1 day', now() + interval '1 day', tests.id('fla')) $$),
  '23514', 'a second assignment without an approved branch_transfer is refused (DEC-31)');
-- craft an approved, matching approval to isolate the exclusion constraint
insert into public.approvals (id, company_id, branch_id, entity_type, entity_id, approval_type, requested_by, status, decided_by, decided_at, payload)
values (tests.id('ap-ovl'), tests.id('coA'), tests.id('A1'), 'vehicle', tests.vid('T2AX04-GP'), 'branch_transfer', tests.id('fla'),
        'approved', tests.id('fla2'), now(), jsonb_build_object('from_branch_id', tests.id('A1'), 'to_branch_id', tests.id('A2')));
select is(tests.sqlstate($$ insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, approval_id, created_by)
  values (tests.id('coA'), tests.vid('T2AX04-GP'), tests.id('A2'), now(), tests.id('ap-ovl'), tests.id('fla')) $$),
  '23P01', 'overlapping assignment ranges for one vehicle are rejected (exclusion constraint)');
select is(tests.sqlstate($$ insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, effective_to, approval_id, created_by)
  values (tests.id('coA'), tests.vid('T2AX04-GP'), tests.id('A2'), now(), now() - interval '1 hour', tests.id('ap-ovl'), tests.id('fla')) $$),
  '23514', 'effective_to must be after effective_from');
select is(tests.sqlstate($$ insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, approval_id, created_by)
  values (tests.id('coA'), tests.vid('T2AX05-GP'), tests.id('A2'), now() + interval '9 days', tests.id('ap-ovl'), tests.id('fla')) $$),
  '23514', 'an approval for another vehicle cannot open an assignment');
select is(tests.sqlstate($$ update public.vehicle_branch_assignments set branch_id = tests.id('A2') where vehicle_id = tests.vid('T2AX04-GP') $$),
  '23514', 'assignment history cannot be edited (branch_id immutable)');
select is(tests.sqlstate($$ delete from public.vehicle_branch_assignments $$), '42501', 'assignments cannot be deleted, even by the owner');

-- ================================================================ 5. approvals: constraints (as owner)
select is(tests.sqlstate($$ insert into public.approvals (company_id, entity_type, entity_id, approval_type, requested_by, status, decided_by, decided_at)
  values (tests.id('coA'), 'vehicle', tests.vid('T2A002-GP'), 'branch_transfer', tests.id('fla'), 'approved', tests.id('fla'), now()) $$),
  '23514', 'CHECK decided_by <> requested_by (DEC-24)');
select is(tests.sqlstate($$ insert into public.approvals (company_id, entity_type, entity_id, approval_type, requested_by, status)
  values (tests.id('coA'), 'vehicle', tests.vid('T2A002-GP'), 'branch_transfer', tests.id('fla'), 'maybe') $$), '23514', 'approval status is pending/approved/rejected/cancelled only');
select is(tests.sqlstate($$ insert into public.approvals (company_id, entity_type, entity_id, approval_type, requested_by)
  values (tests.id('coA'), 'vehicle', tests.vid('T2A002-GP'), 'something_else', tests.id('fla')) $$), '23514', 'approval_type is from the DB §17 list');
select is(tests.sqlstate($$ insert into public.approvals (company_id, entity_type, entity_id, approval_type, requested_by, status)
  values (tests.id('coA'), 'vehicle', tests.vid('T2A002-GP'), 'branch_transfer', tests.id('fla'), 'approved') $$), '23514', 'a decided approval must carry decided_by and decided_at');
select is(tests.sqlstate($$ update public.approvals set reason = 'edited' where id = tests.id('ap-ovl') $$), '55000', 'a decided approval cannot be edited at all');
select is(tests.sqlstate($$ update public.approvals set status = 'rejected' where id = tests.id('ap-ovl') $$), '55000', 'a decided approval cannot change (approved -> rejected refused)');
select is(tests.sqlstate($$ delete from public.approvals $$), '42501', 'approvals cannot be deleted');
select ok(tests.fails($$ truncate public.approvals cascade $$), 'approvals cannot be truncated');

-- ================================================================ 6. reads: branch and company scope
select tests.act_as('fla');
select is((select count(*) from public.vehicles where registration_number like 'T2A0%' ), 5::bigint, 'company-wide fleet admin reads all company vehicles');
select is((select count(*) from public.vehicles where company_id <> tests.id('coA')), 0::bigint, 'fleet admin A sees no company B vehicle');
select tests.act_as('drv_a1');
select is((select count(*) from public.vehicles where registration_number like 'T2A0%'), 4::bigint, 'a role on branch A1 reads A1 vehicles only');
select is((select count(*) from public.vehicles where registration_number = 'T2A003-GP'), 0::bigint, 'a branch A1 role cannot read an A2 vehicle');
select is((select count(*) from public.vehicle_branch_assignments where branch_id = tests.id('A2')), 0::bigint, 'nor A2 assignment history');
select tests.act_as('sup_a2');
select is((select count(*) from public.vehicles where registration_number like 'T2A0%'), 1::bigint, 'a branch A2 role reads the A2 vehicle only');
select tests.act_as('fla_b');
select is((select count(*) from public.vehicles where registration_number like 'T2A0%'), 0::bigint, 'company B cannot read company A vehicles');
select is((select count(*) from public.vehicles), 2::bigint, 'company B reads only its own two vehicles');
select tests.act_as('bm_a1');
select is((select count(*) from public.vehicles where registration_number like 'T2A0%'), 4::bigint, 'branch manager reads own-branch vehicles');
select tests.reset();

-- ================================================================ 7. updates: columns, scope, caches, archive
select tests.act_as('fla');
select is(tests.affected($$ update public.vehicles set make = 'Mazda', variant = '2.4 GD-6' where registration_number = 'T2A001-GP' $$), 1::bigint, 'fleet admin edits register fields');
select is(tests.sqlstate($$ update public.vehicles set current_branch_id = tests.id('A2') where registration_number = 'T2A001-GP' $$), '42501', 'current_branch_id is a cache: not writable, even by a fleet admin');
select is(tests.sqlstate($$ update public.vehicles set current_odometer_km = 99999 where registration_number = 'T2A001-GP' $$), '42501', 'current_odometer_km is a cache: not writable');
select is(tests.sqlstate($$ update public.vehicles set current_odometer_reading_id = gen_random_uuid() where registration_number = 'T2A001-GP' $$), '42501', 'current_odometer_reading_id is a cache: not writable');
select is(tests.sqlstate($$ update public.vehicles set company_id = tests.id('coB') where registration_number = 'T2A001-GP' $$), '42501', 'company_id is not writable');
select is(tests.sqlstate($$ update public.vehicles set registration_number = 'T2A002-GP' where registration_number = 'T2A001-GP' $$), '23505', 'editing into a duplicate registration is rejected');
select is(tests.sqlstate($$ delete from public.vehicles where registration_number = 'T2A001-GP' $$), '42501', 'vehicles cannot be deleted (archive instead)');
select tests.act_as('fla_a1');
select is(tests.affected($$ update public.vehicles set make = 'Hacked' where registration_number = 'T2A003-GP' $$), 0::bigint, 'branch-scoped fleet admin cannot edit another branch''s vehicle (0 rows)');
select tests.act_as('bm_a1');
select is(tests.affected($$ update public.vehicles set make = 'Hacked' where registration_number = 'T2A001-GP' $$), 0::bigint, 'branch manager cannot edit a vehicle (no vehicle.manage)');
select tests.act_as('drv_a1');
select is(tests.affected($$ update public.vehicles set make = 'Hacked' where registration_number = 'T2A001-GP' $$), 0::bigint, 'driver cannot edit a vehicle');
select tests.act_as('fla_b');
select is(tests.affected($$ update public.vehicles set make = 'Hacked' where registration_number = 'T2A001-GP' $$), 0::bigint, 'other-company fleet admin cannot edit');
select tests.act_as('fla');
select is(tests.affected($$ update public.vehicles set archived_at = now() where registration_number = 'T2A005-GP' $$), 1::bigint, 'fleet admin archives a vehicle');
select is(tests.sqlstate($$ update public.vehicles set make = 'Edited' where registration_number = 'T2A005-GP' $$), '55000', 'an archived vehicle cannot be edited');
select is(tests.affected($$ update public.vehicles set archived_at = null where registration_number = 'T2A005-GP' $$), 1::bigint, 'it can be un-archived');
select tests.reset();
select is((select make from public.vehicles where registration_number = 'T2A001-GP'), 'Mazda', 'only the permitted edit persisted');
select is((select current_branch_id from public.vehicles where registration_number = 'T2A001-GP'), tests.id('A1'), 'cache untouched by the denied writes');

-- ================================================================ 8. transfer: request does not move anything
select tests.act_as('fla');
select is((select (public.request_vehicle_transfer(tests.vid('T2A001-GP'), tests.id('A2'), 'Rebalancing fleet', tests.id('tr-1'))).status), 'pending', 'transfer is requested as a pending approval');
select is((select (public.request_vehicle_transfer(tests.vid('T2A001-GP'), tests.id('A2'), 'Rebalancing fleet', tests.id('tr-1'))).id),
          tests.apid('T2A001-GP'), 'retrying with the same client_submission_id returns the same request');
select tests.reset();
select is((select count(*) from public.approvals where entity_id = tests.vid('T2A001-GP') and approval_type = 'branch_transfer' and status = 'pending'), 1::bigint,
          'idempotent: one pending request');
select is((select current_branch_id from public.vehicles where id = tests.vid('T2A001-GP')), tests.id('A1'), 'requesting a transfer does NOT move the vehicle');
select is((select count(*) from public.vehicle_branch_assignments where vehicle_id = tests.vid('T2A001-GP')), 1::bigint, 'no assignment row was added by the request');
select is((select count(*) from public.vehicle_branch_assignments where vehicle_id = tests.vid('T2A001-GP') and effective_to is null and branch_id = tests.id('A1')), 1::bigint,
          'the A1 assignment is still the open one');
select tests.act_as('fla');
select is(tests.sqlstate($$ select public.request_vehicle_transfer(tests.vid('T2A001-GP'), tests.id('A2'), 'Again', tests.id('tr-2')) $$), '23505', 'only one pending transfer per vehicle');
select is(tests.sqlstate($$ select public.request_vehicle_transfer(tests.vid('T2A002-GP'), tests.id('A1'), 'Same branch', tests.id('tr-3')) $$), '22023', 'destination must differ from the current branch');
select is(tests.sqlstate($$ select public.request_vehicle_transfer(tests.vid('T2A002-GP'), tests.id('B1'), 'Cross company', tests.id('tr-4')) $$), '23514', 'destination must be a branch of the same company');
select is(tests.sqlstate($$ select public.request_vehicle_transfer(tests.vid('T2A002-GP'), tests.id('A2'), '   ', tests.id('tr-5')) $$), '22023', 'a reason is required');
select is(tests.sqlstate($$ select public.request_vehicle_transfer(tests.vid('T2AB01-GP'), tests.id('A2'), 'Other company vehicle', tests.id('tr-6')) $$), 'P0002', 'a vehicle of another company is not found');
select tests.act_as('fla_a1');
select is(tests.sqlstate($$ select public.request_vehicle_transfer(tests.vid('T2A002-GP'), tests.id('A2'), 'No rights on A2', tests.id('tr-7')) $$), '42501', 'requester needs vehicle.manage on source AND destination');
select tests.act_as('bm_a1');
select is(tests.sqlstate($$ select public.request_vehicle_transfer(tests.vid('T2A002-GP'), tests.id('A2'), 'Branch manager', tests.id('tr-8')) $$), '42501', 'branch manager cannot request a transfer');
select tests.act_as('sup_a1');
select is(tests.sqlstate($$ select public.request_vehicle_transfer(tests.vid('T2A002-GP'), tests.id('A2'), 'Supervisor', tests.id('tr-9')) $$), '42501', 'supervisor cannot request a transfer');
select tests.act_as('fla');
select is(tests.sqlstate($$ update public.vehicles set archived_at = now() where registration_number = 'T2A004-GP' $$), null, 'archive a vehicle');
select is(tests.sqlstate($$ select public.request_vehicle_transfer(tests.vid('T2A004-GP'), tests.id('A2'), 'Archived', tests.id('tr-10')) $$), '55000', 'an archived vehicle cannot be transferred');
select tests.reset();

-- ================================================================ 9. approvals: visibility + who can decide
select tests.act_as('fla');
select is((select count(*) from public.approvals where status = 'pending'), 1::bigint, 'the requester reads their own request');
select tests.act_as('fla2');
select is((select count(*) from public.approvals where status = 'pending'), 1::bigint, 'another fleet admin (matching approve permission) reads it');
select tests.act_as('bm_a1');
select is((select count(*) from public.approvals where status = 'pending'), 0::bigint, 'a branch manager cannot read it (no vehicle.transfer.approve)');
select tests.act_as('sup_a1');
select is((select count(*) from public.approvals where status = 'pending'), 0::bigint, 'a supervisor cannot read it');
select tests.act_as('fla_b');
select is((select count(*) from public.approvals where status = 'pending'), 0::bigint, 'another company cannot read it');
select tests.act_as('fla');
select ok(tests.fails($$ update public.approvals set status = 'approved' where status = 'pending' $$), 'approvals cannot be updated directly');
select ok(tests.fails($$ insert into public.approvals (company_id, entity_type, entity_id, approval_type, requested_by)
  values (tests.id('coA'), 'vehicle', tests.vid('T2A002-GP'), 'branch_transfer', tests.id('fla')) $$), 'approvals cannot be inserted directly');

select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A001-GP'))), '42501', 'the requester cannot approve their own transfer (DEC-24)');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''rejected'', null)', tests.apid('T2A001-GP'))), '42501', 'nor reject it');
select tests.act_as('bm_a1');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A001-GP'))), '42501', 'branch manager cannot approve a transfer (fleet admin only, DEC-31)');
select tests.act_as('sup_a1');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A001-GP'))), '42501', 'supervisor cannot approve a transfer');
select tests.act_as('mnt');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A001-GP'))), '42501', 'maintenance admin cannot approve a transfer');
select tests.act_as('sa');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A001-GP'))), '42501', 'system admin cannot approve a transfer');
select tests.act_as('drv_a1');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A001-GP'))), '42501', 'driver cannot approve a transfer');
select tests.act_as('fla_b');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A001-GP'))), 'P0002', 'another company cannot even find the approval');
select tests.act_as('fla_a1');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A001-GP'))), '42501', 'a fleet admin scoped to the source branch only cannot approve a transfer into another branch');
select tests.act_as('fla2');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''maybe'', null)', tests.apid('T2A001-GP'))), '22023', 'decision must be approved or rejected');
select tests.reset();
select is((select status from public.approvals where id = tests.apid('T2A001-GP')), 'pending', 'all the denied attempts left the approval pending');
select is((select current_branch_id from public.vehicles where id = tests.vid('T2A001-GP')), tests.id('A1'), 'and the vehicle has not moved');
select is((select count(*) from public.vehicle_branch_assignments where vehicle_id = tests.vid('T2A001-GP')), 1::bigint, 'and no assignment was written');

-- ================================================================ 10. approval by a different fleet admin moves the vehicle
select tests.act_as('fla2');
select is((select (public.decide_approval(tests.apid('T2A001-GP'), 'approved', 'Agreed')).status), 'approved', 'a different fleet administrator approves the transfer');
select tests.reset();
select is((select decided_by from public.approvals where entity_id = tests.vid('T2A001-GP') and status = 'approved'), tests.id('fla2'), 'decided_by is the approver');
select is((select current_branch_id from public.vehicles where id = tests.vid('T2A001-GP')), tests.id('A2'), 'only now has the vehicle moved: current_branch_id updated');
select is((select count(*) from public.vehicle_branch_assignments where vehicle_id = tests.vid('T2A001-GP')), 2::bigint, 'history keeps both assignment rows');
select ok((select effective_to is not null from public.vehicle_branch_assignments where vehicle_id = tests.vid('T2A001-GP') and branch_id = tests.id('A1')), 'the A1 row was closed, not edited away');
select is((select count(*) from public.vehicle_branch_assignments where vehicle_id = tests.vid('T2A001-GP') and branch_id = tests.id('A2')
           and effective_to is null and approval_id = tests.apid('T2A001-GP', 'approved')), 1::bigint, 'the A2 row is open and carries the approval id');
select ok((select a.effective_to = b.effective_from from public.vehicle_branch_assignments a, public.vehicle_branch_assignments b
           where a.vehicle_id = tests.vid('T2A001-GP') and b.vehicle_id = a.vehicle_id and a.branch_id = tests.id('A1') and b.branch_id = tests.id('A2')),
          'no gap and no overlap between the two ranges');
select tests.act_as('fla2');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A001-GP', 'approved'))), '55000', 'a decided approval cannot be decided again');
select is(tests.sqlstate(format('select public.cancel_approval(%L)', tests.apid('T2A001-GP', 'approved'))), '42501', 'nor cancelled (not the requester)');
select tests.act_as('drv_a1');
select is((select count(*) from public.vehicles where registration_number = 'T2A001-GP'), 0::bigint, 'the A1 driver no longer sees the moved vehicle');
select tests.act_as('sup_a2');
select is((select count(*) from public.vehicles where registration_number = 'T2A001-GP'), 1::bigint, 'the A2 supervisor now sees it');
select tests.reset();

-- ================================================================ 11. reject and cancel paths
select tests.act_as('fla');
select lives_ok($$ select public.request_vehicle_transfer(tests.vid('T2A002-GP'), tests.id('A2'), 'To be rejected', tests.id('tr-11')) $$, 'second request (to be rejected)');
select tests.act_as('fla2');
select is((select (public.decide_approval(tests.apid('T2A002-GP'), 'rejected', 'Not now')).status), 'rejected', 'a fleet admin rejects a transfer');
select tests.reset();
select is((select current_branch_id from public.vehicles where id = tests.vid('T2A002-GP')), tests.id('A1'), 'a rejected transfer leaves the vehicle where it was');
select is((select count(*) from public.vehicle_branch_assignments where vehicle_id = tests.vid('T2A002-GP')), 1::bigint, 'and writes no assignment');
select tests.act_as('fla');
select lives_ok($$ select public.request_vehicle_transfer(tests.vid('T2A002-GP'), tests.id('A2'), 'To be cancelled', tests.id('tr-12')) $$, 'a new request is possible after a rejection');
select tests.act_as('fla2');
select is(tests.sqlstate(format('select public.cancel_approval(%L)', tests.apid('T2A002-GP'))), '42501', 'only the requester can cancel');
select tests.act_as('fla');
select is((select (public.cancel_approval(tests.apid('T2A002-GP'))).status), 'cancelled', 'the requester cancels their own request');
select tests.act_as('fla2');
select is(tests.sqlstate(format('select public.decide_approval(%L, ''approved'', null)', tests.apid('T2A002-GP', 'cancelled'))), '55000', 'a cancelled request cannot be approved');
select tests.reset();
select is((select current_branch_id from public.vehicles where id = tests.vid('T2A002-GP')), tests.id('A1'), 'cancelled: still not moved');
-- stale request: the approved effect refuses when the vehicle moved since the request (checked at apply time)
select is((select count(*) from public.approvals where entity_id = tests.vid('T2A002-GP')), 2::bigint, 'two requests recorded for the vehicle (rejected, cancelled): history kept');

-- ================================================================ 12. documents
select tests.mk_evidence('doc1', 'fla', 'A1', 'vehicle_document');
select tests.mk_evidence('odo1', 'drv_a1', 'A1', 'odometer');
select tests.mk_evidence('docB', 'fla_b', 'B1', 'vehicle_document');
create function tests.ev(lbl text) returns uuid language sql security definer set search_path = '' as
  $$ select f.id from public.evidence_files f where f.sha256 = md5(lbl) || md5(lbl) $$;
select tests.act_as('fla');
select lives_ok($$ insert into public.vehicle_documents (company_id, vehicle_id, document_type, document_number, issue_date, expiry_date, evidence_file_id, created_by)
  values (tests.id('coA'), tests.vid('T2A002-GP'), 'licence_disc', 'LD-TEST-1', '2026-01-01', '2027-01-01', tests.ev('doc1'), tests.id('fla')) $$,
  'fleet admin records a vehicle document linked to vehicle_document evidence');
select is(tests.sqlstate($$ insert into public.vehicle_documents (company_id, vehicle_id, document_type, issue_date, expiry_date, evidence_file_id, created_by)
  values (tests.id('coA'), tests.vid('T2A002-GP'), 'insurance', '2027-01-02', '2027-01-01', tests.ev('doc1'), tests.id('fla')) $$), '23514', 'expiry_date >= issue_date');
select is(tests.sqlstate($$ insert into public.vehicle_documents (company_id, vehicle_id, document_type, evidence_file_id, created_by)
  values (tests.id('coA'), tests.vid('T2A002-GP'), 'insurance', tests.ev('odo1'), tests.id('fla')) $$), '23514', 'linked evidence must have purpose vehicle_document');
select is(tests.sqlstate($$ insert into public.vehicle_documents (company_id, vehicle_id, document_type, evidence_file_id, created_by)
  values (tests.id('coA'), tests.vid('T2A002-GP'), 'insurance', tests.ev('docB'), tests.id('fla')) $$), '23514', 'linked evidence must belong to the same company');
select is(tests.sqlstate($$ insert into public.vehicle_documents (company_id, vehicle_id, document_type, evidence_file_id, created_by, verification_status)
  values (tests.id('coA'), tests.vid('T2A002-GP'), 'insurance', tests.ev('doc1'), tests.id('fla'), 'verified') $$), '42501', 'users cannot set verification_status (no verification path in this slice)');
select is(tests.sqlstate($$ insert into public.vehicle_documents (company_id, vehicle_id, document_type, evidence_file_id, created_by)
  values (tests.id('coA'), tests.vid('T2A002-GP'), 'insurance', tests.ev('doc1'), tests.id('fla2')) $$), '42501', 'created_by must be the caller (RLS)');
select is(tests.affected($$ update public.vehicle_documents set document_number = 'LD-TEST-2' where document_number = 'LD-TEST-1' $$), 1::bigint, 'fleet admin corrects document details');
select is(tests.sqlstate($$ update public.vehicle_documents set verification_status = 'verified' where document_number = 'LD-TEST-2' $$), '42501', 'verification_status is not updatable');
select is(tests.sqlstate($$ update public.vehicle_documents set evidence_file_id = tests.ev('odo1') where document_number = 'LD-TEST-2' $$), '42501', 'the evidence link is not updatable');
select is(tests.sqlstate($$ delete from public.vehicle_documents $$), '42501', 'documents cannot be deleted');
select tests.act_as('bm_a1');
select is((select count(*) from public.vehicle_documents), 1::bigint, 'a role on the vehicle''s branch can read its documents');
select is(tests.sqlstate($$ insert into public.vehicle_documents (company_id, vehicle_id, document_type, evidence_file_id, created_by)
  values (tests.id('coA'), tests.vid('T2A002-GP'), 'insurance', tests.ev('doc1'), tests.id('bm_a1')) $$), '42501', 'branch manager cannot add documents (vehicle.manage)');
select is(tests.affected($$ update public.vehicle_documents set document_number = 'X' $$), 0::bigint, 'branch manager cannot edit documents');
select tests.act_as('drv_a2');
select is((select count(*) from public.vehicle_documents), 0::bigint, 'a role on another branch cannot read the documents');
select tests.act_as('fla_b');
select is((select count(*) from public.vehicle_documents), 0::bigint, 'another company cannot read the documents');
select tests.reset();
select is(tests.sqlstate($$ insert into public.vehicle_documents (company_id, vehicle_id, document_type, evidence_file_id, created_by, verification_status, verified_by, verified_at)
  values (tests.id('coA'), tests.vid('T2A002-GP'), 'insurance', tests.ev('doc1'), tests.id('fla'), 'verified', tests.id('fla'), now()) $$), '23514', 'DEC-24: a document cannot be verified by its creator');
select is(tests.sqlstate($$ insert into public.vehicle_documents (company_id, vehicle_id, document_type, evidence_file_id, created_by, verification_status)
  values (tests.id('coA'), tests.vid('T2A002-GP'), 'insurance', tests.ev('doc1'), tests.id('fla'), 'verified') $$), '23514', 'verified needs verified_by and verified_at');
select is(tests.sqlstate($$ delete from public.vehicle_documents $$), '42501', 'documents cannot be deleted by the owner either');

-- ================================================================ 13. audit rows (DB triggers)
select ok((select count(*) from public.audit_logs where entity_type = 'vehicles' and action = 'insert' and actor_id = tests.id('fla')) >= 1, 'vehicle creation is audited with the actor');
select is((select count(*) from public.audit_logs where entity_type = 'vehicles' and action = 'update' and actor_id = tests.id('fla')
           and entity_id = tests.vid('T2A001-GP') and (before_values ->> 'make') = 'Toyota' and (after_values ->> 'make') = 'Mazda'), 1::bigint, 'a vehicle edit is audited with before and after values');
select ok((select count(*) from public.audit_logs where entity_type = 'vehicle_branch_assignments' and action = 'insert' and actor_id = tests.id('fla')) >= 1, 'the first assignment is audited');
select is((select count(*) from public.audit_logs where entity_type = 'vehicle_branch_assignments' and entity_id is not null and actor_id = tests.id('fla2')), 2::bigint,
          'the transfer (close old row + open new row) is audited against the approver');
select is((select count(*) from public.audit_logs where entity_type = 'approvals' and action = 'insert' and actor_id = tests.id('fla')), 3::bigint, 'each transfer request is audited');
select is((select count(*) from public.audit_logs where entity_type = 'approvals' and action = 'update' and actor_id = tests.id('fla2')
           and (before_values ->> 'status') = 'pending' and (after_values ->> 'status') in ('approved', 'rejected')), 2::bigint, 'approve and reject decisions are audited with the decider');
select is((select count(*) from public.audit_logs where entity_type = 'vehicle_documents' and action = 'insert' and actor_id = tests.id('fla')), 1::bigint, 'document creation is audited');
select is((select count(*) from public.audit_logs where entity_type = 'vehicle_documents' and action = 'update'), 1::bigint, 'document correction is audited');
select is(tests.sqlstate($$ update public.audit_logs set action = 'insert' where entity_type = 'vehicles' $$), '42501', 'audit rows cannot be changed');
select tests.act_as('fla');
select ok((select count(*) from public.audit_logs where entity_type = 'vehicle_branch_assignments') >= 1, 'a fleet admin (audit.view) can read the assignment audit trail');
select tests.act_as('bm_a1');
select is((select count(*) from public.audit_logs where entity_type in ('vehicles', 'approvals')), 0::bigint, 'a branch manager cannot read audit rows');
select tests.reset();

select * from finish();
rollback;
