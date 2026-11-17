-- Slice 2C pgTAP: service configuration, resolution, service records, baseline import, vehicle_service_status
-- (migrations 022-025; DEC-11, DEC-19, DEC-20, DEC-24; DB §10, §17; PRD §5.10). Synthetic data only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(172);

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
create function tests.n(q text) returns integer language plpgsql as $$
declare r integer; begin execute q into r; return r; end $$;
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
create function tests.mk_driver(n text, comp text, emp text, branch text) returns void language sql as $$
  select tests.mk_user(n, comp, 'driver');
  insert into public.drivers (id, company_id, profile_id, employee_number, branch_id)
  values (tests.id('d-' || n), tests.id(comp), tests.id(n), emp, tests.id(branch));
  select tests.grant_role(n, 'driver', branch, case when comp = 'coB' then 'bootb' else 'boot' end);
$$;
create function tests.mk_evidence(label text, comp text, branch text, purpose text, uploader text) returns void language sql as $$
  insert into public.evidence_files (id, company_id, branch_id, bucket, object_path, sha256, mime_type, size_bytes,
                                     capture_source, exif_gps_stripped, uploaded_by, purpose)
  values (tests.id('ev-' || label), tests.id(comp), tests.id(branch), 'evidence', 'test/' || label || '.jpg',
          repeat('a', 64), 'image/jpeg', 1000, 'file_upload', true, tests.id(uploader), purpose);
$$;

create function tests.act_anon() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims', '', true); set local role anon; end $$;
create function tests.act_service() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claims', '', true); set local role service_role; end $$;


create function tests.fails(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;
-- ---------------------------------------------------------------- 2C helpers
create function tests.mk_vehicle(n text, comp text, branch text, make text, model text, cat text) returns void language sql as $$
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('v-' || n), tests.id(comp), tests.id(branch), 'FL-' || n, 'REG' || upper(n), make, model, cat);
$$;
create function tests.decide(csid text, who text, decision text default 'approved') returns void language plpgsql as $$
begin
  perform tests.act_as(who);
  perform public.decide_approval((select id from public.approvals where client_submission_id = tests.id(csid)), decision);
end $$;
create function tests.cfg_scope(v text, at timestamptz) returns text language sql as $$
  select scope || ':' || service_interval_km from public.resolve_service_config(tests.id('v-' || v), at) $$;
-- a record that is created by one user and verified by another (setup helper, goes through the real functions)
create function tests.verified_record(v text, d date, odo integer, creator text, verifier text, csid text) returns uuid language plpgsql as $$
declare rid uuid;
begin
  perform tests.act_as(creator);
  rid := public.create_service_record(tests.id('v-' || v), d, odo, 'Scheduled service', 'workshop', null, null, null, null, null, null, null, tests.id(csid));
  perform tests.act_as(verifier);
  perform public.verify_service_record(rid, 'verified');
  perform tests.reset();
  return rid;
end $$;

