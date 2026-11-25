-- Slice 4D pgTAP: missing / late detection — inspection_due_status at its edges, list_overdue_inspections (live, permissions, no names),
-- run_inspection_watch (idempotent, resolves, service_role only), inspection_watch_findings (RLS, no delete, audit). Migration 049.
-- PRD v1.18 §5.7; DEC-17, DEC-43. Synthetic data only; rolls back.
-- Scenario label L: driver u-L, vehicle FL-L, allocation al-L (see tests.sc).
begin;
create extension if not exists pgtap with schema extensions;
select plan(69);


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
create function tests.err_of(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlstate || ':' || sqlerrm; end $$;
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
  select tests.grant_role(n, 'driver', branch, case when comp = 'coB' then 'bootb' else 'boot' end);
$$;
-- an evidence file (as if registered): n = label, uploader = profile label
create function tests.mk_file(n text, uploader text, branch text, purpose text default 'odometer', src text default 'in_app_camera') returns void language sql as $$
  insert into public.evidence_files (id, company_id, branch_id, bucket, object_path, sha256, mime_type, size_bytes, capture_source, exif_gps_stripped, uploaded_by, purpose)
  select tests.id('f-' || n), p.company_id, tests.id(branch), 'evidence', 'test/' || n, md5(n) || md5(n), 'image/jpeg', 1000, src, true, p.id, purpose
    from public.profiles p where p.id = tests.id(uploader);
$$;
-- one scenario: driver + vehicle + shift + allocation in the given status + the two odometer files
create function tests.sc(label text, branch text, astatus text, shift_s timestamptz, shift_e timestamptz,
                         planned_e timestamptz default null, category text default 'bakkie') returns void language plpgsql as $$
declare comp text := case when branch = 'B1' then 'coB' else 'coA' end; booter text := case when branch = 'B1' then 'bootb' else 'boot' end;
begin
  perform tests.mk_driver('u-' || label, comp, 'E-' || upper(label), branch);
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('v-' || label), tests.id(comp), tests.id(branch), 'FL-' || label, upper('T4A' || label), 'Make', 'Model', category);
  insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('sh-' || label), tests.id(comp), tests.id(branch), (shift_s at time zone 'Africa/Johannesburg')::date, shift_s, shift_e, gen_random_uuid(), tests.id(booter));
  insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, status, started_at,
                                          opened_at, opened_by, licence_class_check, client_submission_id, created_by)
  values (tests.id('al-' || label), tests.id(comp), tests.id(branch), tests.id('v-' || label), tests.id('d-u-' || label), tests.id('sh-' || label),
          shift_s, coalesce(planned_e, shift_e), astatus, case when astatus in ('in_use', 'post_inspection_pending') then shift_s end,
          case when astatus <> 'planned' then shift_s end, case when astatus <> 'planned' then tests.id('u-' || label) end, 'matched', gen_random_uuid(), tests.id(booter));
  perform tests.mk_file('fo-' || label || '-pre', 'u-' || label, branch);
  perform tests.mk_file('fo-' || label || '-post', 'u-' || label, branch);
end $$;
create function tests.al(l text) returns uuid language sql immutable as $$ select tests.id('al-' || l) $$;
create function tests.ins(l text, stage text default 'pre_shift') returns uuid language sql stable as $$
  select id from public.inspections where allocation_id = tests.al(l) and inspection_stage = stage and status <> 'void' $$;
create function tests.item(k text, comp text default 'coA') returns uuid language sql stable as $$
  select i.id from public.inspection_template_items i join public.inspection_templates t on t.id = i.template_id
   where t.company_id = tests.id(comp) and t.vehicle_category is null and i.item_key = k $$;
-- every item of the stage answered "fine"
create function tests.answers(stage text, comp text default 'coA') returns jsonb language sql stable as $$
  select jsonb_agg(jsonb_build_object('template_item_id', i.id, 'value', case i.response_type when 'ok_defect' then 'ok' when 'fuel_quarter' then '1/2' else 'no' end) order by i.sequence)
    from public.inspection_template_items i join public.inspection_templates t on t.id = i.template_id
   where t.company_id = tests.id(comp) and t.vehicle_category is null and i.applies_to_stage = stage $$;
create function tests.ans(k text, v text, c text default null) returns jsonb language sql stable as $$
  select jsonb_build_object('template_item_id', tests.item(k), 'value', v, 'comment', c) $$;
