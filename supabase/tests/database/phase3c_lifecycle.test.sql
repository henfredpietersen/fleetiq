-- Slice 3C pgTAP: allocation lifecycle (migrations 032-034; PRD v1.13 §5.5; DEC-22, DEC-24, DEC-39, DEC-40).
-- Synthetic data only; everything rolls back. Times are relative to now() (constant inside the transaction).
-- Every scenario label L creates: driver tests.id('d-u-L') (profile tests.id('u-L')), vehicle v-L, shift sh-L, allocation al-L.
begin;
create extension if not exists pgtap with schema extensions;
select plan(219);

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
create function tests.msg_of(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlerrm; end $$;
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
create function tests.mk_licence(drv text, code text, expiry date, verified boolean default true, prdp date default null) returns void language sql as $$
  insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, prdp_required, prdp_expiry_date,
                                      verification_status, client_submission_id, created_by, verified_by, verified_at)
  select d.company_id, d.id, 'SYN-' || drv || '-' || code || '-' || expiry::text, code, expiry - 3000, expiry, prdp is not null, prdp,
         case when verified then 'verified' else 'recorded' end, gen_random_uuid(), case when d.company_id = tests.id('coB') then tests.id('bootb') else tests.id('fa') end,
         case when verified then case when d.company_id = tests.id('coB') then tests.id('fab') else tests.id('bm1') end end, case when verified then now() end
    from public.drivers d where d.id = tests.id('d-' || drv);
$$;
create function tests.mk_vehicle(label text, comp text, branch text, code text default null) returns void language sql as $$
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category, required_licence_code)
  values (tests.id('v-' || label), tests.id(comp), tests.id(branch), 'FL-' || label, upper('T3C' || label), 'Make', 'Model', 'bakkie', code);
$$;
-- one scenario: driver + licence valid for the allocation's end date + vehicle + shift (window = shift_s..shift_e, default = the allocation) + allocation
create function tests.sc(label text, branch text, s timestamptz, e timestamptz, st text default 'planned',
                         shift_s timestamptz default null, shift_e timestamptz default null) returns void language plpgsql as $$
declare comp text := case when branch = 'B1' then 'coB' else 'coA' end;
begin
  perform tests.mk_driver('u-' || label, comp, 'E-' || upper(label), branch);
  perform tests.mk_licence('u-' || label, 'B', ((e at time zone 'Africa/Johannesburg')::date) + 400);
  perform tests.mk_vehicle(label, comp, branch, 'B');
  insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('sh-' || label), tests.id(comp), tests.id(branch), (coalesce(shift_s, s) at time zone 'Africa/Johannesburg')::date,
          coalesce(shift_s, s), coalesce(shift_e, e), gen_random_uuid(), tests.id(case when comp = 'coB' then 'bootb' else 'boot' end));
  insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, status,
                                          licence_class_check, client_submission_id, created_by)
  values (tests.id('al-' || label), tests.id(comp), tests.id(branch), tests.id('v-' || label), tests.id('d-u-' || label), tests.id('sh-' || label),
          s, e, st, 'matched', gen_random_uuid(), tests.id(case when comp = 'coB' then 'bootb' else 'fa' end));
end $$;
create function tests.al(l text) returns uuid language sql immutable as $$ select tests.id('al-' || l) $$;
create function tests.tr(l text, to_s text, reason text default null, c text default null) returns text language sql as $$
  select tests.sqlstate_of(format('select * from public.transition_allocation(%L, %L, %L, %L)', tests.al(l), to_s, reason, tests.id('cs-' || coalesce(c, l || to_s)))) $$;
create function tests.trm(l text, to_s text, reason text default null, c text default null) returns text language sql as $$
  select tests.msg_of(format('select * from public.transition_allocation(%L, %L, %L, %L)', tests.al(l), to_s, reason, tests.id('cs-' || coalesce(c, l || to_s)))) $$;
create function tests.am(l text, s timestamptz, e timestamptz, reason text default 'Changed', c text default null) returns text language sql as $$
  select tests.sqlstate_of(format('select * from public.amend_allocation_times(%L, %L, %L, %L, %L)', tests.al(l), s, e, reason, tests.id('cs-' || coalesce(c, l || s::text || e::text)))) $$;
create function tests.st(l text) returns text language sql as $$ select status from public.vehicle_allocations where id = tests.al(l) $$;
create function tests.evn(l text) returns integer language sql as $$ select count(*)::int from public.allocation_events where allocation_id = tests.al(l) and event_type <> 'created' $$;
create function tests.local_date(t timestamptz) returns date language sql immutable as $$ select (t at time zone 'Africa/Johannesburg')::date $$;