-- ---------------------------------------------------------------- fixtures (synthetic)
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB');
select tests.mk_user('fa', 'coA'), tests.mk_user('fa2', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('ma2', 'coA'),
       tests.mk_user('ma_a2', 'coA'), tests.mk_user('bm1', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sm', 'coA'),
       tests.mk_user('fab', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('fa2', 'fleet_admin', null, 'boot'),
       tests.grant_role('ma', 'maintenance_admin', null, 'boot'), tests.grant_role('ma2', 'maintenance_admin', null, 'boot'),
       tests.grant_role('ma_a2', 'maintenance_admin', 'A2', 'boot'), tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'),
       tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sm', 'senior_management', null, 'boot'),
       tests.grant_role('fab', 'fleet_admin', null, 'bootb');
select tests.mk_vehicle('1', 'coA', 'A1', 'Toyota', 'Hilux', 'bakkie'), tests.mk_vehicle('2', 'coA', 'A1', 'Ford', 'Ranger', 'bakkie'),
       tests.mk_vehicle('3', 'coA', 'A1', 'Isuzu', 'D-Max', 'panel van'), tests.mk_vehicle('4', 'coA', 'A2', 'Nissan', 'NP200', 'sedan'),
       tests.mk_vehicle('5', 'coA', 'A1', 'VW', 'Amarok', 'bakkie'), tests.mk_vehicle('6', 'coA', 'A1', 'Kia', 'K2700', 'truck'),
       tests.mk_vehicle('7', 'coA', 'A1', 'Mazda', 'BT-50', 'bakkie'), tests.mk_vehicle('8', 'coA', 'A1', 'Hino', '300', 'truck'),
       tests.mk_vehicle('b1', 'coB', 'B1', 'Toyota', 'Hilux', 'bakkie');
select tests.mk_evidence('sr1', 'coA', 'A1', 'service_record', 'ma'), tests.mk_evidence('sr2', 'coA', 'A1', 'service_record', 'ma'),
       tests.mk_evidence('sr3', 'coA', 'A1', 'service_record', 'ma'), tests.mk_evidence('sr4', 'coA', 'A1', 'service_record', 'ma'),
       tests.mk_evidence('odo', 'coA', 'A1', 'odometer', 'ma'), tests.mk_evidence('srb', 'coB', 'B1', 'service_record', 'fab');

-- ================================================================ 1. company default (seeded per company)
select is((select count(*)::int from public.vehicle_service_configs where scope = 'company_default' and effective_to is null and company_id in (tests.id('coA'), tests.id('coB'))), 2, 'every company has exactly one open company default');
select is((select service_interval_km || '/' || early_tolerance_km || '/' || late_tolerance_km || '/' || coalesce(service_interval_days::text, 'null')
             from public.vehicle_service_configs where company_id = tests.id('coA') and scope = 'company_default'),
          '15000/1500/1500/null', 'default is 15,000 / 1,500 / 1,500 km with no time interval');
select is((select early_tolerance_days || '/' || late_tolerance_days from public.vehicle_service_configs
            where company_id = tests.id('coA') and scope = 'company_default' and early_tolerance_days is not null), null, 'time tolerances (DEC-11, Proposed) are not seeded');

-- ================================================================ 2. constraints
select is(tests.sqlstate_of($$insert into public.vehicle_service_configs (company_id, scope, service_interval_km, early_tolerance_km, late_tolerance_km, effective_from, reason)
  values (tests.id('coA'), 'company_default', 15000, 1500, 1500, now(), 'overlap')$$), '23P01', 'overlapping effective ranges for the same target are rejected (exclusion)');
select is(tests.sqlstate_of($$insert into public.vehicle_service_configs (company_id, scope, vehicle_id, service_interval_km, early_tolerance_km, late_tolerance_km, effective_from, reason)
  values (tests.id('coA'), 'company_default', tests.id('v-1'), 10000, 1000, 1000, '2999-01-01', 'bad scope target')$$), '23514', 'scope consistency: a company default cannot name a vehicle');
select is(tests.sqlstate_of($$insert into public.vehicle_service_configs (company_id, scope, service_interval_km, early_tolerance_km, late_tolerance_km, effective_from, reason)
  values (tests.id('coA'), 'category', 10000, 1000, 1000, '2999-01-01', 'category without a category')$$), '23514', 'scope consistency: a category scope needs a category');
select is(tests.sqlstate_of($$insert into public.vehicle_service_configs (company_id, scope, service_interval_km, early_tolerance_km, late_tolerance_km, effective_from, reason)
  values (tests.id('coA'), 'company_default', 10000, 10000, 1000, '2999-01-01', 'early = interval')$$), '23514', 'early tolerance must be below the interval');
select is(tests.sqlstate_of($$insert into public.vehicle_service_configs (company_id, scope, service_interval_km, early_tolerance_km, late_tolerance_km, effective_from, reason)
  values (tests.id('coA'), 'company_default', 0, 0, 0, '2999-01-01', 'zero interval')$$), '23514', 'interval km must be > 0');
select is(tests.sqlstate_of($$insert into public.vehicle_service_configs (company_id, scope, service_interval_km, early_tolerance_km, late_tolerance_km, service_interval_days, effective_from, reason)
  values (tests.id('coA'), 'company_default', 10000, 1000, 1000, 180, '2999-01-01', 'days without tolerances')$$), '23514', 'a time interval needs both tolerance days (never assumed)');
select is(tests.sqlstate_of($$insert into public.vehicle_service_configs (company_id, scope, service_interval_km, early_tolerance_km, late_tolerance_km, effective_from, effective_to, reason)
  values (tests.id('coA'), 'company_default', 10000, 1000, 1000, '2999-01-01', '2998-01-01', 'range backwards')$$), '23514', 'effective_to must be after effective_from');
select is(tests.sqlstate_of($$insert into public.vehicle_service_configs (company_id, scope, vehicle_id, service_interval_km, early_tolerance_km, late_tolerance_km, effective_from, reason, created_by, approved_by)
  values (tests.id('coA'), 'vehicle', tests.id('v-1'), 10000, 1000, 1000, '2999-01-01', 'no approval', tests.id('fa'), tests.id('fa2'))$$), '23514', 'an override row without its approval is refused (CHECK / trigger)');

-- ================================================================ 3. override needs service.config.manage + an approval (DEC-19, DEC-24)
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.request_service_config_override('category', null, null, null, 'bakkie', null, 12000, 1200, 1200, null, null, null, 'why', tests.id('cs-ma'))$$), '42501', 'maintenance admin (no service.config.manage) cannot request an override');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.request_service_config_override('category', null, null, null, 'bakkie', null, 12000, 1200, 1200, null, null, null, 'why', tests.id('cs-bm'))$$), '42501', 'branch manager cannot request an override');
select tests.act_as('fa');
select is(tests.sqlstate_of($$select public.request_service_config_override('company_default', null, null, null, null, null, 12000, 1200, 1200, null, null, null, 'why', tests.id('cs-cd'))$$), '22023', 'the company default is not an override');
select is(tests.sqlstate_of($$select public.request_service_config_override('category', null, null, null, 'bakkie', null, 12000, 1200, 1200, null, null, null, '   ', tests.id('cs-nr'))$$), '22023', 'a reason is required');
select is(tests.sqlstate_of($$select public.request_service_config_override('category', null, null, null, 'bakkie', null, 12000, 12000, 1200, null, null, null, 'bad', tests.id('cs-bad'))$$), '22023', 'invalid values are refused at request time');
select is(tests.sqlstate_of($$select public.request_service_config_override('vehicle', tests.id('v-b1'), null, null, null, null, 12000, 1200, 1200, null, null, null, 'other company', tests.id('cs-x'))$$), 'P0002', 'cannot target another company''s vehicle');
select lives_ok($$select public.request_service_config_override('category', null, null, null, 'bakkie', null, 12000, 1200, 1200, null, null, null, 'Bakkies are serviced earlier', tests.id('cs-cat'))$$, 'fleet admin requests a category override');
select is((select count(*)::int from public.vehicle_service_configs where scope = 'category'), 0, 'an override does not exist until approved');
select is(tests.cfg_scope('1', clock_timestamp()), 'company_default:15000', 'pending override does not apply (resolves to the default)');
select is((select public.request_service_config_override('category', null, null, null, 'bakkie', null, 12000, 1200, 1200, null, null, null, 'again', tests.id('cs-cat'))).id,
          (select id from public.approvals where client_submission_id = tests.id('cs-cat')), 'the same submission returns the same request (idempotent)');
select is(tests.sqlstate_of($$select public.request_service_config_override('category', null, null, null, 'BAKKIE', null, 9000, 900, 900, null, null, null, 'second', tests.id('cs-cat2'))$$), '55000', 'only one open request per target');
select is(tests.sqlstate_of($$select public.decide_approval((select id from public.approvals where client_submission_id = tests.id('cs-cat')), 'approved')$$), '42501', 'the requester cannot approve their own override (DEC-24)');
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.decide_approval((select id from public.approvals where client_submission_id = tests.id('cs-cat')), 'approved')$$), 'P0002', 'a user without access cannot even see the request');
select tests.act_as('fa2');
select lives_ok($$select public.decide_approval((select id from public.approvals where client_submission_id = tests.id('cs-cat')), 'approved')$$, 'a different service.config.manage holder approves it');
select tests.reset();
select is((select count(*)::int from public.vehicle_service_configs where scope = 'category' and effective_to is null), 1, 'approval creates the override row');
select is((select approved_by from public.vehicle_service_configs where scope = 'category'), tests.id('fa2'), 'the row records the approver');
select is((select created_by from public.vehicle_service_configs where scope = 'category'), tests.id('fa'), 'and the requester');
select is(tests.cfg_scope('1', now()), 'company_default:15000', 'effective-dated: before the approval the default still applies');
select is(tests.cfg_scope('1', clock_timestamp()), 'category:12000', 'effective-dated: after the approval the category override applies');