create function tests.csid(n text) returns uuid language sql immutable as $$ select md5('cs-' || n)::uuid $$;
-- as the driver (caller does act_as): begin + answer everything + confirm vehicle + odometer photo => ready to submit
create function tests.prep(label text, stage text default 'pre_shift') returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.begin_inspection(tests.al(label), stage, null, false, tests.csid(label || stage || 'b'));
  perform public.save_inspection_responses(v, tests.answers(stage), true, tests.csid(label || stage || 's'));
  perform public.confirm_known_damage_reviewed(v, tests.csid(label || stage || 'k'));
  perform public.attach_odometer_photo(v, tests.id('f-fo-' || label || '-' || case stage when 'pre_shift' then 'pre' else 'post' end), tests.csid(label || stage || 'o'));
  perform public.record_driver_reading(v, 1000, null, false, gen_random_uuid());
  return v;
end $$;
create function tests.submit(label text, stage text default 'pre_shift', c text default null) returns text language sql as $$
  select tests.err_of(format('select * from public.submit_inspection(%L, null, false, %L)', tests.ins(label, stage), tests.csid(coalesce(c, label || stage || 'x')))) $$;
-- (post-shift) answer everything except the incident question (set by the caller) and attach the odometer photo
create function tests.prep_rest(label text) returns void language plpgsql as $$
begin
  perform public.save_inspection_responses(tests.ins(label, 'post_shift'),
    (select jsonb_agg(e) from jsonb_array_elements(tests.answers('post_shift')) e where e ->> 'template_item_id' <> tests.item('post_incident')::text), true, tests.csid(label || 'rest'));
  perform public.attach_odometer_photo(tests.ins(label, 'post_shift'), tests.id('f-fo-' || label || '-post'), tests.csid(label || 'resto'));
  perform public.record_driver_reading(tests.ins(label, 'post_shift'), 1000, null, false, gen_random_uuid());
  perform public.confirm_known_damage_reviewed(tests.ins(label, 'post_shift'), tests.csid(label || 'restk'));
end $$;
create function tests.n(q text) returns integer language plpgsql as $$
declare r integer; begin execute q into r; return r; end $$;