-- ---------------------------------------------------------------- fixtures
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('fa', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'),
       tests.mk_user('bm1', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('fab', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sup2', 'supervisor', 'A2', 'boot'),
       tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'),
       tests.grant_role('sm', 'senior_management', null, 'boot'), tests.grant_role('sa', 'system_admin', null, 'boot'),
       tests.grant_role('fab', 'fleet_admin', null, 'bootb');

-- start window (60 min) and licence/state scenarios
select tests.sc('ok',      'A1', now() + interval '30 minutes', now() + interval '8 hours 30 minutes');
select tests.sc('early',   'A1', now() + interval '90 minutes', now() + interval '9 hours');
select tests.sc('edgeopen','A1', now() + interval '60 minutes', now() + interval '9 hours');
select tests.sc('edgeearly','A1', now() + interval '60 minutes 1 second', now() + interval '9 hours');
select tests.sc('endnow',  'A1', now() - interval '8 hours', now());
select tests.sc('endplus', 'A1', now() - interval '8 hours', now() + interval '1 second');
select tests.sc('ended',   'A1', now() - interval '9 hours', now() - interval '1 minute');
select tests.sc('oth',     'A1', now(), now() + interval '8 hours');
select tests.sc('inact',   'A1', now(), now() + interval '8 hours');
select tests.sc('licexp',  'A1', now(), now() + interval '8 hours');
select tests.sc('licunv',  'A1', now(), now() + interval '8 hours');
select tests.sc('shcx',    'A1', now(), now() + interval '8 hours');
select tests.sc('obh',     'A1', now() + interval '10 minutes', now() + interval '8 hours');
select tests.sc('obh2',    'A1', now() + interval '10 minutes', now() + interval '8 hours');
select tests.sc('obh3',    'A1', now() + interval '10 minutes', now() + interval '8 hours');
select tests.sc('obhearly','A1', now() + interval '3 hours', now() + interval '8 hours');
select tests.sc('sdrv',    'A1', now(), now() + interval '8 hours');
select tests.sc('sdrvother','A1', now(), now() + interval '8 hours');
select tests.grant_role('u-sdrv', 'supervisor', 'A1', 'boot');
select tests.sc('coB1',    'B1', now(), now() + interval '8 hours');
-- cancel / no-show / terminal / future-phase fixtures
select tests.sc('c1',  'A1', now() + interval '2 hours', now() + interval '8 hours');
select tests.sc('c2',  'A1', now() + interval '2 hours', now() + interval '8 hours', 'pre_inspection_pending');
select tests.sc('c3',  'A1', now() + interval '2 hours', now() + interval '8 hours');
select tests.sc('c4',  'A1', now() + interval '2 hours', now() + interval '8 hours');
select tests.sc('c5',  'A1', now() + interval '2 hours', now() + interval '8 hours');
select tests.sc('tcan','A1', now() + interval '2 hours', now() + interval '8 hours', 'cancelled');
select tests.sc('tnos','A1', now() - interval '2 hours', now() + interval '8 hours', 'no_show');
select tests.sc('tcls','A1', now() - interval '2 hours', now() + interval '8 hours', 'closed');
select tests.sc('inuse','A1', now() - interval '2 hours', now() + interval '8 hours', 'in_use');
select tests.sc('post','A1', now() - interval '2 hours', now() + interval '8 hours', 'post_inspection_pending');
select tests.sc('cwe', 'A1', now() - interval '2 hours', now() + interval '8 hours', 'closed_with_exceptions');
select tests.sc('ns1', 'A1', now() - interval '29 minutes', now() + interval '8 hours', 'pre_inspection_pending');
select tests.sc('ns2', 'A1', now() - interval '30 minutes', now() + interval '8 hours', 'pre_inspection_pending');
select tests.sc('ns3', 'A1', now() - interval '31 minutes', now() + interval '8 hours', 'pre_inspection_pending');
select tests.sc('ns4', 'A1', now() - interval '31 minutes', now() + interval '8 hours', 'pre_inspection_pending');
select tests.sc('ns5', 'A1', now() - interval '31 minutes', now() + interval '8 hours');                      -- planned: not in the table
-- amend fixtures: wide shift window, narrow allocation
select tests.sc('am1', 'A1', now() + interval '3 days 2 hours', now() + interval '3 days 4 hours', 'planned', now() + interval '3 days', now() + interval '3 days 12 hours');
select tests.sc('am2', 'A1', now() + interval '3 days 2 hours', now() + interval '3 days 4 hours', 'pre_inspection_pending', now() + interval '3 days', now() + interval '3 days 12 hours');
select tests.sc('am3', 'A1', now() + interval '3 days 2 hours', now() + interval '3 days 4 hours', 'cancelled', now() + interval '3 days', now() + interval '3 days 12 hours');
select tests.sc('am4', 'A1', now() + interval '3 days 2 hours', now() + interval '3 days 4 hours', 'in_use', now() + interval '3 days', now() + interval '3 days 12 hours');
select tests.sc('am5', 'A1', now() + interval '3 days 2 hours', now() + interval '3 days 4 hours', 'planned', now() + interval '3 days', now() + interval '3 days 12 hours');
select tests.sc('am6', 'A1', now() + interval '3 days 2 hours', now() + interval '3 days 4 hours', 'planned', now() + interval '3 days', now() + interval '3 days 12 hours');
-- overlap neighbours: same vehicle as am5 (later), same driver as am6 (later, other vehicle)
insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
select tests.id('sh-nb'), tests.id('coA'), tests.id('A1'), tests.local_date(now() + interval '3 days 6 hours'), now() + interval '3 days 5 hours', now() + interval '3 days 12 hours', gen_random_uuid(), tests.id('boot');
select tests.mk_vehicle('nbv', 'coA', 'A1', 'B');
insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, licence_class_check, client_submission_id, created_by)
values (tests.id('al-nb1'), tests.id('coA'), tests.id('A1'), tests.id('v-am5'), tests.id('d-u-am1'), tests.id('sh-nb'), now() + interval '3 days 6 hours', now() + interval '3 days 8 hours', 'matched', gen_random_uuid(), tests.id('fa')),
       (tests.id('al-nb2'), tests.id('coA'), tests.id('A1'), tests.id('v-nbv'), tests.id('d-u-am6'), tests.id('sh-nb'), now() + interval '3 days 6 hours', now() + interval '3 days 8 hours', 'matched', gen_random_uuid(), tests.id('fa'));
-- licence ends the same local day the night shift starts: extending past midnight is refused
select tests.mk_driver('u-lic', 'coA', 'E-LIC', 'A1');
select tests.mk_vehicle('lic', 'coA', 'A1', 'B');
select tests.mk_licence('u-lic', 'B', tests.local_date(now() + interval '5 days 18 hours'));
insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
select tests.id('sh-lic'), tests.id('coA'), tests.id('A1'), tests.local_date(t.s), t.s, t.s + interval '12 hours', gen_random_uuid(), tests.id('boot')
  from (select ((tests.local_date(now() + interval '5 days 18 hours') + time '18:00') at time zone 'Africa/Johannesburg') as s) t;
insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, licence_class_check, client_submission_id, created_by)
select tests.id('al-lic'), tests.id('coA'), tests.id('A1'), tests.id('v-lic'), tests.id('d-u-lic'), sh.id, sh.scheduled_start_at, sh.scheduled_start_at + interval '5 hours', 'matched', gen_random_uuid(), tests.id('fa')
  from public.shifts sh where sh.id = tests.id('sh-lic');

-- ================================================================ 1. the guard trigger
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'pre_inspection_pending' where id = tests.al('c3')$$), '55000', 'direct UPDATE of status is refused even for an allowed pair (superuser)');
select is(tests.st('c3'), 'planned', '... and nothing changed');
select set_config('app.allocation_transition', 'on', true);
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'pre_inspection_pending' where id = tests.al('c3')$$), '55000', 'even with the flag, entering pre_inspection_pending without opened_* is refused');
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'closed' where id = tests.al('c3')$$), '55000', 'a pair outside the table is refused even with the flag (planned -> closed)');
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'planned' where id = tests.al('tcan')$$), '55000', 'a cancelled (terminal) row cannot change status, even with the flag');
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'planned' where id = tests.al('tnos')$$), '55000', 'a no_show (terminal) row cannot change status');
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'in_use' where id = tests.al('tcls')$$), '55000', 'a closed (terminal) row cannot change status');
select set_config('app.allocation_transition', 'off', true);
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'planned' where id = tests.al('tcan')$$), '55000', 'a terminal row is refused without the flag too');
select is(tests.sqlstate_of($$update public.vehicle_allocations set vehicle_id = tests.id('v-c1') where id = tests.al('c3')$$), '23514', 'vehicle_id is immutable');
select is(tests.sqlstate_of($$update public.vehicle_allocations set driver_id = tests.id('d-u-c1') where id = tests.al('c3')$$), '23514', 'driver_id is immutable');
select is(tests.sqlstate_of($$update public.vehicle_allocations set shift_id = tests.id('sh-c1') where id = tests.al('c3')$$), '23514', 'shift_id is immutable');
select is(tests.sqlstate_of($$update public.vehicle_allocations set branch_id = tests.id('A2') where id = tests.al('c3')$$), '23514', 'branch_id is immutable');
select is(tests.sqlstate_of($$update public.vehicle_allocations set company_id = tests.id('coB') where id = tests.al('c3')$$), '23514', 'company_id is immutable');
select is(tests.sqlstate_of($$update public.vehicle_allocations set created_by = tests.id('sup1') where id = tests.al('c3')$$), '23514', 'created_by is immutable');
select is(tests.sqlstate_of($$update public.vehicle_allocations set licence_class_check = 'not_configured' where id = tests.al('c3')$$), '23514', 'licence_class_check is permanent');
select is(tests.sqlstate_of($$update public.vehicle_allocations set started_at = now() where id = tests.al('c3')$$), '55000', 'started_at stays closed until Phase 4');
select is(tests.sqlstate_of($$update public.vehicle_allocations set released_at = now() + interval '3 hours' where id = tests.al('c3')$$), '55000', 'released_at stays closed until Phase 4');
select is(tests.sqlstate_of($$update public.vehicle_allocations set closed_by = tests.id('fa') where id = tests.al('c3')$$), '55000', 'closed_by stays closed until Phase 5');
select is(tests.sqlstate_of($$update public.vehicle_allocations set opened_at = now(), opened_by = tests.id('sup1') where id = tests.al('c3')$$), '55000', 'opened_* cannot be set by direct UPDATE');
select is(tests.sqlstate_of($$update public.vehicle_allocations set opened_on_behalf = true where id = tests.al('c3')$$), '55000', 'opened_on_behalf cannot be set by direct UPDATE');
select is(tests.sqlstate_of($$update public.vehicle_allocations set planned_end_at = planned_end_at + interval '1 hour' where id = tests.al('c3')$$), '55000', 'planned times cannot be changed by direct UPDATE');
select set_config('app.allocation_amend', 'on', true);
select is(tests.sqlstate_of($$update public.vehicle_allocations set planned_end_at = planned_end_at - interval '1 hour' where id = tests.al('am4')$$), '55000', 'even with the amend flag, an in_use allocation''s times cannot change');
select is(tests.sqlstate_of($$update public.vehicle_allocations set planned_end_at = planned_end_at + interval '30 days' where id = tests.al('am1')$$), '22023', 'the guard also holds the shift window (DEC-39)');
select set_config('app.allocation_amend', 'off', true);
-- CHECK shapes (inserts bypass the update guard, so the constraints speak)
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, licence_class_check, client_submission_id, created_by, opened_at)
  select company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at + interval '20 days', planned_end_at + interval '20 days', licence_class_check, gen_random_uuid(), created_by, now() from public.vehicle_allocations where id = tests.al('c3')$$), '23514', 'CHECK: opened_at without opened_by is refused');
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, licence_class_check, client_submission_id, created_by, opened_on_behalf)
  select company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at + interval '20 days', planned_end_at + interval '20 days', licence_class_check, gen_random_uuid(), created_by, true from public.vehicle_allocations where id = tests.al('c3')$$), '23514', 'CHECK: opened_on_behalf without an opener is refused');
