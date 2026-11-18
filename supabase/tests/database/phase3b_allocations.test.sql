-- Slice 3B pgTAP: vehicle allocations — creation, overlap, eligibility (migrations 028-030; DB v1.7 §4, §5, §17, §20, §21;
-- PRD v1.12 §4.2, §5.4, §5.5; DEC-01, DEC-02, DEC-22, DEC-23, DEC-24). Synthetic data only; everything rolls back.
-- Dates are relative to today (so the "ends in the future" guards stay meaningful): tests.d(0) = today + 20 days, local.
begin;
create extension if not exists pgtap with schema extensions;
select plan(235);

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
create function tests.mk_driver(n text, comp text, emp text, branch text) returns void language sql as $$
  select tests.mk_user(n, comp, 'driver');
  insert into public.drivers (id, company_id, profile_id, employee_number, branch_id)
  values (tests.id('d-' || n), tests.id(comp), tests.id(n), emp, tests.id(branch));
  select tests.grant_role(n, 'driver', branch, case when comp = 'coB' then 'bootb' else 'boot' end);
$$;
create table tests.kv (k text primary key, v uuid);
grant select, insert on tests.kv to public;
create function tests.k(key text) returns uuid language sql stable as $$ select v from tests.kv where k = key $$;
create function tests.d(n integer) returns date language sql stable as $$
  select (now() at time zone 'Africa/Johannesburg')::date + 20 + n $$;
create function tests.ts(d date, t text) returns timestamptz language sql immutable as $$
  select (d + t::time) at time zone 'Africa/Johannesburg' $$;
create function tests.mk_shift(label text, branch text, d date, t_start time, t_end time, st text default 'scheduled') returns void language sql as $$
  insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by,
                             status, cancel_reason, cancelled_by, cancelled_at)
  select tests.id('sh-' || label), b.company_id, b.id, d, tm.scheduled_start_at, tm.scheduled_end_at, gen_random_uuid(), case when b.company_id = tests.id('coB') then tests.id('bootb') else tests.id('boot') end, st,
         case when st = 'cancelled' then 'fixture' end, case when st = 'cancelled' then tests.id('boot') end, case when st = 'cancelled' then now() end
    from public.branches b, public.shift_times(d, t_start, t_end) tm where b.id = tests.id(branch);
$$;
create function tests.mk_vehicle(label text, comp text, branch text, code text default null, adm text default 'available') returns void language sql as $$
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category,
                               administrative_status, required_licence_code)
  values (tests.id('v-' || label), tests.id(comp), tests.id(branch), 'FL-' || label, upper('T3B' || label), 'Make', 'Model', 'bakkie', adm, code);
$$;
create function tests.mk_licence(drv text, code text, expiry date, verified boolean default true, prdp date default null) returns void language sql as $$
  insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, prdp_required, prdp_expiry_date,
                                      verification_status, client_submission_id, created_by, verified_by, verified_at)
  select d.company_id, d.id, 'SYN-' || drv || '-' || code || '-' || expiry::text, code, expiry - 3000, expiry, prdp is not null, prdp,
         case when verified then 'verified' else 'recorded' end, gen_random_uuid(), case when d.company_id = tests.id('coB') then tests.id('bootb') else tests.id('fa') end,
         case when verified then case when d.company_id = tests.id('coB') then tests.id('fab') else tests.id('bm1') end end, case when verified then now() end
    from public.drivers d where d.id = tests.id('d-' || drv);
$$;
-- a fixture allocation inserted directly (superuser), bypassing the functions
create function tests.mk_alloc(label text, shift text, veh text, drv text, s timestamptz, e timestamptz, st text default 'planned') returns void language sql as $$
  insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, status,
                                          licence_class_check, client_submission_id, created_by)
  select tests.id('al-' || label), sh.company_id, sh.branch_id, tests.id('v-' || veh), tests.id('d-' || drv), sh.id, s, e, st, 'matched', gen_random_uuid(), tests.id('fa')
    from public.shifts sh where sh.id = tests.id('sh-' || shift);
$$;
create function tests.audit_n(tbl text, act text) returns integer language sql as $$
  select count(*)::int from public.audit_logs where entity_type = tbl and action = act and company_id in (tests.id('coA'), tests.id('coB')) $$;