-- ---------------------------------------------------------------- fixtures
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('fa', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'),
       tests.mk_user('ma', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('fab', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sup2', 'supervisor', 'A2', 'boot'),
       tests.grant_role('ma', 'maintenance_admin', null, 'boot'), tests.grant_role('sa', 'system_admin', null, 'boot'),
       tests.grant_role('fab', 'fleet_admin', null, 'bootb');
select public.seed_starter_inspection_template(tests.id('coA')), public.seed_starter_inspection_template(tests.id('coB'));

-- pre-shift: the allocation's planned start is 29 / 30 / 31 minutes ago
select tests.sc('o29', 'A1', 'pre_inspection_pending', now() - interval '29 minutes', now() + interval '9 hours');
select tests.sc('o30', 'A1', 'pre_inspection_pending', now() - interval '30 minutes', now() + interval '9 hours');
select tests.sc('o31', 'A1', 'pre_inspection_pending', now() - interval '31 minutes', now() + interval '9 hours');
select tests.sc('o31p', 'A1', 'planned', now() - interval '31 minutes', now() + interval '9 hours');
select tests.sc('fut', 'A1', 'planned', now() + interval '2 hours', now() + interval '9 hours');
select tests.sc('cx', 'A1', 'cancelled', now() - interval '3 hours', now() + interval '9 hours');
select tests.sc('ns', 'A1', 'no_show', now() - interval '3 hours', now() + interval '9 hours');
-- post-shift: the allocation's planned end is 59 / 60 / 61 minutes ago
select tests.sc('q59', 'A1', 'in_use', now() - interval '9 hours', now() + interval '1 hour', now() - interval '59 minutes');
select tests.sc('q60', 'A1', 'in_use', now() - interval '9 hours', now() + interval '1 hour', now() - interval '60 minutes');
select tests.sc('q61', 'A1', 'in_use', now() - interval '9 hours', now() + interval '1 hour', now() - interval '61 minutes');
select tests.sc('a2', 'A2', 'pre_inspection_pending', now() - interval '2 hours', now() + interval '9 hours');
select tests.sc('b1', 'B1', 'pre_inspection_pending', now() - interval '2 hours', now() + interval '9 hours');

create function tests.listed(p_branch uuid default null) returns text language sql stable as $$
  select coalesce(string_agg(vehicle_fleet_number || ':' || inspection_stage, ',' order by vehicle_fleet_number, inspection_stage), '')
    from public.list_overdue_inspections(p_branch) where kind = 'overdue' $$;

-- ================================================================ 1. the pure rule, at its edges
select is(public.inspection_due_status('pre_shift', 'pre_inspection_pending', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 08:29+02', 30, 60), 'due_now', 'pre 29 min after the planned start: due_now');
select is(public.inspection_due_status('pre_shift', 'pre_inspection_pending', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 08:30+02', 30, 60), 'due_now', 'pre 30 min: still due_now (strict)');
select is(public.inspection_due_status('pre_shift', 'pre_inspection_pending', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 08:31+02', 30, 60), 'overdue', 'pre 31 min: overdue');
select is(public.inspection_due_status('pre_shift', 'planned', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 08:31+02', 30, 60), 'overdue', 'pre 31 min, allocation still planned: overdue');
select is(public.inspection_due_status('pre_shift', 'planned', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 07:59+02', 30, 60), 'not_due', 'pre before the planned start: not_due');
select is(public.inspection_due_status('post_shift', 'in_use', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 16:59+02', 30, 60), 'due_now', 'post 59 min after the planned end: due_now');
select is(public.inspection_due_status('post_shift', 'in_use', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 17:00+02', 30, 60), 'due_now', 'post 60 min: still due_now (strict)');
select is(public.inspection_due_status('post_shift', 'in_use', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 17:01+02', 30, 60), 'overdue', 'post 61 min: overdue');
select is(public.inspection_due_status('post_shift', 'post_inspection_pending', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 17:01+02', 30, 60), 'overdue', 'post 61 min, post_inspection_pending: overdue');
select is(public.inspection_due_status('post_shift', 'in_use', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 15:00+02', 30, 60), 'not_due', 'post before the planned end: not_due');
select is(public.inspection_due_status('post_shift', 'pre_inspection_pending', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-02 08:00+02', 30, 60), 'not_due', 'post while the vehicle was never started: not_due (the pre-shift is the missing one)');
select is(public.inspection_due_status('pre_shift', 'in_use', '2026-01-01 08:00+02', '2026-01-01 16:00+02', '2026-01-01 08:30+02', '2026-01-01 20:00+02', 30, 60), 'submitted', 'pre submitted exactly 30 min after the planned start: submitted (not late)');
select is(public.inspection_due_status('pre_shift', 'in_use', '2026-01-01 08:00+02', '2026-01-01 16:00+02', '2026-01-01 08:31+02', '2026-01-01 20:00+02', 30, 60), 'submitted_late', 'pre submitted 31 min after the planned start: submitted_late');
select is(public.inspection_due_status('post_shift', 'post_inspection_pending', '2026-01-01 08:00+02', '2026-01-01 16:00+02', '2026-01-01 17:00+02', '2026-01-02 08:00+02', 30, 60), 'submitted', 'post submitted exactly 60 min after the planned end: submitted');
select is(public.inspection_due_status('post_shift', 'post_inspection_pending', '2026-01-01 08:00+02', '2026-01-01 16:00+02', '2026-01-01 17:01+02', '2026-01-02 08:00+02', 30, 60), 'submitted_late', 'post submitted 61 min after the planned end: submitted_late');
select is(public.inspection_due_status('pre_shift', 'cancelled', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-02 08:00+02', 30, 60), 'not_applicable', 'cancelled: not_applicable');
select is(public.inspection_due_status('post_shift', 'no_show', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-02 08:00+02', 30, 60), 'not_applicable', 'no_show: not_applicable');
select is(public.inspection_due_status('pre_shift', 'closed', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-02 08:00+02', 30, 60), 'not_applicable', 'closed with no pre-shift inspection: not_applicable (nothing to chase)');
select is(public.inspection_due_status('pre_shift', 'cancelled', '2026-01-01 08:00+02', '2026-01-01 16:00+02', '2026-01-01 08:10+02', '2026-01-02 08:00+02', 30, 60), 'not_applicable', 'cancelled wins over a submitted inspection');
select is(public.inspection_due_status('pre_shift', 'pre_inspection_pending', '2026-01-01 08:00+02', '2026-01-01 16:00+02', null, '2026-01-01 08:16+02', 15, 60), 'overdue', 'the windows come from the arguments (settings), not constants');
select ok(public.inspection_due_status('mid_shift', 'in_use', now(), now(), null, now(), 30, 60) is null, 'an unknown stage returns NULL');

-- ================================================================ 2. the live list
select tests.act_as('sup1');
select is(tests.listed(), 'FL-o31:pre_shift,FL-o31p:pre_shift,FL-q61:post_shift', 'live list (A1 supervisor): 31 min pre (both statuses) and 61 min post; 29/30/59/60, future, cancelled, no-show and other branches are absent');
select is((select count(*)::int from public.list_overdue_inspections() where kind = 'overdue' and minutes_overdue >= 0 and due_by is not null and planned_at is not null), 3, 'every overdue row carries planned time, due-by and minutes overdue');
select is((select min(minutes_overdue) from public.list_overdue_inspections() where vehicle_fleet_number = 'FL-o31'), 1, 'o31 is 1 whole minute past the window (31 min after the start, window 30)');
select is((select allocation_status from public.list_overdue_inspections() where vehicle_fleet_number = 'FL-q61'), 'in_use', 'the allocation status is shown');
select is(tests.listed(tests.id('A2')), '', 'filter by another branch the supervisor does not manage: empty');
select tests.act_as('sup2');
select is(tests.listed(), 'FL-a2:pre_shift', 'a supervisor of A2 sees only A2');
select tests.act_as('fa');
select is(tests.listed(), 'FL-a2:pre_shift,FL-o31:pre_shift,FL-o31p:pre_shift,FL-q61:post_shift', 'a company-wide fleet administrator sees every branch of the company, never another company');
select is(tests.listed(tests.id('A2')), 'FL-a2:pre_shift', 'branch filter');
select tests.act_as('ma');
select is(tests.listed(), 'FL-a2:pre_shift,FL-o31:pre_shift,FL-o31p:pre_shift,FL-q61:post_shift', 'a maintenance administrator reads the list through reports.view');
select throws_ok(format('select public.resolve_sync_conflict(%L, ''x'', %L)', gen_random_uuid(), gen_random_uuid()), 'P0002', null, 'a maintenance administrator cannot resolve (read-only)');
select tests.act_as('sa');
select is(tests.listed(), '', 'a system administrator sees nothing (no allocation.manage, no reports.view)');
select tests.act_as('u-o31');
select is(tests.listed(), '', 'a driver sees nothing');
select tests.act_as('fab');
select is(tests.listed(), 'FL-b1:pre_shift', 'another company sees only its own');
select tests.reset();
select ok(pg_get_function_result('public.list_overdue_inspections(uuid)'::regprocedure) !~* 'driver|employee|display|profile', 'the list returns no driver identity (DEC-41)');
select is(has_function_privilege('anon', 'public.list_overdue_inspections(uuid)', 'execute'), false, 'anon cannot call the list');
select is(has_function_privilege('authenticated', 'public.inspection_due_status(text,text,timestamptz,timestamptz,timestamptz,timestamptz,integer,integer)', 'execute'), false, 'the rule function is internal (no client grant)');

-- ================================================================ 3. the job body
select is(has_function_privilege('service_role', 'public.run_inspection_watch(uuid, timestamptz)', 'execute'), true, 'service_role can run the watch');
select is(has_function_privilege('authenticated', 'public.run_inspection_watch(uuid, timestamptz)', 'execute'), false, 'authenticated cannot run the watch');
select is(has_function_privilege('anon', 'public.run_inspection_watch(uuid, timestamptz)', 'execute'), false, 'anon cannot run the watch');
select tests.act_as('fa');
select is(tests.sqlstate_of(format('select public.run_inspection_watch(%L)', tests.id('coA'))), '42501', 'a signed-in fleet administrator calling the watch is refused');
select tests.reset();
select is((select public.run_inspection_watch(tests.id('coA')) ->> 'inserted')::int, 4, 'first run records the four overdue inspections of the company (o31 pre, o31p pre, q61 post, a2 pre)');
select is((select public.run_inspection_watch(tests.id('coA')) ->> 'inserted')::int, 0, 'running it again records nothing (once)');
select is((select count(*)::int from public.inspection_watch_findings where company_id = tests.id('coA')), 4, 'four findings, none duplicated');
select is((select count(*)::int from public.inspection_watch_findings where company_id = tests.id('coB')), 0, 'the other company was not scanned');
select is((select count(*)::int from public.inspection_watch_findings where resolved_at is not null), 0, 'none resolved yet');
select is((select count(*)::int from public.audit_logs where entity_type = 'inspection_watch_findings' and action = 'insert'), 4, 'audit rows are written for the findings');

-- the driver submits late: the finding resolves as submitted_late; the next run changes nothing
select tests.act_as('u-o31');
select tests.prep('o31');
select is(tests.submit('o31'), null, 'the late pre-shift inspection is accepted');
select tests.reset();
select is((select public.run_inspection_watch(tests.id('coA')) ->> 'resolved')::int, 1, 'the watch resolves the submitted inspection');
select is((select resolution from public.inspection_watch_findings where allocation_id = tests.al('o31') and inspection_stage = 'pre_shift'), 'submitted_late', 'resolution = submitted_late');
select is((select count(*)::int from public.inspection_watch_findings where allocation_id = tests.al('o31') and resolved_at is null), 0, 'resolved_at is set');
select is((select public.run_inspection_watch(tests.id('coA')) ->> 'resolved')::int, 0, 'resolving is idempotent');
select tests.act_as('sup1');
select is(tests.listed(), 'FL-o31p:pre_shift,FL-q61:post_shift', 'the live list drops the submitted inspection');
-- the supervisor cancels the other planned one: resolution not_applicable
select ok(exists (select 1 from public.transition_allocation(tests.al('o31p'), 'cancelled', 'synthetic cancel', tests.csid('cxl'))), 'a supervisor cancels the planned allocation');
select tests.reset();
select is((select public.run_inspection_watch(tests.id('coA')) ->> 'resolved')::int, 1, 'cancelling resolves its finding');
select is((select resolution from public.inspection_watch_findings where allocation_id = tests.al('o31p')), 'not_applicable', 'resolution = not_applicable');
select is((select count(*)::int from public.inspection_watch_findings where resolved_at is null), 2, 'two findings stay open (q61, a2)');

-- ================================================================ 4. the table
select tests.act_as('sup1');
select is((select count(*)::int from public.inspection_watch_findings), 3, 'a supervisor reads the findings of own branch only (o31, o31p, q61)');
select throws_ok('delete from public.inspection_watch_findings', '42501', null, 'no client delete');
select throws_ok(format('insert into public.inspection_watch_findings (company_id, branch_id, allocation_id, inspection_stage, finding) values (%L, %L, %L, ''pre_shift'', ''overdue'')', tests.id('coA'), tests.id('A1'), tests.al('o30')), '42501', null, 'no client insert');
select throws_ok('update public.inspection_watch_findings set resolution = ''submitted''', '42501', null, 'no client update');
select tests.act_as('sa');
select is((select count(*)::int from public.inspection_watch_findings), 0, 'a system administrator reads no findings');
select tests.act_as('ma');
select is((select count(*)::int from public.inspection_watch_findings), 4, 'a maintenance administrator reads them (reports.view): all four of the company');
select tests.reset();
select throws_ok('delete from public.inspection_watch_findings', '42501', null, 'not even the table owner deletes (trigger)');
select throws_ok(format('update public.inspection_watch_findings set detected_at = now() - interval ''1 day'' where allocation_id = %L', tests.al('q61')), '23514', null, 'only the resolution can change');
select throws_ok(format('update public.inspection_watch_findings set resolved_at = now(), resolution = ''submitted'' where allocation_id = %L', tests.al('o31')), '55000', null, 'a resolved finding is never reopened or rewritten');
select throws_ok(format('insert into public.inspection_watch_findings (company_id, branch_id, allocation_id, inspection_stage, finding) values (%L, %L, %L, ''pre_shift'', ''overdue'')', tests.id('coA'), tests.id('A1'), tests.al('o31')), '23505', null, 'the unique key refuses a second finding for the same allocation, stage and finding');
select throws_ok(format('insert into public.inspection_watch_findings (company_id, branch_id, allocation_id, inspection_stage, finding, resolved_at) values (%L, %L, %L, ''pre_shift'', ''overdue'', now())', tests.id('coA'), tests.id('A1'), tests.al('o30')), '23514', null, 'resolved_at and resolution are set together');
select throws_ok(format('insert into public.inspection_watch_findings (company_id, branch_id, allocation_id, inspection_stage, finding) values (%L, %L, %L, ''pre_shift'', ''overdue'')', tests.id('coB'), tests.id('B1'), tests.al('o30')), '23503', null, 'composite FKs: an allocation of another company is refused');

select * from finish();
rollback;