select is(tests.sqlstate_of($$insert into public.vehicle_allocations (company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, licence_class_check, client_submission_id, created_by, opened_by)
  select company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at + interval '20 days', planned_end_at + interval '20 days', licence_class_check, gen_random_uuid(), created_by, tests.id('sup1') from public.vehicle_allocations where id = tests.al('c3')$$), '23514', 'CHECK: opened_by without opened_at is refused');
select tests.act_as('fa');
select is(tests.sqlstate_of($$update public.vehicle_allocations set status = 'cancelled' where id = tests.al('c3')$$), '42501', 'no client UPDATE grant (even a fleet admin)');
select tests.reset();

-- ================================================================ 2. start by the allocation's own driver
select tests.act_as('u-ok');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), true, 'my_allocations: can_open is true inside the window');
select is(tests.tr('ok', 'pre_inspection_pending'), null, 'own driver starts inside the window, without a reason');
select tests.reset();
select is(tests.st('ok'), 'pre_inspection_pending', '... status pre_inspection_pending');
select is((select opened_on_behalf from public.vehicle_allocations where id = tests.al('ok')), false, '... opened_on_behalf false');
select is((select opened_by from public.vehicle_allocations where id = tests.al('ok')), tests.id('u-ok'), '... opened_by is the driver');
select is((select opened_at from public.vehicle_allocations where id = tests.al('ok')), now(), '... opened_at is now');
select is(tests.evn('ok'), 1, '... exactly one event');
select is((select event_type || '/' || (previous_value ->> 'status') || '/' || (new_value ->> 'status') || '/' || (metadata ->> 'on_behalf') || '/' || actor_id::text from public.allocation_events where allocation_id = tests.al('ok') and event_type <> 'created'),
          'status_changed/planned/pre_inspection_pending/false/' || tests.id('u-ok')::text, '... status_changed, previous/new status, on_behalf false, actor the driver');