-- rejected requests never take effect
select tests.act_as('fa');
select public.request_service_config_override('make_model', null, 'Ford', 'Ranger', null, null, 8000, 800, 800, null, null, null, 'to be rejected', tests.id('cs-rej'));
select tests.decide('cs-rej', 'fa2', 'rejected');
select tests.reset();
select is((select count(*)::int from public.vehicle_service_configs where scope = 'make_model'), 0, 'a rejected override never takes effect');

-- ================================================================ 4. precedence at all four levels (DEC-19)
select tests.act_as('fa');
select public.request_service_config_override('make_model', null, 'TOYOTA', 'hilux', null, 'OEM schedule ref', 13000, 1300, 1300, null, null, null, 'Hilux schedule', tests.id('cs-mm'));
select tests.decide('cs-mm', 'fa2');
select tests.act_as('fa2');
select public.request_service_config_override('vehicle', tests.id('v-1'), null, null, null, null, 11000, 1100, 1100, null, null, null, 'this truck works hard', tests.id('cs-veh'));
select tests.decide('cs-veh', 'fa');
select tests.reset();
select is(tests.cfg_scope('3', clock_timestamp()), 'company_default:15000', 'level 4: company default (panel van)');
select is(tests.cfg_scope('2', clock_timestamp()), 'category:12000', 'level 3: category (Ford Ranger, bakkie)');
select is(tests.cfg_scope('7', clock_timestamp()), 'category:12000', 'level 3: category (Mazda bakkie)');
select is((select count(*)::int from public.resolve_service_config(tests.id('v-1'), clock_timestamp())), 1, 'resolution returns exactly one row');
select is(tests.cfg_scope('1', clock_timestamp()), 'vehicle:11000', 'level 1: vehicle beats make_model and category');
select tests.act_as('fa');
select public.request_service_config_override('make_model', null, 'Ford', 'Ranger', null, null, 8000, 800, 800, null, null, null, 'Ranger schedule', tests.id('cs-mm2'));
select tests.decide('cs-mm2', 'fa2');
select tests.reset();
select is(tests.cfg_scope('2', clock_timestamp()), 'make_model:8000', 'level 2: make_model beats category (case-insensitive match is used for Toyota/Hilux too)');
select is(tests.cfg_scope('1', now()), 'company_default:15000', 'an earlier point in time still resolves to the default');

-- change mid-cycle: a new approved override closes the open row and opens a new one; history is kept
select tests.act_as('fa');
select public.request_service_config_override('vehicle', tests.id('v-1'), null, null, null, null, 9000, 900, 900, null, null, null, 'tighter', tests.id('cs-veh2'));
select tests.decide('cs-veh2', 'fa2');
select tests.reset();
select is(tests.cfg_scope('1', clock_timestamp()), 'vehicle:9000', 'after the change the new vehicle config applies');
select is(tests.cfg_scope('1', (select effective_from - interval '1 millisecond' from public.vehicle_service_configs where scope = 'vehicle' and service_interval_km = 9000)), 'vehicle:11000', 'just before the change the old vehicle config applied');
select is((select count(*)::int from public.vehicle_service_configs where scope = 'vehicle' and vehicle_id = tests.id('v-1')), 2, 'history is kept: two rows for the vehicle');
select is((select count(*)::int from public.vehicle_service_configs where scope = 'vehicle' and effective_to is null), 1, 'exactly one is open');
select is(tests.sqlstate_of($$update public.vehicle_service_configs set service_interval_km = 1234 where scope = 'vehicle' and effective_to is null$$), '23514', 'a config is never edited in place');
select is(tests.sqlstate_of($$update public.vehicle_service_configs set effective_to = now() where scope = 'vehicle' and effective_to is not null$$), '55000', 'closed history cannot change');
select is(tests.sqlstate_of($$delete from public.vehicle_service_configs where scope = 'vehicle'$$), '42501', 'no hard deletes');
select throws_ok($$select * from public.resolve_service_config(gen_random_uuid(), now())$$, 'P0002', 'vehicle not found', 'unknown vehicle: clear error');
select throws_ok($$select * from public.resolve_service_config(tests.id('v-1'), null)$$, '22023', 'a point in time is required', 'null time: clear error');
select tests.act_as('bm1');
select is((select count(*)::int from public.resolve_service_config(tests.id('v-1'), clock_timestamp())), 1, 'a branch user can resolve for a vehicle of their branch');
select is(tests.sqlstate_of($$select * from public.resolve_service_config(tests.id('v-4'), now())$$), 'P0002', 'but not for another branch''s vehicle (cross-branch)');
select is(tests.sqlstate_of($$select * from public.resolve_service_config(tests.id('v-b1'), now())$$), 'P0002', 'nor another company''s (cross-company)');
select tests.act_as('fab');
select is(tests.sqlstate_of($$select * from public.resolve_service_config(tests.id('v-1'), now())$$), 'P0002', 'company B cannot resolve company A vehicles');
select is((select count(*)::int from public.vehicle_service_configs where company_id = tests.id('coA')), 0, 'company B sees none of company A''s configs');

-- company default: effective-dated direct change (service.config.manage, company-wide)
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.change_company_default_service_config(10000, 1000, 1000, null, null, null, null, 'x')$$), '42501', 'maintenance admin cannot change the company default');
select tests.act_as('fa');
select is(tests.sqlstate_of($$select public.change_company_default_service_config(15000, 1500, 1500, null, null, null, null, 'same values')$$), '55000', 'an unchanged default is refused');
select is(tests.sqlstate_of($$select public.change_company_default_service_config(10000, 1000, 1000, 180, null, null, null, 'days without tolerances')$$), '22023', 'time interval without tolerances refused');
select lives_ok($$select public.change_company_default_service_config(14000, 1400, 1400, 180, 20, 25, 'OEM-REF', 'Fleet policy review')$$, 'fleet admin changes the company default (time tolerances entered explicitly)');
select tests.reset();
select is(tests.cfg_scope('3', now()), 'company_default:15000', 'mid-cycle: before the change the old default applied');
select is(tests.cfg_scope('3', clock_timestamp()), 'company_default:14000', 'mid-cycle: after the change the new default applies');
select is((select early_tolerance_days || '/' || late_tolerance_days from public.vehicle_service_configs where company_id = tests.id('coA') and scope = 'company_default' and effective_to is null), '20/25', 'tolerance days stored as entered, not hard-coded');
select is((select count(*)::int from public.vehicle_service_configs where company_id = tests.id('coA') and scope = 'company_default'), 2, 'the old default row is kept as history');