-- ---------------------------------------------------------------- fixtures (synthetic)
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB');
select tests.mk_user('fa', 'coA'), tests.mk_user('fa2', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'), tests.mk_user('bm1', 'coA'),
       tests.mk_user('bm1b', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('fab', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('fa2', 'fleet_admin', null, 'boot'),
       tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sup2', 'supervisor', 'A2', 'boot'),
       tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'), tests.grant_role('bm1b', 'branch_manager', 'A1', 'boot'),
       tests.grant_role('ma', 'maintenance_admin', null, 'boot'), tests.grant_role('sm', 'senior_management', null, 'boot'),
       tests.grant_role('sa', 'system_admin', null, 'boot'), tests.grant_role('fab', 'fleet_admin', null, 'bootb');
-- drivers at A1: B licence, EC1 licence, B (second), none, unverified, expiring, PrDP expired, PrDP ok; plus A2 and company B
select tests.mk_driver('dB', 'coA', 'E01', 'A1'), tests.mk_driver('dEC1', 'coA', 'E02', 'A1'), tests.mk_driver('dB2', 'coA', 'E03', 'A1'),
       tests.mk_driver('dNone', 'coA', 'E04', 'A1'), tests.mk_driver('dUnv', 'coA', 'E05', 'A1'), tests.mk_driver('dExp', 'coA', 'E06', 'A1'),
       tests.mk_driver('dPrdpBad', 'coA', 'E07', 'A1'), tests.mk_driver('dPrdpOk', 'coA', 'E08', 'A1'), tests.mk_driver('dRej', 'coA', 'E09', 'A1'),
       tests.mk_driver('dA2', 'coA', 'E10', 'A2'), tests.mk_driver('dCoB', 'coB', 'E01', 'B1'),
       tests.mk_driver('sd', 'coA', 'E11', 'A1'), tests.mk_driver('dOther', 'coA', 'E12', 'A1');
select tests.grant_role('sd', 'supervisor', 'A1', 'boot');            -- a supervisor who is also a driver (DEC-24)
select tests.mk_licence('dB', 'B', tests.d(400)), tests.mk_licence('dEC1', 'EC1', tests.d(400)), tests.mk_licence('dB2', 'B', tests.d(400)),
       tests.mk_licence('dUnv', 'B', tests.d(400), false), tests.mk_licence('dExp', 'B', tests.d(0)),
       tests.mk_licence('dPrdpBad', 'B', tests.d(400), true, tests.d(-1)), tests.mk_licence('dPrdpOk', 'B', tests.d(400), true, tests.d(0)),
       tests.mk_licence('sd', 'B', tests.d(400)), tests.mk_licence('dA2', 'B', tests.d(400)), tests.mk_licence('dCoB', 'B', tests.d(400)),
       tests.mk_licence('dOther', 'B', tests.d(400));
insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, verification_status,
                                    client_submission_id, created_by, verified_by, verified_at)
values (tests.id('coA'), tests.id('d-dRej'), 'SYN-REJ', 'B', tests.d(0) - 3000, tests.d(400), 'rejected', gen_random_uuid(), tests.id('fa'), tests.id('bm1'), now());
-- vehicles at A1
select tests.mk_vehicle('vB', 'coA', 'A1', 'B'), tests.mk_vehicle('vB2', 'coA', 'A1', 'B'), tests.mk_vehicle('vB3', 'coA', 'A1', 'B'),
       tests.mk_vehicle('vC1', 'coA', 'A1', 'C1'), tests.mk_vehicle('vC1b', 'coA', 'A1', 'C1'), tests.mk_vehicle('vC1c', 'coA', 'A1', 'C1'),
       tests.mk_vehicle('vNone', 'coA', 'A1', null), tests.mk_vehicle('vMaint', 'coA', 'A1', 'B', 'in_maintenance'),
       tests.mk_vehicle('vOut', 'coA', 'A1', 'B', 'out_of_service'), tests.mk_vehicle('vRet', 'coA', 'A1', 'B', 'retired'),
       tests.mk_vehicle('vA2', 'coA', 'A2', 'B'), tests.mk_vehicle('vCoB', 'coB', 'B1', 'B'), tests.mk_vehicle('vArch', 'coA', 'A1', 'B'),
       tests.mk_vehicle('vT', 'coA', 'A1', 'B'), tests.mk_vehicle('vP', 'coA', 'A1', 'B'), tests.mk_vehicle('vQ', 'coA', 'A1', 'B'),
       tests.mk_vehicle('o1', 'coA', 'A1', 'B'), tests.mk_vehicle('o2', 'coA', 'A1', 'B'), tests.mk_vehicle('o3', 'coA', 'A1', 'B'),
       tests.mk_vehicle('vR', 'coA', 'A1', 'B'), tests.mk_vehicle('vS', 'coA', 'A1', 'B');
update public.vehicles set archived_at = now() where id = tests.id('v-vArch');
insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, created_by)
values (tests.id('coA'), tests.id('v-vT'), tests.id('A1'), now() - interval '1 day', tests.id('fa'));
-- shifts: day / next-day / night at A1 (all future), a cancelled one, other branch, other company, and shifts for the overlap tests
select tests.mk_shift('day', 'A1', tests.d(0), '06:00', '18:00'), tests.mk_shift('day2', 'A1', tests.d(1), '06:00', '18:00'),
       tests.mk_shift('night', 'A1', tests.d(0), '18:00', '06:00'), tests.mk_shift('cancelled', 'A1', tests.d(2), '06:00', '18:00', 'cancelled'),
       tests.mk_shift('a2', 'A2', tests.d(0), '06:00', '18:00'), tests.mk_shift('cob', 'B1', tests.d(0), '06:00', '18:00'),
       tests.mk_shift('ov', 'A1', tests.d(10), '06:00', '18:00'), tests.mk_shift('ov2', 'A1', tests.d(11), '06:00', '18:00'),
       tests.mk_shift('cx', 'A1', tests.d(12), '06:00', '18:00'), tests.mk_shift('cx2', 'A1', tests.d(13), '06:00', '18:00'),
       tests.mk_shift('tr', 'A1', tests.d(14), '06:00', '18:00'), tests.mk_shift('dr', 'A1', tests.d(15), '06:00', '18:00'),
       tests.mk_shift('ovr', 'A1', tests.d(16), '06:00', '18:00'), tests.mk_shift('perm', 'A1', tests.d(17), '06:00', '18:00'),
       tests.mk_shift('conf', 'A1', tests.d(18), '06:00', '18:00');

-- ================================================================ 1. table rules (inserted directly as the owner)
select tests.mk_alloc('base', 'ov', 'o1', 'dB', tests.ts(tests.d(10), '06:00'), tests.ts(tests.d(10), '12:00'));
select is((select status || '/' || allocation_type || '/' || licence_class_check from public.vehicle_allocations where id = tests.id('al-base')),
          'planned/standard/matched', 'defaults: planned, standard');
select is((select active_period from public.vehicle_allocations where id = tests.id('al-base')),
          tstzrange(tests.ts(tests.d(10), '06:00'), tests.ts(tests.d(10), '12:00'), '[)'), 'active_period is the generated [planned_start, planned_end) range');
select is(tests.sqlstate_of($$select tests.mk_alloc('bad1', 'ov', 'o2', 'dB2', tests.ts(tests.d(10), '12:00'), tests.ts(tests.d(10), '12:00'))$$), '23514', 'planned_end must be after planned_start');
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
  licence_class_check, licence_override_approval_id, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-o2'), tests.id('d-dB2'), tests.id('sh-ov'), tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'),
          'override_approved', null, gen_random_uuid(), tests.id('fa'))$$), '23514', 'override_approved needs an approval id');
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
  licence_class_check, licence_override_approval_id, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-o2'), tests.id('d-dB2'), tests.id('sh-ov'), tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'),
          'matched', gen_random_uuid(), gen_random_uuid(), tests.id('fa'))$$), '23514', 'an approval id is only allowed with override_approved');
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
  licence_class_check, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-o2'), tests.id('d-dB2'), tests.id('sh-ov'), tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'),
          'verified', gen_random_uuid(), tests.id('fa'))$$), '23514', 'licence_class_check is matched | override_approved | not_configured');
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
  licence_class_check, status, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-o2'), tests.id('d-dB2'), tests.id('sh-ov'), tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'),
          'matched', 'finished', gen_random_uuid(), tests.id('fa'))$$), '23514', 'status is one of the eight DB §20 values');
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
  licence_class_check, allocation_type, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-o2'), tests.id('d-dB2'), tests.id('sh-ov'), tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'),
          'matched', 'handover', gen_random_uuid(), tests.id('fa'))$$), '23514', 'allocation_type is standard | handover_segment (DEC-02)');
select ok(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
  licence_class_check, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A2'), tests.id('v-vA2'), tests.id('d-dA2'), tests.id('sh-ov'), tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'),
          'matched', gen_random_uuid(), tests.id('fa'))$$) in ('23503', '23514'), 'the shift must be in the allocation''s branch (trigger, or the composite FK)');
select ok(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
  licence_class_check, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-vCoB'), tests.id('d-dB2'), tests.id('sh-ov'), tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'),
          'matched', gen_random_uuid(), tests.id('fa'))$$) in ('23503', '23514'), 'a vehicle of another company is refused (trigger, or the composite FK)');
