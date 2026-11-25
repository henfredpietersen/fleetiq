-- Slice 4D pgTAP: sync conflicts — report_sync_conflict (driver / on-behalf completer only, idempotent), resolve_sync_conflict (allocation.manage,
-- note, not own report, idempotent), RLS, the Missing / Late list, immutability and audit. Migration 050. DEC-06, DEC-24, DEC-43.
-- Synthetic data only; rolls back.
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
  perform public.confirm_known_damage_reviewed(tests.ins(label, 'post_shift'), tests.csid(label || 'restk'));
end $$;
create function tests.n(q text) returns integer language plpgsql as $$
declare r integer; begin execute q into r; return r; end $$;

-- ---------------------------------------------------------------- fixtures
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('fa', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'),
       tests.mk_user('sup3', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('fab', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sup2', 'supervisor', 'A1', 'boot'),
       tests.grant_role('sup3', 'supervisor', 'A2', 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'),
       tests.grant_role('sa', 'system_admin', null, 'boot'), tests.grant_role('fab', 'fleet_admin', null, 'bootb');
select public.seed_starter_inspection_template(tests.id('coA')), public.seed_starter_inspection_template(tests.id('coB'));

select tests.sc('c1', 'A1', 'cancelled', now() - interval '2 hours', now() + interval '9 hours');      -- the supervisor cancelled it while the phone was offline
select tests.sc('c2', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc('ob', 'A1', 'in_use', now() - interval '9 hours', now() + interval '1 hour', now() - interval '2 hours');
select tests.sc('b1', 'B1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');

create temp table kv (k text primary key, v uuid); grant all on kv to public;

-- ================================================================ 1. report_sync_conflict
select tests.act_as('u-c1');
insert into kv select 'r1', public.report_sync_conflict(tests.al('c1'), null, 'begin', '55000', 'the allocation was cancelled by your supervisor', '2026-01-01 05:00+00', tests.csid('r1'));
select ok((select v from kv where k = 'r1') is not null, 'report: the allocation''s own driver reports a refused item');
select is(public.report_sync_conflict(tests.al('c1'), null, 'begin', '55000', 'the allocation was cancelled by your supervisor', '2026-01-01 05:00+00', tests.csid('r1')), (select v from kv where k = 'r1'), 'report: the same client_submission_id returns the same conflict (idempotent)');
select is((select count(*)::int from public.inspection_sync_conflicts), 1, 'report: still one row after the replay');
select matches(tests.err_of(format('select public.report_sync_conflict(%L, null, ''submit'', ''55000'', ''x'', null, %L)', tests.al('c1'), tests.csid('r1'))), '^22023:.*already used', 'report: the same id for a different item is refused');
select is(tests.sqlstate_of(format('select public.report_sync_conflict(%L, null, ''begin'', ''55000'', ''x'', null, null)', tests.al('c1'))), '22023', 'report: client_submission_id is required');
select is(tests.sqlstate_of(format('select public.report_sync_conflict(%L, null, ''begin'', '''', ''x'', null, %L)', tests.al('c1'), tests.csid('r2'))), '22023', 'report: code and message are required');
select is(tests.sqlstate_of(format('select public.report_sync_conflict(%L, %L, ''begin'', ''55000'', ''x'', null, %L)', tests.al('c1'), tests.id('nonexistent'), tests.csid('r3'))), 'P0002', 'report: an inspection that is not on the allocation is refused');
select is(tests.sqlstate_of(format('select public.report_sync_conflict(%L, null, ''begin'', ''55000'', ''x'', null, %L)', tests.al('c2'), tests.csid('r4'))), '42501', 'report: another driver''s allocation is refused');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select public.report_sync_conflict(%L, null, ''begin'', ''55000'', ''x'', null, %L)', tests.al('c1'), tests.csid('r5'))), '42501', 'report: a supervisor who is not completing it on the driver''s behalf is refused');
select tests.act_as('u-b1');
select is(tests.sqlstate_of(format('select public.report_sync_conflict(%L, null, ''begin'', ''55000'', ''x'', null, %L)', tests.al('c1'), tests.csid('r6'))), 'P0002', 'report: another company''s allocation is not found');
select tests.act_as('sa');
select is(tests.sqlstate_of(format('select public.report_sync_conflict(%L, null, ''begin'', ''55000'', ''x'', null, %L)', tests.al('c1'), tests.csid('r7'))), '42501', 'report: a system administrator is refused');

-- the manager completing the post-shift inspection on the driver's behalf can report; another manager cannot
select tests.act_as('sup1');
insert into kv select 'obi', public.begin_inspection_on_behalf(tests.al('ob'), 'Driver ended the shift without finishing', null, false, tests.csid('ob-b'));
insert into kv select 'r8', public.report_sync_conflict(tests.al('ob'), (select v from kv where k = 'obi'), 'submit', 'IN002', 'a required item is not answered', null, tests.csid('r8'));
select ok((select v from kv where k = 'r8') is not null, 'report: the on-behalf completer reports a refusal');
select tests.act_as('sup2');
select is(tests.sqlstate_of(format('select public.report_sync_conflict(%L, null, ''submit'', ''IN002'', ''x'', null, %L)', tests.al('ob'), tests.csid('r9'))), '42501', 'report: another manager of the branch (not the completer) is refused');
select tests.reset();
select is((select count(*)::int from public.audit_logs where entity_type = 'inspection_sync_conflicts' and action = 'insert'), 2, 'audit rows are written for the reports');
select is((select string_agg(distinct refusal_code, ',' order by refusal_code) from public.inspection_sync_conflicts), '55000,IN002', 'only the refusal is stored (function, code, message, device time)');

-- ================================================================ 2. visibility
select tests.act_as('u-c1');
select is((select count(*)::int from public.inspection_sync_conflicts), 1, 'the reporting driver reads their own conflict (resolution status on the next sync)');
select tests.act_as('u-c2');
select is((select count(*)::int from public.inspection_sync_conflicts), 0, 'another driver reads none');
select tests.act_as('sup1');
select is((select count(*)::int from public.inspection_sync_conflicts), 2, 'a supervisor of the branch reads both');
select tests.act_as('sup3');
select is((select count(*)::int from public.inspection_sync_conflicts), 0, 'a supervisor of another branch reads none');
select tests.act_as('ma');
select is((select count(*)::int from public.inspection_sync_conflicts), 2, 'a maintenance administrator reads them (reports.view)');
select tests.act_as('sa');
select is((select count(*)::int from public.inspection_sync_conflicts), 0, 'a system administrator reads none');
select tests.act_as('fab');
select is((select count(*)::int from public.inspection_sync_conflicts), 0, 'another company reads none');

-- ================================================================ 3. the Missing / Late list shows open conflicts, with the message, without names
select tests.act_as('sup1');
select is((select count(*)::int from public.list_overdue_inspections() where kind = 'sync_conflict'), 2, 'list: both open conflicts appear');
select is((select refusal_message from public.list_overdue_inspections() where kind = 'sync_conflict' and function_name = 'begin'), 'the allocation was cancelled by your supervisor', 'list: the server''s message is shown as is');
select is((select vehicle_fleet_number from public.list_overdue_inspections() where kind = 'sync_conflict' and function_name = 'begin'), 'FL-c1', 'list: fleet number is shown');
select tests.act_as('sup3');
select is((select count(*)::int from public.list_overdue_inspections() where kind = 'sync_conflict'), 0, 'list: another branch''s supervisor sees none');
select tests.act_as('sa');
select is((select count(*)::int from public.list_overdue_inspections()), 0, 'list: a system administrator sees nothing');

-- ================================================================ 4. resolve_sync_conflict
select tests.act_as('u-c1');
select is(tests.sqlstate_of(format('select public.resolve_sync_conflict(%L, ''fine'', %L)', (select v from kv where k = 'r1'), tests.csid('s0'))), 'P0002', 'resolve: a driver (no allocation.manage) cannot resolve; the conflict is not visible to the action');
select tests.act_as('ma');
select is(tests.sqlstate_of(format('select public.resolve_sync_conflict(%L, ''fine'', %L)', (select v from kv where k = 'r1'), tests.csid('s1'))), 'P0002', 'resolve: reports.view is read-only');
select tests.act_as('sup3');
select is(tests.sqlstate_of(format('select public.resolve_sync_conflict(%L, ''fine'', %L)', (select v from kv where k = 'r1'), tests.csid('s2'))), 'P0002', 'resolve: another branch''s supervisor cannot');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select public.resolve_sync_conflict(%L, ''fine'', %L)', (select v from kv where k = 'r8'), tests.csid('s3'))), '42501', 'resolve: nobody resolves their own report (DEC-24)');
select is(tests.sqlstate_of(format('select public.resolve_sync_conflict(%L, '''', %L)', (select v from kv where k = 'r1'), tests.csid('s4'))), '22023', 'resolve: a note is required');
select is(tests.sqlstate_of(format('select public.resolve_sync_conflict(%L, %L, %L)', (select v from kv where k = 'r1'), repeat('x', 501), tests.csid('s5'))), '22023', 'resolve: the note is at most 500 characters');
select is(tests.sqlstate_of(format('select public.resolve_sync_conflict(%L, ''fine'', null)', (select v from kv where k = 'r1'))), '22023', 'resolve: client_submission_id is required');
select is((select public.resolve_sync_conflict((select v from kv where k = 'r1'), 'Cancelled in error; the driver drove the route, recorded on paper.', tests.csid('s6'))), (select v from kv where k = 'r1'), 'resolve: a different supervisor with allocation.manage resolves it');
select is(public.resolve_sync_conflict((select v from kv where k = 'r1'), 'Cancelled in error; the driver drove the route, recorded on paper.', tests.csid('s6')), (select v from kv where k = 'r1'), 'resolve: a retry with the same client_submission_id succeeds (idempotent)');
select is(tests.sqlstate_of(format('select public.resolve_sync_conflict(%L, ''another note'', %L)', (select v from kv where k = 'r1'), tests.csid('s7'))), '55000', 'resolve: an already-resolved conflict is refused');
select is((select count(*)::int from public.list_overdue_inspections() where kind = 'sync_conflict'), 1, 'list: the resolved conflict has left the Missing / Late list');
select tests.act_as('sup2');
select is(tests.sqlstate_of(format('select public.resolve_sync_conflict(%L, ''fine'', %L)', (select v from kv where k = 'r1'), tests.csid('s8'))), '55000', 'resolve: another supervisor cannot re-resolve it either');
select tests.act_as('u-c1');
select is((select resolved_by is not null and resolution_note like 'Cancelled in error%' from public.inspection_sync_conflicts where id = (select v from kv where k = 'r1')), true, 'the driver sees the resolution and note on the next sync');
select tests.reset();
select is((select count(*)::int from public.audit_logs where entity_type = 'inspection_sync_conflicts' and action = 'update'), 1, 'audit: the resolution is audited');

-- ================================================================ 5. the table
select throws_ok(format('update public.inspection_sync_conflicts set refusal_message = ''changed'' where id = %L', (select v from kv where k = 'r8')), '23514', null, 'only the resolution can change');
select throws_ok(format('update public.inspection_sync_conflicts set resolved_by = reported_by, resolved_at = now(), resolution_note = ''self'', resolve_client_submission_id = gen_random_uuid() where id = %L', (select v from kv where k = 'r8')), '23514', null, 'the table itself refuses a resolver who is the reporter (DEC-24)');
select throws_ok(format('update public.inspection_sync_conflicts set resolution_note = ''x'' where id = %L', (select v from kv where k = 'r8')), '23514', null, 'resolved fields are set together');
select throws_ok(format('update public.inspection_sync_conflicts set resolution_note = ''x'' where id = %L', (select v from kv where k = 'r1')), '55000', null, 'a resolved conflict is never rewritten');
select throws_ok('delete from public.inspection_sync_conflicts', '42501', null, 'no delete (trigger), not even for the owner');
select tests.act_as('sup1');
select throws_ok('delete from public.inspection_sync_conflicts', '42501', null, 'no client delete');
select throws_ok(format('insert into public.inspection_sync_conflicts (company_id, branch_id, allocation_id, reported_by, client_submission_id, function_name, refusal_code, refusal_message) values (%L, %L, %L, %L, gen_random_uuid(), ''begin'', ''x'', ''x'')', tests.id('coA'), tests.id('A1'), tests.al('c1'), tests.id('sup1')), '42501', null, 'no client insert');
select is(has_function_privilege('anon', 'public.report_sync_conflict(uuid,uuid,text,text,text,timestamptz,uuid)', 'execute'), false, 'anon cannot report');
select is(has_function_privilege('anon', 'public.resolve_sync_conflict(uuid,text,uuid)', 'execute'), false, 'anon cannot resolve');

select * from finish();
rollback;