-- ================================================================ 5. branch_transfer approvals still work (approval type dispatch kept)
select tests.act_as('fa');
select public.create_vehicle(tests.id('A1'), 'FL-T1', 'TRANSFER1', 'Toyota', 'Quantum', 'minibus');
select public.request_vehicle_transfer((select id from public.vehicles where registration_number = 'TRANSFER1'), tests.id('A2'), 'rebalancing', tests.id('cs-tr'));
select is((select current_branch_id from public.vehicles where registration_number = 'TRANSFER1'), tests.id('A1'), 'a transfer request moves nothing');
select tests.decide('cs-tr', 'fa2');
select tests.reset();
select is((select current_branch_id from public.vehicles where registration_number = 'TRANSFER1'), tests.id('A2'), 'branch_transfer approvals still work after the dispatch change (DEC-31)');
select is(public.approval_decide_permission('branch_transfer'), 'vehicle.transfer.approve', 'branch_transfer still needs vehicle.transfer.approve');
select is(public.approval_decide_permission('service_config_override'), 'service.config.manage', 'service_config_override needs service.config.manage');
select is(public.approval_decide_permission('something_else'), null, 'unknown types still fail closed');

-- ================================================================ 6. service records: baseline, verification, DEC-24
-- v-5: no record at all. v-6: recorded only. v-8: rejected only. v-2/v-3/v-7: verified.
select tests.act_as('ma');
select lives_ok($$select public.create_service_record(tests.id('v-6'), current_date - 20, 61000, 'Scheduled service', 'workshop', 'Synthetic Workshop', 'JC-1', 'INV-1', 100, 200, 300, null, tests.id('r6'))$$, 'maintenance admin records a service');
select is((select count(*)::int from public.service_records where vehicle_id = tests.id('v-6') and verification_status = 'recorded'), 1, 'it starts as recorded');
select is((select public.create_service_record(tests.id('v-6'), current_date - 20, 61000, 'Scheduled service', 'workshop', 'Synthetic Workshop', 'JC-1', 'INV-1', 100, 200, 300, null, tests.id('r6'))),
          (select id from public.service_records where vehicle_id = tests.id('v-6')), 'a repeated client_submission_id returns the same record (idempotent)');