select is(tests.sqlstate_of($$select tests.mk_alloc('bad2', 'ov', 'vA2', 'dB2', tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'))$$), '23514',
          'trigger: the vehicle must be at the allocation''s branch');
select is(tests.sqlstate_of($$select tests.mk_alloc('bad3', 'ov', 'o2', 'dA2', tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'))$$), '23514',
          'trigger: the driver must be at the allocation''s branch');
select is(tests.sqlstate_of($$select tests.mk_alloc('bad4', 'cancelled', 'o2', 'dB2', tests.ts(tests.d(2), '07:00'), tests.ts(tests.d(2), '08:00'))$$), '23514',
          'trigger: the shift must be scheduled');
select is(tests.sqlstate_of($$select tests.mk_alloc('bad5', 'ov', 'vArch', 'dB2', tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'))$$), '23514',
          'trigger: an archived vehicle cannot be allocated');
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
  licence_class_check, client_submission_id, created_by)
  select company_id, branch_id, tests.id('v-o2'), tests.id('d-dB2'), shift_id, tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'), 'matched',
         client_submission_id, created_by from public.vehicle_allocations where id = tests.id('al-base')$$), '23505',
          'idempotency: (company, created_by, client_submission_id) is unique');
select ok(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, released_at,
  licence_class_check, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-o2'), tests.id('d-dB2'), tests.id('sh-ov'), tests.ts(tests.d(10), '13:00'), tests.ts(tests.d(10), '14:00'),
          tests.ts(tests.d(10), '12:00'), 'matched', gen_random_uuid(), tests.id('fa'))$$) in ('23514', '22000'), 'released_at cannot be before planned_start_at');

-- ================================================================ 2. overlap rules (DEC-01): vehicle AND driver
select is(tests.sqlstate_of($$select tests.mk_alloc('ov-v', 'ov', 'o1', 'dB2', tests.ts(tests.d(10), '11:00'), tests.ts(tests.d(10), '14:00'))$$), '23P01',
          'same vehicle, overlapping period: refused by the exclusion constraint');
select is(tests.sqlstate_of($$select tests.mk_alloc('ov-d', 'ov', 'o2', 'dB', tests.ts(tests.d(10), '11:00'), tests.ts(tests.d(10), '14:00'))$$), '23P01',
          'same driver, overlapping period, different vehicle: refused (DEC-01: one vehicle at a time)');
select is(tests.sqlstate_of($$select tests.mk_alloc('b2b', 'ov', 'o1', 'dB', tests.ts(tests.d(10), '12:00'), tests.ts(tests.d(10), '15:00'))$$), null,
          'back-to-back ranges are allowed: [06:00,12:00) then [12:00,15:00) for the same vehicle and driver');
select is(tests.sqlstate_of($$select tests.mk_alloc('two-veh', 'ov', 'o2', 'dB', tests.ts(tests.d(10), '15:00'), tests.ts(tests.d(10), '17:00'))$$), null,
          'a driver may use a second vehicle in the same shift, one at a time (DEC-01)');
select is(tests.sqlstate_of($$select tests.mk_alloc('other-shift', 'ov2', 'o1', 'dB', tests.ts(tests.d(11), '06:00'), tests.ts(tests.d(11), '07:00'))$$), null,
          'a different period does not conflict');
-- cancelled / no_show do not block, and do not count as blocked themselves
select tests.mk_alloc('cx1', 'cx', 'o3', 'dB2', tests.ts(tests.d(12), '06:00'), tests.ts(tests.d(12), '12:00'), 'cancelled');
select tests.mk_alloc('cx2', 'cx', 'o3', 'dB2', tests.ts(tests.d(12), '06:00'), tests.ts(tests.d(12), '12:00'), 'no_show');
select is(tests.sqlstate_of($$select tests.mk_alloc('cx3', 'cx', 'o3', 'dB2', tests.ts(tests.d(12), '08:00'), tests.ts(tests.d(12), '10:00'))$$), null,
          'cancelled and no_show rows do not block a new allocation for the same vehicle and driver');
select is(tests.sqlstate_of($$select tests.mk_alloc('cx4', 'cx', 'o3', 'dB2', tests.ts(tests.d(12), '09:00'), tests.ts(tests.d(12), '11:00'))$$), '23P01',
          'the new live allocation blocks the next one');
select is(tests.sqlstate_of($$select tests.mk_alloc('cx5', 'cx', 'o3', 'dB2', tests.ts(tests.d(12), '07:00'), tests.ts(tests.d(12), '08:00'), 'cancelled')$$), null,
          'a cancelled row can overlap a live one');
select is(tests.sqlstate_of($$select tests.mk_alloc('cx6', 'cx2', 'o3', 'dOther', tests.ts(tests.d(13), '07:00'), tests.ts(tests.d(13), '11:00'), 'closed')$$), null, 'a closed allocation is stored (fixture)');
select is(tests.sqlstate_of($$select tests.mk_alloc('cx7', 'cx2', 'o3', 'dOther', tests.ts(tests.d(13), '08:00'), tests.ts(tests.d(13), '09:00'), 'closed_with_exceptions')$$), '23P01',
          'closed allocations still block overlaps (only cancelled and no_show are excluded)');
select is((select count(*)::int from public.vehicle_allocations where id in (tests.id('al-cx1'), tests.id('al-cx2'), tests.id('al-cx5'))
             and status in ('cancelled', 'no_show')), 3, 'the cancelled / no_show fixtures are stored');
-- 2 vehicles can share a shift; the same pair cannot be created twice (exclusion again, via the function path below)

-- ================================================================ 3. the status guard (3C replaces it) and immutability
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'in_use' where id = tests.id('al-base')$$), '55000', 'a direct status change is refused (even for the owner): only transition_allocation changes status (3B refused all; 3C routes them)');
select is(tests.sqlstate_of($$update public.vehicle_allocations set started_at = now() where id = tests.id('al-base')$$), '55000', 'started_at cannot change in 3B');
select is(tests.sqlstate_of($$update public.vehicle_allocations set released_at = tests.ts(tests.d(10), '08:00') where id = tests.id('al-base')$$), '55000', 'released_at cannot change in 3B');
select is(tests.sqlstate_of($$update public.vehicle_allocations set closed_by = tests.id('fa') where id = tests.id('al-base')$$), '55000', 'closed_by cannot change in 3B');
select is(tests.sqlstate_of($$update public.vehicle_allocations set vehicle_id = tests.id('v-o2') where id = tests.id('al-base')$$), '23514', 'vehicle_id is immutable');
select is(tests.sqlstate_of($$update public.vehicle_allocations set driver_id = tests.id('d-dB2') where id = tests.id('al-base')$$), '23514', 'driver_id is immutable');
select is(tests.sqlstate_of($$update public.vehicle_allocations set planned_end_at = planned_end_at + interval '1 hour' where id = tests.id('al-base')$$), '55000', 'planned times change only through amend_allocation_times (slice 3C; immutable in 3B)');
select is(tests.sqlstate_of($$update public.vehicle_allocations set licence_class_check = 'not_configured' where id = tests.id('al-base')$$), '23514', 'licence_class_check is permanent');
select is(tests.sqlstate_of($$update public.vehicle_allocations set client_submission_id = gen_random_uuid() where id = tests.id('al-base')$$), '23514', 'client_submission_id is immutable');
select is(tests.sqlstate_of($$delete from public.vehicle_allocations where id = tests.id('al-base')$$), '42501', 'no DELETE on vehicle_allocations (even for the owner)');
select ok(tests.sqlstate_of($$truncate public.vehicle_allocations$$) in ('42501', '0A000'), 'no TRUNCATE on vehicle_allocations (the no_truncate trigger, or the FK from allocation_events, stops it)');