select is((select count(*)::int from public.allocation_events where allocation_id = tests.al('ok') and metadata ->> 'client_submission_id' = tests.id('cs-okpre_inspection_pending')::text), 1, '... the submission id is stored in the event metadata');
select is((select count(*)::int from public.audit_logs where entity_type = 'vehicle_allocations' and action = 'update' and entity_id = tests.al('ok') and reason = 'allocation started'), 1, '... and audited by the DB trigger');
select tests.act_as('u-ok');
select is((select out_replayed from public.transition_allocation(tests.al('ok'), 'pre_inspection_pending', null, tests.id('cs-okpre_inspection_pending'))), true, 'retry with the same submission id: success, replayed');
select tests.reset();
select is(tests.evn('ok'), 1, '... and no second event');
select tests.act_as('u-ok');
select is(tests.tr('ok', 'pre_inspection_pending', null, 'other-csid'), '55000', 'a new submission on an already started allocation is refused');
select is(tests.tr('ok', 'cancelled', 'x', 'okpre_inspection_pending'), '22023', 'the same submission id for a different request is refused');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, 'my_allocations: can_open false once started');
-- window edges (inclusive start, exclusive end), can_open and the transition agree
select tests.act_as('u-early');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, 'too early (90 min before): can_open false');
select is(tests.tr('early', 'pre_inspection_pending'), '55000', '... start refused');
select is(tests.trm('early', 'pre_inspection_pending', null, 'early2') like 'it is too early to start this allocation%from%', true, '... with a plain message naming the time');
select tests.act_as('u-edgeopen');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), true, 'exactly 60 min before: can_open true');
select is(tests.tr('edgeopen', 'pre_inspection_pending'), null, '... start allowed');
select tests.act_as('u-edgeearly');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, '60 min + 1 s before: can_open false');
select is(tests.tr('edgeearly', 'pre_inspection_pending'), '55000', '... start refused');
select tests.act_as('u-endnow');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, 'planned end = now: can_open false');
select is(tests.tr('endnow', 'pre_inspection_pending'), '55000', '... start refused');
select tests.act_as('u-endplus');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), true, 'planned end = now + 1 s: can_open true');
select is(tests.tr('endplus', 'pre_inspection_pending'), null, '... start allowed');
select tests.act_as('u-ended');
select is(tests.tr('ended', 'pre_inspection_pending'), '55000', 'after the planned end: refused');
select is(tests.trm('ended', 'pre_inspection_pending', null, 'ended2') like '%has ended%', true, '... with a plain message');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, '... can_open false');
-- someone else
select tests.act_as('u-oth');
select is(tests.tr('ok', 'cancelled', 'x'), '42501', 'another driver cannot touch this allocation');
select is(tests.tr('early', 'pre_inspection_pending', null, 'oth1'), '42501', 'another driver cannot start it');
select tests.reset();
select is(tests.st('early'), 'planned', '... unchanged');
select tests.reset();
-- inactive driver
update public.drivers set active_status = 'inactive' where id = tests.id('d-u-inact');
select tests.act_as('u-inact');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, 'inactive driver: can_open false');
select is(tests.tr('inact', 'pre_inspection_pending'), '55000', '... start refused');
select is(tests.trm('inact', 'pre_inspection_pending', null, 'inact2'), 'the driver is not active', '... with the 3B message');
-- licence expired / unverified since the allocation was made; both paths
select tests.reset();
alter table public.driver_licences disable trigger driver_licences_immutable;
alter table public.driver_licences disable trigger driver_licences_guard_t;
update public.driver_licences set expiry_date = tests.local_date(now() + interval '8 hours') - 1 where driver_id = tests.id('d-u-licexp');
update public.driver_licences set verification_status = 'recorded', verified_by = null, verified_at = null where driver_id = tests.id('d-u-licunv');
alter table public.driver_licences enable trigger driver_licences_immutable;
alter table public.driver_licences enable trigger driver_licences_guard_t;
select tests.act_as('u-licexp');
select is(tests.tr('licexp', 'pre_inspection_pending'), '23514', 'licence expired since: own start refused');
select is(tests.trm('licexp', 'pre_inspection_pending', null, 'le2') like 'no eligible licence%', true, '... with the 3B message');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, '... can_open false');
select tests.act_as('u-licunv');
select is(tests.tr('licunv', 'pre_inspection_pending'), '23514', 'licence unverified since: own start refused');
select tests.act_as('sup1');
select is(tests.tr('licexp', 'pre_inspection_pending', 'Driver at depot'), '23514', 'licence expired since: on-behalf start refused too');
select is(tests.tr('licunv', 'pre_inspection_pending', 'Driver at depot'), '23514', 'licence unverified since: on-behalf start refused too');
-- shift cancelled since
select tests.reset();
update public.shifts set status = 'cancelled', cancel_reason = 'rain', cancelled_by = tests.id('boot'), cancelled_at = now() where id = tests.id('sh-shcx');
select tests.act_as('u-shcx');
select is(tests.tr('shcx', 'pre_inspection_pending'), '55000', 'shift cancelled since: start refused');
select is(tests.trm('shcx', 'pre_inspection_pending', null, 'sc2') like 'the shift is not scheduled%', true, '... with the 3B message');
select tests.reset();