select is((select count(*)::int from public.service_records where vehicle_id = tests.id('v-6')), 1, 'and creates no duplicate');
select is(tests.sqlstate_of($$select public.create_service_record(tests.id('v-6'), current_date + 1, 61000, 'Scheduled service', 'workshop', null, null, null, null, null, null, null, tests.id('rf'))$$), '22023', 'a future service date is refused');
select is(tests.sqlstate_of($$select public.create_service_record(tests.id('v-6'), current_date - 1, -5, 'Scheduled service', 'workshop', null, null, null, null, null, null, null, tests.id('rn'))$$), '22023', 'a negative odometer is refused');
select is(tests.sqlstate_of($$select public.create_service_record(tests.id('v-6'), current_date - 1, 1000, 'Scheduled service', 'historical_import', null, null, null, null, null, null, tests.id('ev-sr1'), tests.id('rh'))$$), '22023', 'historical_import is only created through the reviewed import path');
select is(tests.sqlstate_of($$select public.create_service_record(tests.id('v-6'), current_date - 1, 1000, 'Scheduled service', 'workshop', null, null, null, null, null, null, tests.id('ev-odo'), tests.id('rw'))$$), '23514', 'wrong-purpose evidence (odometer photo) is rejected');
select is(tests.sqlstate_of($$select public.create_service_record(tests.id('v-6'), current_date - 1, 1000, 'Scheduled service', 'workshop', null, null, null, null, null, null, tests.id('ev-srb'), tests.id('rc'))$$), '23514', 'evidence of another company is rejected');
select is(tests.sqlstate_of($$select public.create_service_record(tests.id('v-b1'), current_date - 1, 1000, 'Scheduled service', 'workshop', null, null, null, null, null, null, null, tests.id('rx'))$$), 'P0002', 'cross-company vehicle: not found');
select tests.act_as('ma_a2');
select is(tests.sqlstate_of($$select public.create_service_record(tests.id('v-6'), current_date - 1, 1000, 'Scheduled service', 'workshop', null, null, null, null, null, null, null, tests.id('rb'))$$), '42501', 'a branch-A2 maintenance admin cannot record for a branch-A1 vehicle (cross-branch)');
select is((select count(*)::int from public.service_records), 0, 'and cannot read branch-A1 records');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.create_service_record(tests.id('v-6'), current_date - 1, 1000, 'Scheduled service', 'workshop', null, null, null, null, null, null, null, tests.id('rbm'))$$), '42501', 'a branch manager holds no service.record.create');
select is((select count(*)::int from public.service_records), 0, 'and reads no raw service records');
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-6')), 'verified')$$), '42501', 'the creator cannot verify their own record (DEC-24)');
select is(tests.sqlstate_of($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-6')), 'rejected', 'my own mistake')$$), '42501', 'nor reject it');
select tests.reset();
select is(tests.sqlstate_of($$update public.service_records set verification_status = 'verified', verified_by = created_by, verified_at = now() where vehicle_id = tests.id('v-6')$$), '23514', 'verified_by <> created_by is a CHECK, not just a function rule');
select is(tests.sqlstate_of($$update public.service_records set verification_status = 'verified' where vehicle_id = tests.id('v-6')$$), '23514', 'verified needs verified_by and verified_at');
select is(tests.sqlstate_of($$insert into public.service_records (company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-6'), current_date - 3, 5000, 'Historical', 'historical_import', tests.id('h1'), tests.id('ma'))$$), '23514', 'historical_import without evidence is rejected (DEC-20)');
select is(tests.sqlstate_of($$insert into public.service_records (company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source, evidence_file_id, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-6'), current_date - 3, 5000, 'Historical', 'historical_import', tests.id('ev-odo'), tests.id('h2'), tests.id('ma'))$$), '23514', 'historical_import with wrong-purpose evidence is rejected');
select is(tests.sqlstate_of($$insert into public.service_records (company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source, evidence_file_id, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-6'), current_date - 3, 5000, 'Historical', 'historical_import', tests.id('ev-srb'), tests.id('h3'), tests.id('ma'))$$), '23514', 'historical_import with another company''s evidence is rejected');
select is(tests.sqlstate_of($$insert into public.service_records (company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source, client_submission_id, created_by, verification_status, verified_by, verified_at)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-6'), current_date - 3, 5000, 'Manual', 'manual', tests.id('h4'), tests.id('ma'), 'verified', tests.id('fa'), now())$$), '23514', 'a record cannot be created already verified');
select is(tests.sqlstate_of($$insert into public.service_records (company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A2'), tests.id('v-6'), current_date - 3, 5000, 'Manual', 'manual', tests.id('h5'), tests.id('ma'))$$), '23514', 'the record''s branch must be the vehicle''s branch');

-- v-8: rejected only
select tests.act_as('ma');
select public.create_service_record(tests.id('v-8'), current_date - 40, 30000, 'Scheduled service', 'manual', null, null, null, null, null, null, null, tests.id('r8'));
select tests.act_as('fa');
select is(tests.sqlstate_of($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-8')), 'rejected', '')$$), '22023', 'rejecting needs a reason');
select lives_ok($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-8')), 'rejected', 'Photo unreadable')$$, 'a different user rejects with a reason');
select tests.reset();
select is((select verification_status || '/' || rejected_by::text from public.service_records where vehicle_id = tests.id('v-8')), 'rejected/' || tests.id('fa')::text, 'rejection records its decider');
select is(tests.sqlstate_of($$update public.service_records set rejection_reason = 'edited' where vehicle_id = tests.id('v-8')$$), '55000', 'a rejected record cannot change');

-- verified baselines: v-2 at 82,400 (the PRD example), v-3 at 82,400 then late at 99,500
select tests.verified_record('2', current_date - 60, 82400, 'ma', 'fa', 'r2');
select tests.verified_record('3', current_date - 90, 82400, 'ma', 'ma2', 'r3a');
select tests.verified_record('3', current_date - 10, 99500, 'ma', 'ma2', 'r3b');
select tests.verified_record('7', current_date - 5, 50000, 'fa', 'ma', 'r7');

-- verified rows are immutable except through the audited reversal
select is(tests.sqlstate_of($$update public.service_records set actual_service_odometer_km = 1 where vehicle_id = tests.id('v-2')$$), '55000', 'verified: content cannot change');
select is(tests.sqlstate_of($$update public.service_records set verification_status = 'rejected', rejected_by = tests.id('fa'), rejected_at = now(), rejection_reason = 'x' where vehicle_id = tests.id('v-2')$$), '55000', 'verified: the status cannot be changed directly, even by the database owner');
select is(tests.sqlstate_of($$update public.service_records set verified_by = tests.id('ma') where vehicle_id = tests.id('v-2')$$), '55000', 'verified: the verifier cannot be swapped');
select is(tests.sqlstate_of($$delete from public.service_records where vehicle_id = tests.id('v-2')$$), '42501', 'no hard deletes');
select tests.act_as('fa');
select is(tests.sqlstate_of($$update public.service_records set service_type = 'x' where vehicle_id = tests.id('v-2')$$), '42501', 'clients have no UPDATE grant at all');
select is(tests.sqlstate_of($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-2')), 'verified')$$), '55000', 'a decided record cannot be decided again');
select tests.act_as('fab');
select is(tests.sqlstate_of($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-6')), 'verified')$$), 'P0002', 'company B cannot verify company A records (cross-company)');
select is((select count(*)::int from public.service_records), 0, 'company B reads none of them');
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-6')), 'verified')$$), 'P0002', 'a supervisor cannot see, so cannot verify');
select tests.act_as('ma_a2');
select is(tests.sqlstate_of($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-6')), 'verified')$$), 'P0002', 'a branch-A2 verifier cannot verify an A1 record (cross-branch)');

-- ================================================================ 7. vehicle_service_status
select tests.reset();
select ok((select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.vehicle_service_status'::regclass), 'vehicle_service_status is security_invoker');
select is((select array_agg(attname::text order by attnum) from pg_attribute where attrelid = 'public.vehicle_service_status'::regclass and attnum > 0),
  array['vehicle_id','service_config_id','service_config_scope','service_interval_km','early_tolerance_km','late_tolerance_km','service_interval_days','early_tolerance_days','late_tolerance_days','last_verified_service_record_id','last_verified_service_date','last_verified_service_odometer_km','next_service_odometer_km','early_warning_odometer_km','late_tolerance_odometer_km','service_due_date','early_warning_date','late_tolerance_date','baseline_required','awaiting_verification'],
  'the view exposes only the Phase 2 columns (no status bands, no current mileage)');
select tests.act_as('fa');
select is((select baseline_required::text || '/' || awaiting_verification::text from public.vehicle_service_status where vehicle_id = tests.id('v-5')), 'true/false', 'no record at all: Baseline required');
select is((select next_service_odometer_km from public.vehicle_service_status where vehicle_id = tests.id('v-5')), null, 'and no invented next-service value');
select is((select baseline_required::text || '/' || awaiting_verification::text from public.vehicle_service_status where vehicle_id = tests.id('v-6')), 'true/true', 'a recorded (unverified) record is not a baseline: Baseline required, awaiting verification');
select is((select baseline_required::text || '/' || awaiting_verification::text from public.vehicle_service_status where vehicle_id = tests.id('v-8')), 'true/false', 'a rejected record is not a baseline either');
select is((select last_verified_service_odometer_km from public.vehicle_service_status where vehicle_id = tests.id('v-6')), null, 'recorded rows never set the baseline odometer');
-- v-2 verified at 82,400 under the category override (12,000 / 1,200 / 1,200 applies today: ranger make_model is effective after txn start)
select is((select last_verified_service_odometer_km || '/' || baseline_required::text || '/' || awaiting_verification::text from public.vehicle_service_status where vehicle_id = tests.id('v-2')), '82400/false/false', 'v-2: verified baseline 82,400, nothing awaiting');
select tests.reset();
-- the configuration in effect for the current cycle: the 2C fixtures above are effective after this transaction started,
-- so the 82,400 example is shown with a dedicated vehicle and a plain default (no overrides, no time basis).
select tests.mk_vehicle('ex', 'coB', 'B1', 'Synthetic', 'Example', 'example');
insert into public.service_records (id, company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source, client_submission_id, created_by)
  values (tests.id('rec-ex'), tests.id('coB'), tests.id('B1'), tests.id('v-ex'), current_date - 30, 82400, 'Scheduled service', 'manual', tests.id('cs-ex'), tests.id('bootb'));
update public.service_records set verification_status = 'verified', verified_by = tests.id('fab'), verified_at = now() where id = tests.id('rec-ex');
select tests.act_as('fab');
select is((select early_warning_odometer_km || '/' || next_service_odometer_km || '/' || late_tolerance_odometer_km from public.vehicle_service_status where vehicle_id = tests.id('v-ex')), '95900/97400/98900', 'the PRD example: verified at 82,400 gives 95,900 / 97,400 / 98,900');
select is((select service_due_date from public.vehicle_service_status where vehicle_id = tests.id('v-ex')), null, 'no time interval configured: no due dates');
select tests.reset();
insert into public.service_records (id, company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source, client_submission_id, created_by)
  values (tests.id('rec-ex2'), tests.id('coB'), tests.id('B1'), tests.id('v-ex'), current_date - 1, 99500, 'Late service', 'manual', tests.id('cs-ex2'), tests.id('bootb'));
update public.service_records set verification_status = 'verified', verified_by = tests.id('fab'), verified_at = now() where id = tests.id('rec-ex2');
select tests.act_as('fab');
select is((select next_service_odometer_km || '/' || early_warning_odometer_km || '/' || late_tolerance_odometer_km from public.vehicle_service_status where vehicle_id = tests.id('v-ex')), '114500/113000/116000', 'a late service at 99,500 sets the next target at 114,500 (never rounded to a milestone)');
select is((select last_verified_service_odometer_km from public.vehicle_service_status where vehicle_id = tests.id('v-ex')), 99500, 'the baseline is the latest verified service');
select tests.reset();
-- a later recorded (unverified) service flags awaiting verification but never moves the baseline
insert into public.service_records (id, company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source, client_submission_id, created_by)
  values (tests.id('rec-ex3'), tests.id('coB'), tests.id('B1'), tests.id('v-ex'), current_date, 114000, 'Next service', 'manual', tests.id('cs-ex3'), tests.id('bootb'));
select tests.act_as('fab');
select is((select last_verified_service_odometer_km::text || '/' || next_service_odometer_km::text || '/' || awaiting_verification::text from public.vehicle_service_status where vehicle_id = tests.id('v-ex')), '99500/114500/true', 'a newer recorded service does not move the baseline; it is flagged awaiting verification');
-- effective-dated config change mid-cycle: the baseline stays, the interval follows the configuration in effect today
select tests.reset();
update public.vehicle_service_configs set effective_to = now() - interval '1 hour' where company_id = tests.id('coB') and scope = 'company_default' and effective_to is null;
insert into public.vehicle_service_configs (company_id, scope, service_interval_km, early_tolerance_km, late_tolerance_km, service_interval_days, early_tolerance_days, late_tolerance_days, effective_from, reason)
  values (tests.id('coB'), 'company_default', 10000, 1000, 1000, 180, 20, 25, now() - interval '1 hour', 'mid-cycle change (fixture)');
select tests.act_as('fab');
select is((select next_service_odometer_km || '/' || early_warning_odometer_km || '/' || late_tolerance_odometer_km from public.vehicle_service_status where vehicle_id = tests.id('v-ex')), '109500/108500/110500', 'mid-cycle change: same baseline, new interval and tolerances apply');
select is((select (service_due_date - last_verified_service_date)::text || '/' || (service_due_date - early_warning_date)::text || '/' || (late_tolerance_date - service_due_date)::text from public.vehicle_service_status where vehicle_id = tests.id('v-ex')), '180/20/25', 'due dates follow the configured days (never hard-coded)');
-- coA: v-2 / v-3 / v-7 baselines
select tests.act_as('fa');
select is((select baseline_required::text from public.vehicle_service_status where vehicle_id = tests.id('v-3')), 'false', 'v-3 has a verified baseline');
select is((select last_verified_service_odometer_km from public.vehicle_service_status where vehicle_id = tests.id('v-3')), 99500, 'v-3: the later verified service (99,500) is the baseline');
select is((select count(*)::int from public.vehicle_service_status where vehicle_id = tests.id('v-b1')), 0, 'cross-company: company A never sees company B vehicles');
select tests.act_as('bm1');
select is((select count(*)::int from public.vehicle_service_status where vehicle_id in (tests.id('v-1'), tests.id('v-2'))), 2, 'a branch manager reads the derived status for branch vehicles');
select is((select count(*)::int from public.vehicle_service_status where vehicle_id = tests.id('v-4')), 0, 'cross-branch: but not another branch''s vehicles');
select tests.act_anon();
select ok(tests.fails($$select count(*) from public.vehicle_service_status$$), 'anon cannot read the view');
select ok(tests.fails($$select * from public.vehicle_service_status_rows()$$), 'anon cannot call the status function');

-- ================================================================ 8. audited reversal of a verification
select tests.act_as('ma');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.reverse_service_verification((select id from public.service_records where vehicle_id = tests.id('v-2')), 'Wrong vehicle')$$), 'P0002', 'without service.record.verify the reversal is refused (record not visible)');
select tests.act_as('fa');
select is(tests.sqlstate_of($$select public.reverse_service_verification((select id from public.service_records where vehicle_id = tests.id('v-2')), '')$$), '22023', 'a reason is required to reverse');
select is(tests.sqlstate_of($$select public.reverse_service_verification((select id from public.service_records where vehicle_id = tests.id('v-6')), 'not verified')$$), '55000', 'only a verified record can be reversed');
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.reverse_service_verification((select id from public.service_records where vehicle_id = tests.id('v-6')), 'my own record')$$), '42501', 'the creator cannot reverse a verification of their own record (DEC-24)');
select lives_ok($$select public.reverse_service_verification((select id from public.service_records where vehicle_id = tests.id('v-7')), 'Photo shows another vehicle')$$, 'a service.record.verify holder who is not the creator reverses with a reason');
select tests.reset();
select is((select verification_status from public.service_records where vehicle_id = tests.id('v-7')), 'rejected', 'the reversed record is no longer verified');
select is((select verified_by from public.service_records where vehicle_id = tests.id('v-7')), tests.id('ma'), 'it keeps who verified it, as history');
select is((select count(*)::int from public.audit_logs where entity_type = 'service_records' and entity_id = (select id from public.service_records where vehicle_id = tests.id('v-7'))
            and action = 'update' and reason like 'service record verification reversed: Photo shows another vehicle'), 1, 'the reversal is audited with its reason');
select tests.act_as('fa');
select is((select baseline_required::text from public.vehicle_service_status where vehicle_id = tests.id('v-7')), 'true', 'after reversal the vehicle is Baseline required again');
select tests.act_as('ma2');
select is(tests.sqlstate_of($$select public.reverse_service_verification((select id from public.service_records where vehicle_id = tests.id('v-7')), 'again')$$), '55000', 'a reversed record cannot be reversed twice');
select tests.reset();
select is(tests.sqlstate_of($$update public.service_records set verification_status = 'verified', verified_by = tests.id('fa'), verified_at = now() where vehicle_id = tests.id('v-7')$$), '55000', 'a rejected (reversed) record cannot be re-verified');

-- ================================================================ 9. baseline import (DEC-20)
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.stage_service_import('x.csv', '[{"registration_number":"REG1"}]'::jsonb, tests.id('imp-bm'))$$), '42501', 'staging needs service.record.create');
select tests.act_as('ma_a2');
select public.stage_service_import('a2.csv', jsonb_build_array(jsonb_build_object('registration_number', 'reg1', 'service_date', to_char(current_date - 5, 'YYYY-MM-DD'), 'odometer_km', '1000', 'service_type', 'Service')), tests.id('imp-a2'));
select is((select errors from public.service_import_rows where batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-a2'))), array['unknown_vehicle'], 'a vehicle of another branch is reported as unknown (cross-branch, no existence leak)');
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.stage_service_import('empty.csv', '[]'::jsonb, tests.id('imp-e'))$$), '22023', 'an empty import is refused');
select is(tests.sqlstate_of($$select public.stage_service_import('big.csv', (select jsonb_agg('{}'::jsonb) from generate_series(1, 501)), tests.id('imp-big'))$$), '22023', 'more than 500 rows is refused');
select lives_ok($$select public.stage_service_import('go-live.csv', jsonb_build_array(
  jsonb_build_object('registration_number', 'reg1', 'service_date', to_char(current_date - 30, 'YYYY-MM-DD'), 'odometer_km', '45000', 'service_type', 'Scheduled service', 'supplier_name', 'Synthetic Workshop', 'invoice_reference', 'INV-77'),
  jsonb_build_object('registration_number', 'REG-NOPE', 'service_date', to_char(current_date - 30, 'YYYY-MM-DD'), 'odometer_km', '1', 'service_type', 'Service'),
  jsonb_build_object('registration_number', 'REG5', 'service_date', '2026-02-30', 'odometer_km', '1', 'service_type', 'Service'),
  jsonb_build_object('registration_number', 'REG5', 'service_date', '31/01/2026', 'odometer_km', '1', 'service_type', 'Service'),
  jsonb_build_object('registration_number', 'REG5', 'service_date', to_char(current_date + 3, 'YYYY-MM-DD'), 'odometer_km', '1', 'service_type', 'Service'),
  jsonb_build_object('registration_number', 'REG5', 'service_date', to_char(current_date - 30, 'YYYY-MM-DD'), 'odometer_km', '12,000', 'service_type', 'Service'),
  jsonb_build_object('registration_number', 'REG5', 'service_date', to_char(current_date - 30, 'YYYY-MM-DD'), 'odometer_km', '-5', 'service_type', 'Service'),
  jsonb_build_object('registration_number', 'REG5', 'service_date', to_char(current_date - 30, 'YYYY-MM-DD'), 'odometer_km', '1.5', 'service_type', 'Service'),
  jsonb_build_object('registration_number', 'REG5', 'service_date', to_char(current_date - 30, 'YYYY-MM-DD'), 'odometer_km', '99999999999', 'service_type', 'Service'),
  jsonb_build_object('registration_number', 'reg1', 'service_date', to_char(current_date - 30, 'YYYY-MM-DD'), 'odometer_km', '45000', 'service_type', 'Scheduled service'),
  jsonb_build_object('registration_number', 'REG6', 'service_date', to_char(current_date - 20, 'YYYY-MM-DD'), 'odometer_km', '61000', 'service_type', 'Scheduled service'),
  jsonb_build_object('registration_number', 'REGB1', 'service_date', to_char(current_date - 30, 'YYYY-MM-DD'), 'odometer_km', '5', 'service_type', 'Service'),
  jsonb_build_object('registration_number', 'REG5', 'service_date', to_char(current_date - 30, 'YYYY-MM-DD'), 'odometer_km', '2500'),
  jsonb_build_object('odometer_km', '2500')), tests.id('imp-1'))$$, 'importer stages a CSV');
select is((select count(*)::int from public.service_import_rows where batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))), 14, 'every uploaded row is staged');
select is((select array_agg(errors::text order by row_number) from public.service_import_rows where batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1')) and row_number between 2 and 9 or row_number between 10 and 14 and batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))),
          array['{unknown_vehicle}', '{invalid_date}', '{invalid_date}', '{future_date}', '{invalid_odometer}', '{invalid_odometer}', '{invalid_odometer}', '{invalid_odometer}',
                '{duplicate_in_file}', '{duplicate_existing}', '{unknown_vehicle}', '{missing_service_type}', '{missing_registration,invalid_date,missing_service_type}'],
          'the validation report names unknown vehicles, bad dates, bad odometers and duplicates');
select is((select row_status from public.service_import_rows where batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1')) and row_number = 1), 'valid', 'a clean row is valid');
select is((select public.stage_service_import('go-live.csv', '[{"registration_number":"x"}]'::jsonb, tests.id('imp-1'))), (select id from public.service_import_batches where client_submission_id = tests.id('imp-1')), 'staging is idempotent on client_submission_id');
select is((select count(*)::int from public.service_records where vehicle_id = tests.id('v-1') and source = 'historical_import'), 0, 'staging creates no service records');
select is(tests.sqlstate_of($$update public.service_import_rows set errors = '{}' where row_number = 2$$), '42501', 'clients cannot edit staging rows');

-- attach evidence: valid row -> recorded historical_import
select is(tests.sqlstate_of($$select public.attach_import_row_evidence((select id from public.service_import_rows where row_number = 2 and batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))), tests.id('ev-sr1'), tests.id('att-bad'))$$), '55000', 'an invalid row cannot be imported');
select is(tests.sqlstate_of($$select public.attach_import_row_evidence((select id from public.service_import_rows where row_number = 1 and batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))), null, tests.id('att-0'))$$), '22023', 'no evidence, no historical record (DEC-20)');
select is(tests.sqlstate_of($$select public.attach_import_row_evidence((select id from public.service_import_rows where row_number = 1 and batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))), tests.id('ev-odo'), tests.id('att-w'))$$), '23514', 'wrong-purpose evidence is refused');
select public.attach_import_row_evidence((select id from public.service_import_rows where row_number = 1 and batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))), tests.id('ev-sr2'), tests.id('att-1'));
select is((select verification_status || '/' || source from public.service_records where vehicle_id = tests.id('v-1') and source = 'historical_import'), 'recorded/historical_import', 'a valid row with evidence becomes a recorded historical_import record');
select is((select public.attach_import_row_evidence((select id from public.service_import_rows where row_number = 1 and batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))), tests.id('ev-sr2'), tests.id('att-1'))),
          (select service_record_id from public.service_import_rows where row_number = 1 and batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))), 'a retry returns the same record (idempotent)');
select is((select row_status from public.service_import_rows where row_number = 1 and batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))), 'imported', 'the row is marked imported');
select tests.act_as('bm1');
select is((select count(*)::int from public.service_import_rows), 0, 'a staff member without a company-wide verify grant does not see the importer''s staging');
select tests.act_as('ma2');
select is(tests.sqlstate_of($$select public.attach_import_row_evidence((select id from public.service_import_rows limit 1), tests.id('ev-sr3'), tests.id('att-o'))$$), 'P0002', 'only the importer attaches evidence');
select tests.act_as('fa');
select is((select count(*)::int from public.service_import_rows where batch_id = (select id from public.service_import_batches where client_submission_id = tests.id('imp-1'))), 14, 'a verifier with a company-wide grant can review the batch');
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-1') and source = 'historical_import'), 'verified')$$), '42501', 'the importer cannot verify their own import (DEC-24)');
select is((select baseline_required::text || '/' || awaiting_verification::text from public.vehicle_service_status where vehicle_id = tests.id('v-1')), 'true/true', 'until verified the vehicle still shows Baseline required');
select tests.act_as('ma2');
select lives_ok($$select public.verify_service_record((select id from public.service_records where vehicle_id = tests.id('v-1') and source = 'historical_import'), 'verified')$$, 'a different maintenance administrator verifies it separately');
select is((select baseline_required::text || '/' || last_verified_service_odometer_km::text from public.vehicle_service_status where vehicle_id = tests.id('v-1')), 'false/45000', 'only now is the baseline set');
select is((select next_service_odometer_km from public.vehicle_service_status where vehicle_id = tests.id('v-1')), 60000, 'next = 45,000 + interval (configs approved inside this transaction take effect after now(), so the default 15,000 still applies here)');
select tests.reset();
select is(tests.sqlstate_of($$insert into public.service_records (company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km, service_type, source, evidence_file_id, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-5'), current_date - 3, 5000, 'Historical', 'historical_import', tests.id('ev-sr2'), tests.id('h6'), tests.id('ma'))$$), '23505', 'one evidence photo belongs to one record');

-- ================================================================ 10. audit, privileges, RLS
select cmp_ok((select count(*)::int from public.audit_logs where entity_type = 'vehicle_service_configs'), '>=', 6, 'configuration changes are audited');
select cmp_ok((select count(*)::int from public.audit_logs where entity_type = 'service_records' and action = 'insert'), '>=', 4, 'service record inserts are audited');
select cmp_ok((select count(*)::int from public.audit_logs where entity_type = 'service_records' and action = 'update' and reason is not null), '>=', 3, 'verification decisions are audited with a reason');
select cmp_ok((select count(*)::int from public.audit_logs where entity_type in ('service_import_batches', 'service_import_rows')), '>=', 15, 'imports are audited');
select cmp_ok((select count(*)::int from public.audit_logs where entity_type = 'approvals' and after_values ->> 'approval_type' = 'service_config_override'), '>=', 4, 'override approvals are audited');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.vehicle_service_configs'::regclass, 'public.service_records'::regclass, 'public.service_import_batches'::regclass, 'public.service_import_rows'::regclass)), 'RLS is enabled on every new table');
select ok(not has_table_privilege('authenticated', 'public.service_records', 'insert')
      and not has_table_privilege('authenticated', 'public.service_records', 'update')
      and not has_table_privilege('authenticated', 'public.service_records', 'delete')
      and not has_table_privilege('authenticated', 'public.vehicle_service_configs', 'insert')
      and not has_table_privilege('authenticated', 'public.vehicle_service_configs', 'update')
      and not has_table_privilege('authenticated', 'public.service_import_rows', 'insert')
      and not has_table_privilege('anon', 'public.service_records', 'select'), 'no client write grants and nothing for anon');
select ok(not has_function_privilege('anon', 'public.create_service_record(uuid, date, integer, text, text, text, text, text, numeric, numeric, numeric, uuid, uuid)', 'execute')
      and not has_function_privilege('anon', 'public.verify_service_record(uuid, text, text)', 'execute')
      and not has_function_privilege('anon', 'public.resolve_service_config(uuid, timestamptz)', 'execute')
      and not has_function_privilege('anon', 'public.stage_service_import(text, jsonb, uuid)', 'execute')
      and not has_function_privilege('anon', 'public.vehicle_service_status_rows()', 'execute'), 'anon cannot execute the public 2C functions');
select ok(not has_function_privilege('authenticated', 'public.service_config_lookup(uuid, timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'public.apply_service_config_override(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.service_record_insert(uuid, uuid, uuid, date, integer, text, text, text, text, text, numeric, numeric, numeric, uuid, uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.service_config_validate(text, uuid, text, text, text, integer, integer, integer, integer, integer, integer)', 'execute'), 'internal 2C functions are not callable by clients');
select ok((select bool_and(not has_function_privilege(r, p.oid, 'execute'))
             from pg_proc p, unnest(array['public', 'anon', 'authenticated']) r
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('vsc_guard', 'seed_company_service_config', 'service_records_guard', 'service_records_validate', 'service_import_rows_guard')), 'new trigger functions are granted to nobody');
select tests.act_as('fa');
select is(tests.sqlstate_of($$select public.apply_service_config_override((select id from public.approvals limit 1))$$), '42501', 'apply_service_config_override cannot be called directly');

select finish();
rollback;