-- ================================================================ 4. eligibility function
select tests.act_as('sup1');
select is((select ok from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-day'), null, null)), true, 'B driver, B vehicle: ok');
select is((select licence_class_check from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-day'), null, null)), 'matched', '... licence_class_check = matched');
select is((select needs_override from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-day'), null, null)), false, '... no override needed');
select is((select licence_class_check from public.allocation_eligibility(tests.id('v-vC1'), tests.id('d-dEC1'), tests.id('sh-day'), null, null)), 'matched', 'EC1 driver, C1 vehicle: matched (EC1 covers C1)');
select is((select licence_class_check from public.allocation_eligibility(tests.id('v-vNone'), tests.id('d-dB'), tests.id('sh-day'), null, null)), 'not_configured', 'vehicle with no required code: not_configured');
select is((select ok from public.allocation_eligibility(tests.id('v-vNone'), tests.id('d-dB'), tests.id('sh-day'), null, null)), true, '... and allowed');
select is((select (needs_override, licence_class_check is null)::text from public.allocation_eligibility(tests.id('v-vC1'), tests.id('d-dB'), tests.id('sh-day'), null, null)),
          '(t,t)', 'B driver, C1 vehicle: needs_override, no class result');
select is((select ok from public.allocation_eligibility(tests.id('v-vC1'), tests.id('d-dB'), tests.id('sh-day'), null, null)), true, '... ok = nothing blocks it (an override request is possible)');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dNone'), tests.id('sh-day'), null, null)), array['no_eligible_licence'], 'no licence: no_eligible_licence');
select is((select ok from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dNone'), tests.id('sh-day'), null, null)), false, '... ok = false');
select is((select needs_override from public.allocation_eligibility(tests.id('v-vC1'), tests.id('d-dNone'), tests.id('sh-day'), null, null)), false, 'no licence is never an override case');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dUnv'), tests.id('sh-day'), null, null)), array['no_eligible_licence'], 'unverified licence: refused');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dRej'), tests.id('sh-day'), null, null)), array['no_eligible_licence'], 'rejected licence: refused');
select is((select ok from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dExp'), tests.id('sh-day'), null, null)), true, 'licence expiring on the local date of planned_end: eligible (on or after)');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dExp'), tests.id('sh-day2'), null, null)), array['no_eligible_licence'], 'licence expired before the planned end: refused');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dExp'), tests.id('sh-night'), null, null)), array['no_eligible_licence'],
          'night shift: the licence expires after the planned start but before the planned end (next local date): refused');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dPrdpBad'), tests.id('sh-day'), null, null)), array['no_eligible_licence'], 'PrDP required and expired: refused');
select is((select ok from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dPrdpOk'), tests.id('sh-day'), null, null)), true, 'PrDP valid on the end date: eligible');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vMaint'), tests.id('d-dB'), tests.id('sh-day'), null, null)), array['vehicle_not_available'], 'vehicle in_maintenance refused');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vOut'), tests.id('d-dB'), tests.id('sh-day'), null, null)), array['vehicle_not_available'], 'vehicle out_of_service refused');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vRet'), tests.id('d-dB'), tests.id('sh-day'), null, null)), array['vehicle_not_available'], 'vehicle retired refused');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vArch'), tests.id('d-dB'), tests.id('sh-day'), null, null)), array['vehicle_not_available'], 'archived vehicle refused');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vA2'), tests.id('d-dB'), tests.id('sh-day'), null, null)), array['vehicle_wrong_branch'], 'vehicle at another branch refused');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dA2'), tests.id('sh-day'), null, null)), array['driver_wrong_branch'], 'driver at another branch refused');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-cancelled'), null, null)), array['shift_not_scheduled'], 'cancelled shift refused');
select is(tests.sqlstate_of($$select * from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-a2'), null, null)$$), '42501', 'a shift of another branch: needs allocation.manage there');
select is(tests.sqlstate_of($$select * from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-cob'), null, null)$$), 'P0002', 'a shift of another company is not found');
select is(tests.sqlstate_of($$select * from public.allocation_eligibility(tests.id('v-vCoB'), tests.id('d-dB'), tests.id('sh-day'), null, null)$$), 'P0002', 'a vehicle of another company is not found');
select is(tests.sqlstate_of($$select * from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dCoB'), tests.id('sh-day'), null, null)$$), 'P0002', 'a driver of another company is not found');
select is(tests.sqlstate_of($$select * from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-day'), tests.ts(tests.d(0), '05:00'), tests.ts(tests.d(0), '10:00'))$$), '22023', 'start before the shift window refused');
select is(tests.sqlstate_of($$select * from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-day'), tests.ts(tests.d(0), '10:00'), tests.ts(tests.d(0), '19:00'))$$), '22023', 'end after the shift window refused');
select is(tests.sqlstate_of($$select * from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-day'), tests.ts(tests.d(0), '10:00'), tests.ts(tests.d(0), '10:00'))$$), '22023', 'end not after start refused');
select is((select ok from public.allocation_eligibility(tests.id('v-vB'), tests.id('d-dB'), tests.id('sh-day'), tests.ts(tests.d(0), '06:00'), tests.ts(tests.d(0), '18:00'))), true, 'times equal to the shift window are fine');
select is((select block_reasons from public.allocation_eligibility(tests.id('v-o1'), tests.id('d-dB'), tests.id('sh-ov'), null, null)), array['vehicle_conflict', 'driver_conflict'], 'conflicts are reported for vehicle and driver');

-- ================================================================ 5. request_allocation: direct creation (class matched / not configured)
select tests.reset();
create function tests.msg_of(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlerrm; end $$;
create function tests.cs(n text) returns uuid language sql immutable as $$ select tests.id('cs-' || n) $$;
select tests.act_as('sup1');
insert into tests.kv select 'aM', allocation_id from public.request_allocation(tests.id('sh-day'), tests.id('v-vB'), tests.id('d-dB'), null, null, 'Morning run', tests.cs('r1'));
select tests.reset();
select is((select status || '/' || licence_class_check || '/' || allocation_type from public.vehicle_allocations where id = tests.k('aM')), 'planned/matched/standard', 'B driver, B vehicle: a planned, matched, standard allocation is created');
select is((select (planned_start_at = scheduled_start_at and planned_end_at = scheduled_end_at)::text from public.vehicle_allocations a join public.shifts s on s.id = a.shift_id where a.id = tests.k('aM')), 'true', 'planned times default to the shift''s scheduled times');
select is((select created_by from public.vehicle_allocations where id = tests.k('aM')), tests.id('sup1'), 'created_by is the caller');
select is((select branch_id from public.vehicle_allocations where id = tests.k('aM')), tests.id('A1'), 'branch_id comes from the shift');
select is((select previous_allocation_id from public.vehicle_allocations where id = tests.k('aM')), null, 'no earlier allocation for that vehicle: previous_allocation_id is null');
select is((select count(*)::int from public.allocation_events where allocation_id = tests.k('aM') and event_type = 'created' and actor_id = tests.id('sup1') and reason = 'Morning run'), 1, 'a created event is written with the actor and reason');
select is((select (new_value ->> 'status') || '/' || (new_value ->> 'licence_class_check') from public.allocation_events where allocation_id = tests.k('aM')), 'planned/matched', '... carrying the new values');
select is((select count(*)::int from public.audit_logs where entity_type = 'vehicle_allocations' and action = 'insert' and entity_id = tests.k('aM') and reason = 'Morning run'), 1, 'an audit row is written (trigger), with the reason');
select tests.act_as('sup1');
select is((select allocation_id from public.request_allocation(tests.id('sh-day'), tests.id('v-vB'), tests.id('d-dB'), null, null, 'Morning run', tests.cs('r1'))), tests.k('aM'), 'idempotent retry returns the same allocation');
select tests.reset();
select is((select count(*)::int from public.vehicle_allocations where client_submission_id = tests.cs('r1')), 1, '... and creates nothing new');
select is((select count(*)::int from public.allocation_events where allocation_id = tests.k('aM')), 1, '... and no second event');
select tests.act_as('sup1');
insert into tests.kv select 'aN', allocation_id from public.request_allocation(tests.id('sh-day'), tests.id('v-vNone'), tests.id('d-dB2'), null, null, null, tests.cs('r2'));
insert into tests.kv select 'aE', allocation_id from public.request_allocation(tests.id('sh-day'), tests.id('v-vC1'), tests.id('d-dEC1'), null, null, null, tests.cs('r3'));
insert into tests.kv select 'aD2', allocation_id from public.request_allocation(tests.id('sh-day2'), tests.id('v-vB'), tests.id('d-dB'), null, null, 'Next day', tests.cs('r4'));
select tests.reset();
select is((select licence_class_check from public.vehicle_allocations where id = tests.k('aN')), 'not_configured', 'a vehicle with no required code: allocation created, licence_class_check = not_configured');
select is((select licence_class_check from public.vehicle_allocations where id = tests.k('aE')), 'matched', 'EC1 driver on a C1 vehicle: matched');
select is((select previous_allocation_id from public.vehicle_allocations where id = tests.k('aD2')), tests.k('aM'), 'previous_allocation_id = the vehicle''s latest earlier allocation');
select is((select (new_value ->> 'previous_allocation_id')::uuid from public.allocation_events where allocation_id = tests.k('aD2')), tests.k('aM'), '... and the event records it');
select tests.act_as('sup1');
select is(tests.msg_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB'), tests.id('d-dB2'), null, null, null, tests.cs('c1'))$$), 'vehicle already allocated during that period', 'same vehicle, overlapping: clear message');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB'), tests.id('d-dB2'), null, null, null, tests.cs('c1'))$$), '23P01', '... SQLSTATE exclusion_violation');
select is(tests.msg_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB3'), tests.id('d-dB'), null, null, null, tests.cs('c2'))$$), 'driver already allocated during that period', 'same driver, overlapping: clear message');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB3'), tests.id('d-dB'), tests.ts(tests.d(0), '06:00'), tests.ts(tests.d(0), '10:00'), null, tests.cs('c3'))$$), '23P01', 'driver conflict with explicit times');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB3'), tests.id('d-dB'), tests.ts(tests.d(0), '18:00'), tests.ts(tests.d(0), '19:00'), null, tests.cs('c4'))$$), '22023', 'times outside the shift window refused');
insert into tests.kv select 'aPart', allocation_id from public.request_allocation(tests.id('sh-day'), tests.id('v-vQ'), tests.id('d-dPrdpOk'), tests.ts(tests.d(0), '06:00'), tests.ts(tests.d(0), '12:00'), null, tests.cs('r5'));
insert into tests.kv select 'aPart2', allocation_id from public.request_allocation(tests.id('sh-day'), tests.id('v-vQ'), tests.id('d-dPrdpOk'), tests.ts(tests.d(0), '12:00'), tests.ts(tests.d(0), '18:00'), null, tests.cs('r6'));
select is((select count(*)::int from public.vehicle_allocations where id in (tests.k('aPart'), tests.k('aPart2'))), 2, 'back-to-back allocations of one vehicle and driver within a shift are allowed');
select is((select previous_allocation_id from public.vehicle_allocations where id = tests.k('aPart2')), tests.k('aPart'), '... the second points at the first');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB2'), tests.id('d-dNone'), null, null, null, tests.cs('e1'))$$), '23514', 'no licence: refused');
select is(tests.msg_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB2'), tests.id('d-dNone'), null, null, null, tests.cs('e1'))$$) like 'no eligible licence%', true, '... with a clear message');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB2'), tests.id('d-dUnv'), null, null, null, tests.cs('e2'))$$), '23514', 'unverified licence: refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-night'), tests.id('v-vB2'), tests.id('d-dExp'), null, null, null, tests.cs('e3'))$$), '23514', 'licence expiring before the planned end: refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB2'), tests.id('d-dPrdpBad'), null, null, null, tests.cs('e4'))$$), '23514', 'PrDP expired: refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vC1'), tests.id('d-dNone'), null, null, 'reason', tests.cs('e5'))$$), '23514', 'no eligible licence cannot be overridden: refused even with a reason');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vMaint'), tests.id('d-dB2'), null, null, null, tests.cs('e6'))$$), '55000', 'vehicle in_maintenance: refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vOut'), tests.id('d-dB2'), null, null, null, tests.cs('e7'))$$), '55000', 'vehicle out_of_service: refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vRet'), tests.id('d-dB2'), null, null, null, tests.cs('e8'))$$), '55000', 'vehicle retired: refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vA2'), tests.id('d-dB2'), null, null, null, tests.cs('e9'))$$), '23514', 'vehicle at another branch: refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB2'), tests.id('d-dA2'), null, null, null, tests.cs('e10'))$$), '23514', 'driver at another branch: refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-cancelled'), tests.id('v-vB2'), tests.id('d-dB2'), null, null, null, tests.cs('e11'))$$), '55000', 'cancelled shift: refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB2'), tests.id('d-dB2'), null, null, null, null)$$), '22023', 'client_submission_id is required');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB2'), tests.id('d-dB2'), null, null, repeat('x', 1001), tests.cs('e12'))$$), '22023', 'a reason over 1000 characters is refused');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vCoB'), tests.id('d-dB2'), null, null, null, tests.cs('e13'))$$), 'P0002', 'a vehicle of another company is not found');
select tests.reset();
select is((select count(*)::int from public.vehicle_allocations where client_submission_id in (tests.cs('e1'), tests.cs('e2'), tests.cs('e3'), tests.cs('e4'), tests.cs('e5'), tests.cs('e6'), tests.cs('e9'), tests.cs('c1'), tests.cs('c2'))), 0, 'none of the refused requests created an allocation');