-- ================================================================ 3. start on the driver's behalf (DEC-40)
select tests.act_as('sup1');
select is(tests.tr('obh', 'pre_inspection_pending', 'Driver phone flat, at the gate'), null, 'allocation.manage holder (A1) starts on behalf with a reason');
select tests.reset();
select is((select opened_on_behalf::text || '/' || opened_by::text from public.vehicle_allocations where id = tests.al('obh')), 'true/' || tests.id('sup1')::text, '... opened_on_behalf true, opened_by the supervisor');
select is((select metadata ->> 'on_behalf' from public.allocation_events where allocation_id = tests.al('obh') and event_type = 'status_changed'), 'true', '... event metadata on_behalf true');
select is((select reason from public.allocation_events where allocation_id = tests.al('obh') and event_type = 'status_changed'), 'Driver phone flat, at the gate', '... reason recorded');
select is((select count(*)::int from public.audit_logs where entity_type = 'vehicle_allocations' and action = 'update' and entity_id = tests.al('obh') and reason = 'Driver phone flat, at the gate'), 1, '... audited with the reason');
select tests.act_as('sup1');
select is(tests.tr('obh2', 'pre_inspection_pending'), '22023', 'on-behalf start without a reason is refused');
select is(tests.tr('obh2', 'pre_inspection_pending', '   ', 'obh2b'), '22023', '... a blank reason too');
select is(tests.tr('obh2', 'pre_inspection_pending', repeat('x', 501), 'obh2c'), '22023', '... and one over 500 characters');
select is(tests.tr('obhearly', 'pre_inspection_pending', 'Early start'), '55000', 'on-behalf start is also limited to the window');
select tests.act_as('sup2');
select is(tests.tr('obh2', 'pre_inspection_pending', 'x', 'obh2d'), '42501', 'supervisor of another branch is refused');
select tests.act_as('ma');
select is(tests.tr('obh2', 'pre_inspection_pending', 'x', 'obh2e'), '42501', 'maintenance admin is refused');
select tests.act_as('sm');
select is(tests.tr('obh2', 'pre_inspection_pending', 'x', 'obh2f'), '42501', 'senior management is refused');
select tests.act_as('sa');
select is(tests.tr('obh2', 'pre_inspection_pending', 'x', 'obh2g'), '42501', 'system admin is refused');
select tests.act_as('fab');
select is(tests.tr('obh2', 'pre_inspection_pending', 'x', 'obh2h'), 'P0002', 'another company: not found');
select tests.act_as('bm1');
select is(tests.tr('obh2', 'pre_inspection_pending', 'Manager sent them'), null, 'branch manager (own branch) may start on behalf');
select tests.act_as('fa');
select is(tests.tr('obh3', 'pre_inspection_pending', 'Fleet admin'), null, 'fleet admin (company-wide) may start on behalf');
select tests.reset();
select is((select count(*)::int from public.vehicle_allocations where opened_on_behalf and id in (tests.al('obh'), tests.al('obh2'), tests.al('obh3'))), 3, 'all three are permanently flagged');
-- the supervisor who is also the driver takes the driver path
select tests.act_as('u-sdrv');
select is(tests.tr('sdrv', 'pre_inspection_pending'), null, 'a supervisor who is the allocation''s driver starts it as the driver, without a reason');
select tests.reset();
select is((select opened_on_behalf from public.vehicle_allocations where id = tests.al('sdrv')), false, '... opened_on_behalf false');
select tests.act_as('u-sdrv');
select is(tests.tr('sdrvother', 'pre_inspection_pending'), '22023', 'the same supervisor starting someone else''s allocation needs a reason (on-behalf path)');
select tests.reset();
-- opened_* immutable afterwards
select is(tests.sqlstate_of($$update public.vehicle_allocations set opened_on_behalf = false where id = tests.al('obh')$$), '23514', 'opened_on_behalf cannot be cleared afterwards');
select is(tests.sqlstate_of($$update public.vehicle_allocations set opened_by = tests.id('sup2') where id = tests.al('obh')$$), '23514', 'opened_by cannot be changed afterwards');
select is(tests.sqlstate_of($$update public.vehicle_allocations set opened_at = now() + interval '1 minute' where id = tests.al('obh')$$), '23514', 'opened_at cannot be changed afterwards');
select set_config('app.allocation_transition', 'on', true);
select is(tests.sqlstate_of($$update public.vehicle_allocations set opened_by = tests.id('sup2') where id = tests.al('obh')$$), '23514', '... even with the transition flag');
select set_config('app.allocation_transition', 'off', true);

-- ================================================================ 4. cancel
select tests.act_as('sup2');
select is(tests.tr('c1', 'cancelled', 'x'), '42501', 'cancel: other branch refused');
select tests.act_as('ma');
select is(tests.tr('c1', 'cancelled', 'x', 'c1b'), '42501', 'cancel: maintenance admin refused');
select tests.act_as('sm');
select is(tests.tr('c1', 'cancelled', 'x', 'c1c'), '42501', 'cancel: senior management refused');
select tests.act_as('sa');
select is(tests.tr('c1', 'cancelled', 'x', 'c1d'), '42501', 'cancel: system admin refused');
select tests.act_as('u-c1');
select is(tests.tr('c1', 'cancelled', 'x', 'c1e'), '42501', 'cancel: the driver is refused');
select tests.act_as('fab');
select is(tests.tr('c1', 'cancelled', 'x', 'c1f'), 'P0002', 'cancel: another company not found');
select tests.act_as('sup1');
select is(tests.tr('c1', 'cancelled'), '22023', 'cancel: reason required');
select is(tests.tr('c1', 'cancelled', ' ', 'c1g'), '22023', '... blank too');
select is(tests.tr('c1', 'cancelled', repeat('x', 501), 'c1h'), '22023', '... and over 500');
select is(tests.st('c1'), 'planned', '... nothing changed');
select is(tests.tr('c1', 'cancelled', 'Vehicle needed elsewhere'), null, 'cancel from planned by allocation.manage');
select is(tests.tr('c2', 'cancelled', 'Driver sick'), null, 'cancel from pre_inspection_pending');
select tests.reset();
select is(tests.st('c1') || '/' || tests.st('c2'), 'cancelled/cancelled', '... both cancelled');
select is((select event_type || '/' || (previous_value ->> 'status') || '/' || (new_value ->> 'status') || '/' || reason from public.allocation_events where allocation_id = tests.al('c1') and event_type <> 'created'), 'cancelled/planned/cancelled/Vehicle needed elsewhere', '... event cancelled with previous/new status and reason');
select tests.act_as('sup1');
select is(tests.tr('tcan', 'cancelled', 'again'), '55000', 'cancel from cancelled refused (terminal)');
select is(tests.tr('tnos', 'cancelled', 'again'), '55000', 'cancel from no_show refused');
select is(tests.tr('inuse', 'cancelled', 'x'), '55000', 'cancel from in_use refused (not in the table)');
select is(tests.trm('tcan', 'cancelled', 'again', 'tc2') like '%can no longer change status', true, '... with a plain message');
-- freed slot: same vehicle and driver can be allocated again for the same shift
select is((select count(*)::int from public.request_allocation(tests.id('sh-c1'), tests.id('v-c1'), tests.id('d-u-c1'), null, null, null, tests.id('cs-realloc1'))), 1, 'a cancelled allocation frees its vehicle and driver: the same slot can be allocated again');
select is((select count(*)::int from public.request_allocation(tests.id('sh-c2'), tests.id('v-c2'), tests.id('d-u-c2'), null, null, null, tests.id('cs-realloc2'))), 1, '... also after cancelling from pre_inspection_pending');