-- ================================================================ 6. licence override (DEC-22 d): request, approve, segregation of duties
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1b'), tests.id('d-dB2'), null, null, null, tests.cs('o1'))$$), '22023', 'a class mismatch needs a reason to be requested');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1b'), tests.id('d-dB2'), null, null, '   ', tests.cs('o1'))$$), '22023', '... a blank reason does not count');
insert into tests.kv select 'ap1', approval_id from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1b'), tests.id('d-dB2'), null, null, 'Only licensed driver on site', tests.cs('o1'));
select is((select allocation_id from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1b'), tests.id('d-dB2'), null, null, 'Only licensed driver on site', tests.cs('o1'))) is null, true, 'class mismatch: no allocation id is returned');
select is((select approval_id from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1b'), tests.id('d-dB2'), null, null, 'Only licensed driver on site', tests.cs('o1'))), tests.k('ap1'), 'idempotent retry returns the same approval');
select tests.reset();
select is((select count(*)::int from public.vehicle_allocations where vehicle_id = tests.id('v-vC1b')), 0, 'class mismatch: NO allocation row exists');
select is((select approval_type || '/' || status || '/' || requested_by::text || '/' || branch_id::text from public.approvals where id = tests.k('ap1')),
          'licence_override/pending/' || tests.id('sup1')::text || '/' || tests.id('A1')::text, 'a pending licence_override approval was created for the shift''s branch');
select is((select payload ->> 'vehicle_id' || '|' || (payload ->> 'driver_id') || '|' || (payload ->> 'shift_id') from public.approvals where id = tests.k('ap1')),
          tests.id('v-vC1b')::text || '|' || tests.id('d-dB2')::text || '|' || tests.id('sh-day2')::text, 'every argument is in the payload');
select is((select reason from public.approvals where id = tests.k('ap1')), 'Only licensed driver on site', 'the reason is stored');
select is((select count(*)::int from public.approvals where client_submission_id = tests.cs('o1')), 1, 'the retry created no second approval');
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1b'), tests.id('d-dB2'), null, null, 'Again', tests.cs('o2'))$$), '55000', 'a second pending override for the same vehicle, driver and shift is refused');
insert into tests.kv select 'ap2', approval_id from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1c'), tests.id('d-sd'), null, null, 'Driver is also a supervisor', tests.cs('o3'));
insert into tests.kv select 'ap3', approval_id from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1'), tests.id('d-dOther'), null, null, 'Cover for sickness', tests.cs('o4'));
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap1'), 'approved', 'self')$$), '42501', 'the requester cannot approve their own request (DEC-24)');
select tests.act_as('sd');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap2'), 'approved', 'self')$$), '42501', 'the driver cannot approve their own allocation, even holding allocation.manage (DEC-24)');
select is(tests.msg_of($$select * from public.decide_approval(tests.k('ap2'), 'approved', 'self')$$) like '%driver cannot approve%', true, '... clear message from the database trigger');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap1'), 'approved', 'by a supervisor who is not the driver')$$), null, 'a different supervisor of the same branch may approve (sd approves ap1: not the requester, not the driver)');
select tests.reset();
select is((select status from public.approvals where id = tests.k('ap2')), 'pending', 'the refused approval is still pending');
select is((select count(*)::int from public.vehicle_allocations where vehicle_id = tests.id('v-vC1c')), 0, '... and nothing was created');
select is((select a.licence_class_check || '/' || a.status from public.vehicle_allocations a where a.id = (select entity_id from public.approvals where id = tests.k('ap1'))), 'override_approved/planned', 'approval: the allocation is created with licence_class_check = override_approved');
select is((select licence_override_approval_id from public.vehicle_allocations where id = (select entity_id from public.approvals where id = tests.k('ap1'))), tests.k('ap1'), '... and linked to the approval');
select is((select created_by from public.vehicle_allocations where id = (select entity_id from public.approvals where id = tests.k('ap1'))), tests.id('sup1'), '... created_by is the requester');
select is((select (metadata ->> 'approved_by')::uuid from public.allocation_events where allocation_id = (select entity_id from public.approvals where id = tests.k('ap1'))), tests.id('sd'), '... the created event records the approver in its metadata');
select is((select actor_id from public.allocation_events where allocation_id = (select entity_id from public.approvals where id = tests.k('ap1'))), tests.id('sd'), '... and the actor');
select is((select status || '/' || decided_by::text from public.approvals where id = tests.k('ap1')), 'approved/' || tests.id('sd')::text, 'the approval is approved by the approver');
select tests.act_as('sup1');
select is((select allocation_id from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1b'), tests.id('d-dB2'), null, null, 'Only licensed driver on site', tests.cs('o1'))), (select entity_id from public.approvals where id = tests.k('ap1')), 'a retry after approval returns the created allocation ...');
select is((select approval_id from public.request_allocation(tests.id('sh-day2'), tests.id('v-vC1b'), tests.id('d-dB2'), null, null, 'Only licensed driver on site', tests.cs('o1'))), tests.k('ap1'), '... and the approval that authorised it');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap3'), 'approved', 'self')$$), '42501', 'the requester cannot decide their other pending request either');
select tests.act_as('bm1b');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap1'), 'approved', 'again')$$), '55000', 'an approval that is already decided cannot be decided again');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap2'), 'rejected', 'No')$$), null, 'a different manager may reject; the driver-as-approver rule only blocks approval');
select tests.reset();
select is((select status from public.approvals where id = tests.k('ap2')), 'rejected', 'rejected');
select is((select count(*)::int from public.vehicle_allocations where vehicle_id = tests.id('v-vC1c')), 0, '... no allocation');
-- who may decide
select tests.act_as('sup2');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap3'), 'approved', 'x')$$), '42501', 'a supervisor of another branch cannot decide (no allocation.manage there)');
select tests.act_as('ma');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap3'), 'approved', 'x')$$), '42501', 'maintenance admin cannot decide (no allocation.manage)');
select tests.act_as('sm');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap3'), 'approved', 'x')$$), '42501', 'senior management cannot decide');
select tests.act_as('sa');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap3'), 'approved', 'x')$$), '42501', 'system admin cannot decide');
select tests.act_as('fab');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap3'), 'approved', 'x')$$), 'P0002', 'another company cannot decide');
-- approval after a conflicting allocation appeared: the decision fails and nothing changes
select tests.reset();
select tests.mk_alloc('blocker', 'day2', 'vC1', 'dUnv', tests.ts(tests.d(1), '08:00'), tests.ts(tests.d(1), '09:00'));
select tests.act_as('fa');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap3'), 'approved', 'late')$$), '23P01', 'approval after a conflicting allocation appeared: the decision fails (vehicle already allocated)');
select tests.reset();
select is((select status from public.approvals where id = tests.k('ap3')), 'pending', '... the approval stays pending (rolled back)');
select is((select count(*)::int from public.vehicle_allocations where licence_override_approval_id = tests.k('ap3')), 0, '... and no allocation was created');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap3'), 'rejected', 'conflict')$$), null, 'the conflicted request can still be rejected');
-- re-checks at decision time: the licence is no longer eligible
select tests.act_as('sup1');
insert into tests.kv select 'ap4', approval_id from public.request_allocation(tests.id('sh-day'), tests.id('v-vC1c'), tests.id('d-dOther'), tests.ts(tests.d(0), '06:00'), tests.ts(tests.d(0), '08:00'), 'Cover', tests.cs('o5'));
select tests.reset();
update public.vehicles set administrative_status = 'in_maintenance' where id = tests.id('v-vC1c');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('ap4'), 'approved', 'late')$$), '55000', 'approval after the vehicle went into maintenance: the decision fails');
select tests.reset();
select is((select status from public.approvals where id = tests.k('ap4')), 'pending', '... nothing changed');
update public.vehicles set administrative_status = 'available' where id = tests.id('v-vC1c');