-- ================================================================ 5. no-show
select tests.act_as('sup1');
select is(tests.tr('ns1', 'no_show', 'Did not arrive'), '55000', 'no-show 29 min after the planned start: refused (before the grace)');
select is(tests.trm('ns1', 'no_show', 'Did not arrive', 'ns1b') like 'a no-show can only be recorded from%', true, '... with a plain message');
select is(tests.tr('ns2', 'no_show', 'Did not arrive'), null, 'no-show exactly at planned start + 30 min: allowed');
select is(tests.tr('ns3', 'no_show'), '22023', 'no-show: reason required');
select is(tests.tr('ns3', 'no_show', 'Did not arrive'), null, 'no-show 31 min after: allowed');
select is(tests.tr('ns5', 'no_show', 'Did not arrive'), '55000', 'no-show from planned: refused (not in the table)');
select tests.act_as('sup2');
select is(tests.tr('ns4', 'no_show', 'x'), '42501', 'no-show: other branch refused');
select tests.act_as('u-ns4');
select is(tests.tr('ns4', 'no_show', 'x', 'ns4b'), '42501', 'no-show: the driver is refused');
select tests.act_as('ma');
select is(tests.tr('ns4', 'no_show', 'x', 'ns4c'), '42501', 'no-show: maintenance admin refused');
select tests.act_as('sup1');
select is(tests.tr('ns2', 'no_show', 'again', 'ns2b'), '55000', 'no-show from no_show refused');
select tests.reset();
select is(tests.st('ns2') || '/' || tests.st('ns3'), 'no_show/no_show', 'no-shows recorded');
select tests.act_as('sup1');
select is((select count(*)::int from public.request_allocation(tests.id('sh-ns2'), tests.id('v-ns2'), tests.id('d-u-ns2'), null, null, null, tests.id('cs-realloc3'))), 1, 'a no-show frees its vehicle and driver for the same period');

-- ================================================================ 6. not yet available (Phase 4 / 5): 0A000, nothing changes
select tests.act_as('sup1');
select is(tests.tr('c4', 'in_use'), '55000', 'planned -> in_use is outside the table');
select tests.reset();
update public.vehicle_allocations set opened_at = null where false;
select set_config('app.allocation_transition', 'on', true);
update public.vehicle_allocations set status = 'pre_inspection_pending', opened_at = now(), opened_by = tests.id('sup1') where id = tests.al('c5');
select set_config('app.allocation_transition', 'off', true);
select tests.act_as('sup1');
select is(tests.tr('c5', 'in_use'), '0A000', '(d) pre_inspection_pending -> in_use: 0A000');
select is(tests.trm('c5', 'in_use', null, 'd2') like '%pre-shift inspection — available from Phase 4%', true, '... names Phase 4');
select is(tests.tr('inuse', 'post_inspection_pending'), '0A000', '(e) in_use -> post_inspection_pending: 0A000');
select is(tests.trm('inuse', 'post_inspection_pending', null, 'e2') like '%post-shift inspection flow — available from Phase 4%', true, '... names Phase 4');
select is(tests.tr('post', 'closed'), '0A000', '(f) post_inspection_pending -> closed: 0A000');
select is(tests.tr('post', 'closed_with_exceptions'), '0A000', '(f) post_inspection_pending -> closed_with_exceptions: 0A000');
select is(tests.tr('cwe', 'closed'), '0A000', '(f) closed_with_exceptions -> closed: 0A000');
select is(tests.trm('post', 'closed', null, 'f2') like '%closure rules — available from Phase 5%', true, '... names Phase 5');
select is(tests.st('c5') || '/' || tests.st('inuse') || '/' || tests.st('post') || '/' || tests.st('cwe'), 'pre_inspection_pending/in_use/post_inspection_pending/closed_with_exceptions', '... no status changed');
select is(tests.evn('inuse') + tests.evn('post') + tests.evn('cwe'), 0, '... and no events were written');
select is(tests.sqlstate_of($$select public.release_allocation(tests.al('inuse'), 'x', gen_random_uuid())$$), '0A000', 'release_allocation is a stub: 0A000');
select tests.act_as('sup2');
select is(tests.tr('post', 'closed', null, 'f3'), '42501', 'future-phase transitions still check who is asking (other branch)');
select tests.reset();
select is(public.allocation_closure_blockers(tests.al('post')), array['closure_not_available'], 'allocation_closure_blockers returns {closure_not_available}');
select is((select count(*)::int from public.vehicle_allocations where started_at is not null or released_at is not null), 0, 'started_at / released_at are never set in 3C');

-- ================================================================ 7. amend planned times
select tests.act_as('sup1');
select is(tests.am('am1', now() + interval '3 days 2 hours', now() + interval '3 days 6 hours'), null, 'extend within the shift window');
select tests.reset();
select is((select (new_value ->> 'planned_end_at')::timestamptz from public.allocation_events where allocation_id = tests.al('am1') and event_type = 'amended'), now() + interval '3 days 6 hours', '... an amended event holds the new times');
select is((select (previous_value ->> 'planned_end_at')::timestamptz from public.allocation_events where allocation_id = tests.al('am1') and event_type = 'amended'), now() + interval '3 days 4 hours', '... and the previous times');
select is((select upper(active_period) from public.vehicle_allocations where id = tests.al('am1')), now() + interval '3 days 6 hours', '... the active period follows');
select is(tests.st('am1'), 'planned', '... status unchanged');
select tests.act_as('sup1');
select is(tests.am('am1', now() + interval '3 days 3 hours', now() + interval '3 days 5 hours', 'Shorter'), null, 'shorten within the window');
select is(tests.am('am1', now() + interval '3 days 3 hours', now() + interval '3 days 5 hours', 'Shorter', 'am1-again'), '22023', 'nothing to change is refused');
select is(tests.am('am1', now() + interval '2 days 23 hours', now() + interval '3 days 5 hours'), '22023', 'start before the shift window is refused');
select is(tests.am('am1', now() + interval '3 days 3 hours', now() + interval '3 days 13 hours'), '22023', 'end after the shift window is refused');
select is(tests.am('am1', now() + interval '3 days 5 hours', now() + interval '3 days 3 hours'), '22023', 'end before start is refused');
select is(tests.am('am1', now() + interval '3 days 3 hours', now() + interval '3 days 6 hours', '   '), '22023', 'reason required');
select is(tests.am('am5', now() + interval '3 days 2 hours', now() + interval '3 days 6 hours 30 minutes'), '23P01', 'overlap with another allocation of the same vehicle is refused');
select is(tests.msg_of(format('select * from public.amend_allocation_times(%L, %L, %L, %L, %L)', tests.al('am5'), now() + interval '3 days 2 hours', now() + interval '3 days 7 hours', 'x', gen_random_uuid())), 'vehicle already allocated during that period', '... with the 3B message');
select is(tests.am('am6', now() + interval '3 days 2 hours', now() + interval '3 days 6 hours 30 minutes'), '23P01', 'overlap with another allocation of the same driver is refused');
select is(tests.msg_of(format('select * from public.amend_allocation_times(%L, %L, %L, %L, %L)', tests.al('am6'), now() + interval '3 days 2 hours', now() + interval '3 days 7 hours', 'x', gen_random_uuid())), 'driver already allocated during that period', '... with the 3B message');
select is(tests.am('am5', now() + interval '3 days 2 hours', now() + interval '3 days 5 hours 59 minutes'), null, 'ending just before the neighbour is fine (no self-conflict either)');
select is(tests.am('am2', now() + interval '3 days 2 hours', now() + interval '3 days 5 hours'), null, 'amend after the allocation was opened (pre_inspection_pending) is allowed');
select is(tests.am('am3', now() + interval '3 days 2 hours', now() + interval '3 days 5 hours'), '55000', 'amend on a cancelled allocation is refused');
select is(tests.am('am4', now() + interval '3 days 2 hours', now() + interval '3 days 5 hours'), '55000', 'amend on an in_use allocation is refused');
select tests.reset();
select is((select count(*)::int from public.allocation_events where allocation_id = tests.al('am1') and event_type = 'amended'), 2, 'amended events: one per amendment (am1: extend, shorten)');
-- licence for the new period
select tests.act_as('sup1');
select is(tests.am('lic', (select planned_start_at from public.vehicle_allocations where id = tests.al('lic')), (select planned_start_at + interval '8 hours' from public.vehicle_allocations where id = tests.al('lic')), 'Run later'), '23514', 'a licence that does not cover the new end date (past midnight) refuses the amendment');
select is(tests.am('lic', (select planned_start_at from public.vehicle_allocations where id = tests.al('lic')), (select planned_start_at + interval '4 hours' from public.vehicle_allocations where id = tests.al('lic')), 'Run a bit longer'), null, '... while an end on the licence''s last day is fine');
-- who may amend
select tests.act_as('sup2');
select is(tests.am('am6', now() + interval '3 days 2 hours', now() + interval '3 days 3 hours'), '42501', 'amend: other branch refused');
select tests.act_as('ma');
select is(tests.am('am6', now() + interval '3 days 2 hours', now() + interval '3 days 3 hours'), '42501', 'amend: maintenance admin refused');
select tests.act_as('sm');
select is(tests.am('am6', now() + interval '3 days 2 hours', now() + interval '3 days 3 hours'), '42501', 'amend: senior management refused');
select tests.act_as('u-am6');
select is(tests.am('am6', now() + interval '3 days 2 hours', now() + interval '3 days 3 hours'), '42501', 'amend: the driver is refused');
select tests.act_as('fab');
select is(tests.am('am6', now() + interval '3 days 2 hours', now() + interval '3 days 3 hours'), 'P0002', 'amend: another company not found');
select tests.act_as('sup1');
select is((select out_replayed from public.amend_allocation_times(tests.al('am1'), now() + interval '3 days 3 hours', now() + interval '3 days 5 hours', 'Shorter', tests.id('cs-' || 'am1' || (now() + interval '3 days 3 hours')::text || (now() + interval '3 days 5 hours')::text))), true, 'amend retry with the same submission id: replayed');
select tests.reset();
select is((select count(*)::int from public.allocation_events where allocation_id = tests.al('am1') and event_type = 'amended'), 2, '... no extra event');


-- ================================================================ 7b. amend_eligibility (the dry run behind the dialog)
select tests.act_as('sup1');
select is((select ok from public.amend_eligibility(tests.al('am5'), now() + interval '3 days 2 hours', now() + interval '3 days 5 hours')), true, 'amend_eligibility: ok for a free period');
select is((select block_reasons from public.amend_eligibility(tests.al('am5'), now() + interval '3 days 2 hours', now() + interval '3 days 7 hours')), array['vehicle_conflict'], '... reports the overlap without writing anything');
select is((select block_reasons from public.amend_eligibility(tests.al('am3'), now() + interval '3 days 2 hours', now() + interval '3 days 5 hours')), array['status_not_amendable'], '... and a status that cannot be amended');
select is(tests.sqlstate_of($$select * from public.amend_eligibility(tests.al('am5'), now(), now())$$), '22023', '... invalid times: 22023');
select tests.act_as('sup2');
select is(tests.sqlstate_of($$select * from public.amend_eligibility(tests.al('am5'), now() + interval '3 days 2 hours', now() + interval '3 days 5 hours')$$), '42501', '... other branch refused');
select tests.act_as('fab');
select is(tests.sqlstate_of($$select * from public.amend_eligibility(tests.al('am5'), now() + interval '3 days 2 hours', now() + interval '3 days 5 hours')$$), 'P0002', '... other company not found');
select tests.reset();

-- ================================================================ 8. my_allocations
select tests.act_as('u-ok');
select is((select count(*)::int from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), 1, 'driver sees only their own allocation');
select is((select count(*)::int from public.my_allocations(now() - interval '1 day', now() + interval '1 day') where allocation_id <> tests.al('ok')), 0, '... no one else''s');
select is(tests.sqlstate_of($$select * from public.my_allocations(now(), now() + interval '14 days 1 second')$$), '22023', 'a range over 14 days is refused');
select is(tests.sqlstate_of($$select * from public.my_allocations(now(), now() + interval '14 days')$$), null, '... exactly 14 days is fine');
select is(tests.sqlstate_of($$select * from public.my_allocations(now(), now())$$), '22023', '... an empty range is refused');
select is((select to_jsonb(m)::text like '%SYN-%' or to_jsonb(m)::text like '%E-EARLY%' or to_jsonb(m)::text like '%Synthetic u-early%' from public.my_allocations(now() - interval '1 day', now() + interval '1 day') m limit 1), false, 'no licence number and no other driver''s data in the output');
select is((select count(*)::int from pg_proc p, unnest(p.proargnames) n where p.oid = 'public.my_allocations(timestamptz, timestamptz)'::regprocedure and (n like '%licence_number%' or n like '%employee%' or n like '%driver%')), 0, '... the function exposes no licence-number / employee / driver columns');
select is((select opened_on_behalf from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), false, 'opened_on_behalf shown (false here)');
select tests.act_as('u-obh');
select is((select opened_on_behalf from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), true, '... and true for an on-behalf start');
select tests.act_as('u-c1');
select is((select status from public.my_allocations(now() - interval '1 day', now() + interval '1 day') where allocation_id = tests.al('c1')), 'cancelled', 'a cancelled allocation shows as cancelled');
select is((select can_open from public.my_allocations(now() - interval '1 day', now() + interval '1 day') where allocation_id = tests.al('c1')), false, '... and cannot be opened');
select tests.act_as('u-coB1');
select is((select count(*)::int from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), 1, 'a driver of another company sees only their own');
select tests.act_as('sup1');
select is((select count(*)::int from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), 0, 'a staff user who is not a driver sees none');
select tests.reset();
select tests.act_as('u-ok');
select is((select vehicle_fleet_number || '/' || vehicle_registration || '/' || vehicle_make || '/' || vehicle_model || '/' || branch_name from public.my_allocations(now() - interval '1 day', now() + interval '1 day')), 'FL-ok/T3COK/Make/Model/A one', 'the card data: vehicle and branch');
select tests.reset();
set local role anon;
select is(tests.sqlstate_of($$select * from public.my_allocations(now(), now() + interval '1 day')$$), '42501', 'anon cannot call my_allocations');
select tests.reset();