-- ================================================================ 7. permissions
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB2'), tests.id('d-sd'), tests.ts(tests.d(0), '08:00'), tests.ts(tests.d(0), '10:00'), null, tests.cs('p1'))$$), null, 'branch manager allocates in their own branch');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-a2'), tests.id('v-vA2'), tests.id('d-dA2'), null, null, null, tests.cs('p2'))$$), '42501', 'branch manager cannot allocate in another branch');
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-a2'), tests.id('v-vA2'), tests.id('d-dA2'), null, null, null, tests.cs('p3'))$$), '42501', 'supervisor cannot allocate in another branch');
select tests.act_as('sup2');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-a2'), tests.id('v-vA2'), tests.id('d-dA2'), null, null, null, tests.cs('p4'))$$), null, 'supervisor allocates in their own branch (A2)');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-day'), tests.id('v-vB2'), tests.id('d-dB2'), null, null, null, tests.cs('p5'))$$), '42501', '... but not at A1');
select tests.act_as('fa');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-perm'), tests.id('v-vS'), tests.id('d-dB'), null, null, null, tests.cs('p6'))$$), null, 'fleet admin allocates company-wide (A1)');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-cob'), tests.id('v-vCoB'), tests.id('d-dCoB'), null, null, null, tests.cs('p7'))$$), 'P0002', 'fleet admin cannot reach another company');
select tests.act_as('ma');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-perm'), tests.id('v-vR'), tests.id('d-dB2'), null, null, null, tests.cs('p8'))$$), '42501', 'maintenance admin cannot create allocations');
select is(tests.sqlstate_of($$select * from public.allocation_eligibility(tests.id('v-vR'), tests.id('d-dB2'), tests.id('sh-perm'), null, null)$$), '42501', '... nor ask for eligibility');
select tests.act_as('sm');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-perm'), tests.id('v-vR'), tests.id('d-dB2'), null, null, null, tests.cs('p9'))$$), '42501', 'senior management cannot create allocations');
select tests.act_as('sa');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-perm'), tests.id('v-vR'), tests.id('d-dB2'), null, null, null, tests.cs('p10'))$$), '42501', 'system admin cannot create allocations');
select tests.act_as('dB');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-perm'), tests.id('v-vR'), tests.id('d-dB2'), null, null, null, tests.cs('p11'))$$), '42501', 'a driver cannot create allocations');
select tests.act_as('fab');
select is(tests.sqlstate_of($$select * from public.request_allocation(tests.id('sh-perm'), tests.id('v-vR'), tests.id('d-dB2'), null, null, null, tests.cs('p12'))$$), 'P0002', 'a fleet admin of company B cannot allocate in company A');
select tests.reset();
select is(has_function_privilege('anon', 'public.request_allocation(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid)', 'execute'), false, 'anon cannot call request_allocation');
select is(has_function_privilege('authenticated', 'public.apply_licence_override(uuid)', 'execute'), false, 'apply_licence_override is not callable by clients');
select is(has_function_privilege('authenticated', 'public.allocation_create_row(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid, uuid, uuid, text, jsonb)', 'execute'), false, 'allocation_create_row is not callable by clients');
select is(has_function_privilege('authenticated', 'public.allocation_eligibility_core(uuid, uuid, uuid, uuid, timestamptz, timestamptz)', 'execute'), false, 'allocation_eligibility_core is not callable by clients');
select is(has_function_privilege('authenticated', 'public.shift_has_active_allocations(uuid)', 'execute'), false, 'shift_has_active_allocations stays internal');
-- reads (RLS)
select tests.act_as('dB');
select is((select count(*)::int from public.vehicle_allocations where driver_id <> tests.id('d-dB')), 0, 'a driver reads only their own allocations');
select is((select count(*)::int > 0 from public.vehicle_allocations where driver_id = tests.id('d-dB')), true, '... and does see them');
select is((select count(*)::int from public.allocation_events e where not exists (select 1 from public.vehicle_allocations a where a.id = e.allocation_id and a.driver_id = tests.id('d-dB'))), 0, 'a driver reads only events of their own allocations');
select is((select count(*)::int > 0 from public.allocation_events), true, '... and does see some');
select tests.act_as('dNone');
select is((select count(*)::int from public.vehicle_allocations), 0, 'a driver with no allocations sees none');
select is((select count(*)::int from public.allocation_events), 0, '... and no events');
select tests.act_as('sup1');
select is((select count(*)::int from public.vehicle_allocations where branch_id <> tests.id('A1')), 0, 'a supervisor reads only their own branch');
select is((select count(*)::int > 0 from public.vehicle_allocations), true, '... and does see it');
select tests.act_as('sup2');
select is((select count(*)::int from public.vehicle_allocations where branch_id = tests.id('A1')), 0, 'a supervisor of A2 does not see A1');
select tests.act_as('fa');
select is((select count(distinct branch_id)::int from public.vehicle_allocations), 2, 'a fleet admin reads every branch of the company');
select tests.act_as('ma');
select is((select count(*)::int > 0 from public.vehicle_allocations), true, 'maintenance admin reads allocations (reports.view)');
select tests.act_as('sm');
select is((select count(*)::int > 0 from public.vehicle_allocations), true, 'senior management reads allocations (reports.view)');
select tests.act_as('sa');
select is((select count(*)::int from public.vehicle_allocations), 0, 'system admin reads no allocations');
select is((select count(*)::int from public.allocation_events), 0, '... and no events');
select tests.act_as('fab');
select is((select count(*)::int from public.vehicle_allocations), 0, 'another company reads nothing');
select is((select count(*)::int from public.allocation_events), 0, '... not events either');
select tests.act_as('fa');
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, licence_class_check, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('A1'), tests.id('v-vR'), tests.id('d-dB2'), tests.id('sh-perm'), now(), now() + interval '1 hour', 'matched', gen_random_uuid(), tests.id('fa'))$$), '42501', 'no client INSERT on vehicle_allocations (even a fleet admin)');
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'cancelled'$$), '42501', 'no client UPDATE on vehicle_allocations');
select is(tests.sqlstate_of($$delete from public.vehicle_allocations$$), '42501', 'no client DELETE on vehicle_allocations');
select is(tests.sqlstate_of($$insert into public.allocation_events (company_id, allocation_id, event_type, actor_id) values (tests.id('coA'), tests.k('aM'), 'created', tests.id('fa'))$$), '42501', 'no client INSERT on allocation_events');
select is(tests.sqlstate_of($$update public.allocation_events set reason = 'x'$$), '42501', 'no client UPDATE on allocation_events');
select is(tests.sqlstate_of($$delete from public.allocation_events$$), '42501', 'no client DELETE on allocation_events');
select tests.act_as('anon_none');
select tests.reset();
set local role anon;
select is(tests.sqlstate_of($$select count(*) from public.vehicle_allocations$$), '42501', 'anon cannot read vehicle_allocations');
select tests.reset();