-- ================================================================ 9. settings: one place
select is((select open_before_start_minutes || '/' || no_show_grace_minutes from public.allocation_settings(tests.id('coA'))), '60/30', 'defaults: 60 minutes before start, 30 minutes no-show grace');
select is(public.allocation_start_window_open(now() + interval '60 minutes', now() + interval '9 hours', now(), 60), true, 'rule with explicit settings: 60 -> open at exactly 60 min before');
select is(public.allocation_start_window_open(now() + interval '90 minutes', now() + interval '9 hours', now(), 60), false, '... 90 min before is too early at 60');
select is(public.allocation_start_window_open(now() + interval '90 minutes', now() + interval '9 hours', now(), 120), true, '... but open at 120: the setting moves the window');
select is(public.allocation_no_show_allowed(now() - interval '30 minutes', now(), 30), true, 'no-show rule with 30: allowed at exactly +30');
select is(public.allocation_no_show_allowed(now() - interval '20 minutes', now(), 30), false, '... refused at +20');
select is(public.allocation_no_show_allowed(now() - interval '20 minutes', now(), 15), true, '... allowed at +20 when the grace is 15');
-- the transition functions read the settings (nothing hard-coded): swap the one function inside this transaction
drop function public.allocation_settings(uuid);
create function public.allocation_settings(p_company_id uuid) returns table (open_before_start_minutes integer, no_show_grace_minutes integer, pre_shift_late_minutes integer, post_shift_late_minutes integer)
language sql stable set search_path = '' as $$ select 120, 10, 30, 60 $$;
revoke all on function public.allocation_settings(uuid) from public, anon, authenticated;
select tests.sc('set1', 'A1', now() + interval '100 minutes', now() + interval '9 hours');
select tests.sc('set2', 'A1', now() - interval '12 minutes', now() + interval '9 hours', 'pre_inspection_pending');
select tests.act_as('u-set1');
select is(tests.tr('set1', 'pre_inspection_pending'), null, 'with open_before = 120, a start 100 min before succeeds');
select tests.act_as('sup1');
select is(tests.tr('set2', 'no_show', 'Did not arrive'), null, 'with grace = 10, a no-show 12 min after the start succeeds');
select tests.reset();

-- ================================================================ 10. privileges, append-only, no deletes
select is(has_function_privilege('anon', 'public.transition_allocation(uuid, text, text, uuid)', 'execute'), false, 'anon cannot call transition_allocation');
select is(has_function_privilege('anon', 'public.amend_allocation_times(uuid, timestamptz, timestamptz, text, uuid)', 'execute'), false, 'anon cannot call amend_allocation_times');
select is(has_function_privilege('anon', 'public.release_allocation(uuid, text, uuid)', 'execute'), false, 'anon cannot call release_allocation');
select is(has_function_privilege('authenticated', 'public.transition_allocation(uuid, text, text, uuid)', 'execute'), true, 'authenticated can call transition_allocation');
select is(has_function_privilege('authenticated', 'public.amend_allocation_times(uuid, timestamptz, timestamptz, text, uuid)', 'execute'), true, '... amend_allocation_times');
select is(has_function_privilege('authenticated', 'public.my_allocations(timestamptz, timestamptz)', 'execute'), true, '... my_allocations');
select is(has_function_privilege('authenticated', 'public.allocation_start_blockers(uuid, timestamptz)', 'execute'), false, 'allocation_start_blockers is internal');
select is(has_function_privilege('authenticated', 'public.allocation_closure_blockers(uuid)', 'execute'), false, 'allocation_closure_blockers is internal');
select is(has_function_privilege('authenticated', 'public.allocation_settings(uuid)', 'execute'), false, 'allocation_settings is internal');
select is(has_function_privilege('authenticated', 'public.allocation_transition_allowed(text, text)', 'execute'), false, 'allocation_transition_allowed is internal');
select is(has_function_privilege('authenticated', 'public.allocation_eligibility_core(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid)', 'execute'), false, 'the 7-argument eligibility core is internal');
select is(has_function_privilege('authenticated', 'public.va_lifecycle_guard()', 'execute'), false, 'the guard trigger function is not callable');
select is(tests.sqlstate_of($$update public.allocation_events set reason = 'x'$$), '42501', 'allocation_events: UPDATE refused (append-only, owner included)');
select is(tests.sqlstate_of($$delete from public.allocation_events$$), '42501', '... DELETE refused');
select is(tests.sqlstate_of($$truncate public.allocation_events$$), '42501', '... TRUNCATE refused');
select isnt(tests.sqlstate_of($$delete from public.vehicle_allocations$$), null, 'vehicle_allocations: DELETE refused');
select isnt(tests.sqlstate_of($$truncate public.vehicle_allocations$$), null, '... TRUNCATE refused');
select is((select count(*)::int from public.audit_logs where entity_type = 'vehicle_allocations' and action = 'update' and company_id = tests.id('coA')) >= 10, true, 'audit rows are written for lifecycle changes');
select is((select count(*)::int from public.allocation_events e where event_type in ('status_changed', 'cancelled') and not exists (select 1 from public.audit_logs a where a.entity_id = e.allocation_id and a.action = 'update')), 0, 'every status event has a matching audit row');

select * from finish();
rollback;