-- ================================================================ 8. required licence code (028)
select tests.act_as('fa');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vR'), 'C1', 'Gross mass 8,000 kg per registration papers')$$), null, 'fleet admin (vehicle.manage, company-wide) sets the code');
select tests.reset();
select is((select required_licence_code from public.vehicles where id = tests.id('v-vR')), 'C1', '... stored');
select is((select count(*)::int from public.audit_logs where entity_type = 'vehicles' and action = 'update' and entity_id = tests.id('v-vR') and reason = 'required licence code: Gross mass 8,000 kg per registration papers'), 1, '... audited with the reason');
select tests.act_as('fa');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vR'), null, 'Reclassified')$$), null, 'NULL clears the code (not configured)');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vR'), 'D', 'bad')$$), '22023', 'an unknown code is refused');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vR'), 'b', 'lower case')$$), '22023', 'codes are case-sensitive');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vR'), 'B', '  ')$$), '22023', 'a reason is required');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vArch'), 'B', 'archived')$$), '55000', 'an archived vehicle cannot be edited');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vCoB'), 'B', 'x')$$), 'P0002', 'a vehicle of another company is not found');
select is(tests.sqlstate_of($$update public.vehicles set required_licence_code = 'EC' where id = tests.id('v-vR')$$), '42501', 'the column is not client-writable, even for a fleet admin');
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vR'), 'B', 'x')$$), '42501', 'supervisor cannot set it (no vehicle.manage)');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vR'), 'B', 'x')$$), '42501', 'branch manager cannot set it (no vehicle.manage)');
select tests.act_as('ma');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vR'), 'B', 'x')$$), '42501', 'maintenance admin cannot set it');
select tests.act_as('fab');
select is(tests.sqlstate_of($$select public.set_vehicle_required_licence_code(tests.id('v-vR'), 'B', 'x')$$), 'P0002', 'another company cannot set it');
select tests.reset();
select is(tests.sqlstate_of($$update public.vehicles set required_licence_code = 'EC' where id = tests.id('v-vR')$$), null, 'the owner (migrations, jobs) can still write the column directly');
select is(tests.sqlstate_of($$update public.vehicles set required_licence_code = 'Z' where id = tests.id('v-vR')$$), '23514', 'CHECK: only the eight codes');
select is(tests.sqlstate_of($$insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('d-dB'), 'SYN-BAD', 'D', '2020-01-01', '2030-01-01', gen_random_uuid(), tests.id('fa'))$$), '23514', 'driver_licences.licence_code: only the eight codes');
select is(tests.sqlstate_of($$insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('d-dB'), 'SYN-LOW', 'eb', '2020-01-01', '2030-01-01', gen_random_uuid(), tests.id('fa'))$$), '23514', '... lower case is refused too');
-- the migration refuses a non-conforming row instead of rewriting it
alter table public.driver_licences drop constraint driver_licences_code_valid;
update public.driver_licences set licence_code = 'B' where false;
alter table public.driver_licences disable trigger driver_licences_immutable;
alter table public.driver_licences disable trigger driver_licences_guard_t;
update public.driver_licences set licence_code = 'Z9' where id = (select id from public.driver_licences where driver_id = tests.id('d-dOther') limit 1);
create function tests.check_028() returns void language plpgsql as $f$
declare n integer;
begin  -- the same statement as the DO block in migration 028
  select count(*) into n from public.driver_licences
   where licence_code is null or licence_code not in ('A1', 'A', 'B', 'C1', 'C', 'EB', 'EC1', 'EC');
  if n > 0 then
    raise exception 'migration 028 refused: % driver_licences row(s) hold a licence_code outside the eight codes', n using errcode = '23514';
  end if;
end $f$;
select is(tests.sqlstate_of('select tests.check_028()'), '23514', 'the migration''s guard fails loudly when a non-conforming row exists (it never rewrites data)');
update public.driver_licences set licence_code = 'B' where licence_code = 'Z9';
alter table public.driver_licences enable trigger driver_licences_immutable;
alter table public.driver_licences enable trigger driver_licences_guard_t;
alter table public.driver_licences add constraint driver_licences_code_valid check (licence_code in ('A1', 'A', 'B', 'C1', 'C', 'EB', 'EC1', 'EC'));

-- ================================================================ 9. shift_has_active_allocations, cancel_shift and the consistency guards
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select public.cancel_shift(tests.id('sh-day'), 'rain')$$), '55000', 'cancel_shift refuses while the shift has allocations');
select is(tests.msg_of($$select public.cancel_shift(tests.id('sh-day'), 'rain')$$), 'a shift with active allocations cannot be cancelled', '... with the 3A message');
select tests.reset();
select is(public.shift_has_active_allocations(tests.id('sh-cx')), true, 'a shift with live allocations has active allocations');
select tests.mk_shift('only-cx', 'A1', tests.d(30), '06:00', '18:00');
select tests.mk_alloc('only-cx', 'only-cx', 'o3', 'dOther', tests.ts(tests.d(30), '07:00'), tests.ts(tests.d(30), '08:00'), 'cancelled');
select tests.mk_alloc('only-ns', 'only-cx', 'o3', 'dOther', tests.ts(tests.d(30), '07:00'), tests.ts(tests.d(30), '08:00'), 'no_show');
select is(public.shift_has_active_allocations(tests.id('sh-only-cx')), false, 'only cancelled / no_show allocations: not active');
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select public.cancel_shift(tests.id('sh-only-cx'), 'not needed')$$), null, '... so the shift can be cancelled');
-- branch transfer guard (approval needs a different fleet admin)
select is(tests.sqlstate_of($$select tests.mk_alloc('t1', 'tr', 'vT', 'dB2', tests.ts(tests.d(14), '08:00'), tests.ts(tests.d(14), '09:00'))$$), '42501', 'sanity: sup1 cannot insert directly (fixture needs the owner)');
select tests.reset();
select tests.mk_alloc('t1', 'tr', 'vT', 'dB2', tests.ts(tests.d(14), '08:00'), tests.ts(tests.d(14), '09:00'));
select tests.act_as('fa');
insert into tests.kv select 'tr1', id from public.request_vehicle_transfer(tests.id('v-vT'), tests.id('A2'), 'Rebalancing', tests.cs('tr1'));
select tests.act_as('fa2');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('tr1'), 'approved', 'ok')$$), '55000', 'branch transfer is refused while the vehicle has open allocations at the old branch');
select is(tests.msg_of($$select * from public.decide_approval(tests.k('tr1'), 'approved', 'ok')$$) like '%open allocations%', true, '... with a clear message');
select tests.reset();
select is((select current_branch_id from public.vehicles where id = tests.id('v-vT')), tests.id('A1'), '... the vehicle did not move');
select is((select status from public.approvals where id = tests.k('tr1')), 'pending', '... and the approval stays pending');
alter table public.vehicle_allocations disable trigger va_status_guard_t;
update public.vehicle_allocations set status = 'cancelled' where id = tests.id('al-t1');
alter table public.vehicle_allocations enable trigger va_status_guard_t;
select tests.act_as('fa2');
select is(tests.sqlstate_of($$select * from public.decide_approval(tests.k('tr1'), 'approved', 'ok')$$), null, 'once the allocation is cancelled the transfer goes through');
select tests.reset();
select is((select current_branch_id from public.vehicles where id = tests.id('v-vT')), tests.id('A2'), '... and the vehicle moved');
-- driver deactivation guard
select tests.mk_alloc('dr1', 'dr', 'vP', 'dOther', tests.ts(tests.d(15), '08:00'), tests.ts(tests.d(15), '09:00'));
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.set_driver_status(tests.id('d-dOther'), 'inactive', 'left the company')$$), '55000', 'deactivating a driver with open allocations is refused');
select is(tests.msg_of($$select public.set_driver_status(tests.id('d-dOther'), 'inactive', 'left the company')$$) like '%open allocations%', true, '... with a clear message');
select is(tests.sqlstate_of($$select public.set_driver_status(tests.id('d-dNone'), 'inactive', 'left the company')$$), null, 'a driver without allocations can be deactivated');
select tests.reset();
select is((select active_status from public.drivers where id = tests.id('d-dOther')), 'active', 'the refused driver is still active');
alter table public.vehicle_allocations disable trigger va_status_guard_t;
update public.vehicle_allocations set status = 'closed' where id = tests.id('al-dr1');
update public.vehicle_allocations set released_at = tests.ts(tests.d(15), '08:30') where id = tests.id('al-dr1');
alter table public.vehicle_allocations enable trigger va_status_guard_t;
select tests.mk_alloc('dr2', 'dr', 'vP', 'dOther', tests.ts(tests.d(15), '10:00'), tests.ts(tests.d(15), '11:00'), 'cancelled');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.set_driver_status(tests.id('d-dOther'), 'inactive', 'left the company')$$), null, 'closed and cancelled allocations do not block deactivation');

-- ================================================================ 10. events, audit, privileges
select tests.reset();
select is(tests.sqlstate_of($$update public.allocation_events set reason = 'x'$$), '42501', 'allocation_events: UPDATE refused (append-only trigger, even for the owner)');
select is(tests.sqlstate_of($$delete from public.allocation_events$$), '42501', 'allocation_events: DELETE refused');
select is(tests.sqlstate_of($$truncate public.allocation_events$$), '42501', 'allocation_events: TRUNCATE refused');
select is(tests.sqlstate_of($$insert into public.allocation_events (company_id, allocation_id, event_type, actor_id) values (tests.id('coA'), tests.k('aM'), 'teleported', tests.id('fa'))$$), '23514', 'event_type is one of the six values');
select is(tests.sqlstate_of($$insert into public.allocation_events (company_id, allocation_id, event_type, actor_id) values (tests.id('coB'), tests.k('aM'), 'created', tests.id('fa'))$$), '23503', 'an event cannot point at another company''s allocation (composite FK)');
select is((select count(*)::int from public.vehicle_allocations a where not exists (select 1 from public.allocation_events e where e.allocation_id = a.id and e.event_type = 'created')
             and a.client_submission_id <> '00000000-0000-0000-0000-000000000000' and a.id in (tests.k('aM'), tests.k('aN'), tests.k('aE'), tests.k('aD2'), tests.k('aPart'), tests.k('aPart2'))), 0, 'every function-created allocation has its created event (same transaction)');
select cmp_ok(tests.audit_n('vehicle_allocations', 'insert'), '>=', 12, 'audit rows are written for allocation inserts');
select is(tests.audit_n('vehicle_allocations', 'delete'), 0, 'and there are no delete audit rows');

select * from finish();
rollback;
