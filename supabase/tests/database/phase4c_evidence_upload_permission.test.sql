-- Slice 4C pgTAP (review fix): ONE upload-permission rule for evidence (migration 046: evidence_upload_allowed). Damage photos for the
-- day-one load may be uploaded by every allocation.manage holder of the branch (supervisor, branch manager, fleet administrator) — in the
-- slot request AND in the storage insert policy's check (evidence_slot_open_for_upload). Everything else is as before. Synthetic data; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

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

create function tests.slot(n text, who text, branch text, purpose text, expires interval default interval '10 minutes') returns void language sql as $$
  insert into public.evidence_upload_slots (id, company_id, branch_id, object_path, purpose, capture_source, declared_mime_type, declared_size_bytes,
                                            requested_by, client_submission_id, expires_at)
  select tests.id('slot-' || n), p.company_id, tests.id(branch), 'test/slot-' || n, purpose, 'in_app_camera', 'image/jpeg', 1000, p.id, gen_random_uuid(), now() + expires
    from public.profiles p where p.id = tests.id(who) $$;
create function tests.open_as(who text, n text) returns boolean language plpgsql as $$
declare r boolean;
begin
  perform tests.act_as(who);
  select public.evidence_slot_open_for_upload('evidence', 'test/slot-' || n) into r;
  perform tests.reset();
  return r;
end $$;
create function tests.allowed_as(who text, purpose text, branch text) returns boolean language plpgsql as $$
declare r boolean;
begin
  perform tests.act_as(who);
  select public.evidence_upload_allowed(purpose, tests.id(branch)) into r;
  perform tests.reset();
  return r;
end $$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A');
insert into public.branches (id, company_id, name, branch_code) values (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2');
select tests.mk_user('boot', 'coA'), tests.mk_user('sup', 'coA'), tests.mk_user('bm', 'coA'), tests.mk_user('bm2', 'coA'), tests.mk_user('fa', 'coA'),
       tests.mk_user('ma', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('sm', 'coA');
select tests.grant_role('sup', 'supervisor', 'A1', 'boot'), tests.grant_role('bm', 'branch_manager', 'A1', 'boot'), tests.grant_role('bm2', 'branch_manager', 'A2', 'boot'),
       tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'), tests.grant_role('sa', 'system_admin', null, 'boot'),
       tests.grant_role('sm', 'senior_management', null, 'boot');
select tests.mk_driver('drv', 'coA', 'E-DRV', 'A1');

-- ---------------------------------------------------------------- the rule itself
select is(tests.allowed_as('sup', 'damage', 'A1'), true, 'damage: a supervisor (inspection.submit + allocation.manage)');
select is(tests.allowed_as('bm', 'damage', 'A1'), true, 'damage: a branch manager of the branch (allocation.manage only)');
select is(tests.allowed_as('fa', 'damage', 'A1'), true, 'damage: a fleet administrator (allocation.manage only, company-wide)');
select is(tests.allowed_as('drv', 'damage', 'A1'), true, 'damage: a driver, as before, through inspection.submit (the inspection flow)');
select is(tests.allowed_as('ma', 'damage', 'A1'), false, 'damage: a maintenance administrator is refused');
select is(tests.allowed_as('sa', 'damage', 'A1'), false, 'damage: a system administrator is refused');
select is(tests.allowed_as('sm', 'damage', 'A1'), false, 'damage: senior management (view-only) is refused');
select is(tests.allowed_as('bm2', 'damage', 'A1'), false, 'damage: a branch manager of ANOTHER branch is refused');
select is(tests.allowed_as('bm', 'damage', 'A2'), false, 'damage: ... and the first branch manager for the other branch');
select is(tests.allowed_as('bm', 'odometer', 'A1'), false, 'the exception is for damage only: a branch manager still cannot upload an odometer photo');
select is(tests.allowed_as('fa', 'inspection', 'A1'), false, '... nor an inspection photo');
select is(tests.allowed_as('sup', 'odometer', 'A1'), true, 'other purposes are unchanged: a supervisor can upload odometer photos');
select is(tests.allowed_as('ma', 'service_record', 'A1'), true, 'other purposes are unchanged: a maintenance administrator can upload service records');
select is(tests.allowed_as('sup', 'nonsense', 'A1'), false, 'an unknown purpose is refused (false, never an error)');
select is(tests.allowed_as('boot', 'damage', 'A1'), false, 'a user with no role is refused');

-- ---------------------------------------------------------------- the storage policy's check
select tests.slot('bm', 'bm', 'A1', 'damage'), tests.slot('fa', 'fa', 'A1', 'damage'), tests.slot('sup', 'sup', 'A1', 'damage'),
       tests.slot('expired', 'bm', 'A1', 'damage', interval '-1 minute'), tests.slot('bm-odo', 'bm', 'A1', 'odometer'),
       tests.slot('ma-dmg', 'ma', 'A1', 'damage'), tests.slot('bm2-dmg', 'bm2', 'A1', 'damage');
select is(tests.open_as('bm', 'bm'), true, 'storage check: a branch manager''s issued damage slot is open');
select is(tests.open_as('fa', 'fa'), true, 'storage check: a fleet administrator''s issued damage slot is open');
select is(tests.open_as('sup', 'sup'), true, 'storage check: a supervisor''s is still open');
select is(tests.open_as('bm', 'expired'), false, 'storage check: an expired slot is closed');
select is(tests.open_as('fa', 'bm'), false, 'storage check: someone else''s slot is closed');
select is(tests.open_as('bm', 'bm-odo'), false, 'storage check: a non-damage purpose without its permission is closed');
select is(tests.open_as('ma', 'ma-dmg'), false, 'storage check: a maintenance administrator''s damage slot is closed');
select is(tests.open_as('bm2', 'bm2-dmg'), false, 'storage check: a branch manager of another branch is closed');

-- ---------------------------------------------------------------- the slot request uses the same rule
select tests.act_as('bm');
select is(tests.sqlstate_of(format($q$select public.request_evidence_upload_slot('damage', %L, 'in_app_camera', 'image/jpeg', 1000, %L)$q$, tests.id('A1'), tests.csid('rq1'))), null::text, 'slot request: a branch manager gets a damage slot');
select is(tests.sqlstate_of(format($q$select public.request_evidence_upload_slot('damage', %L, 'in_app_camera', 'image/jpeg', 1000, %L)$q$, tests.id('A2'), tests.csid('rq2'))), '42501', 'slot request: ... not for another branch');
select is(tests.sqlstate_of(format($q$select public.request_evidence_upload_slot('odometer', %L, 'in_app_camera', 'image/jpeg', 1000, %L)$q$, tests.id('A1'), tests.csid('rq3'))), '42501', 'slot request: ... and not an odometer photo');
select tests.act_as('ma');
select is(tests.sqlstate_of(format($q$select public.request_evidence_upload_slot('damage', %L, 'in_app_camera', 'image/jpeg', 1000, %L)$q$, tests.id('A1'), tests.csid('rq4'))), '42501', 'slot request: a maintenance administrator is refused');
select tests.reset();

-- ---------------------------------------------------------------- privileges and body
select ok(has_function_privilege('authenticated', 'public.evidence_upload_allowed(text,uuid)', 'EXECUTE') and not has_function_privilege('anon', 'public.evidence_upload_allowed(text,uuid)', 'EXECUTE'),
          'evidence_upload_allowed: authenticated yes, anon no');
select ok(has_function_privilege('authenticated', 'public.evidence_slot_open_for_upload(text,text)', 'EXECUTE') and not has_function_privilege('anon', 'public.evidence_slot_open_for_upload(text,text)', 'EXECUTE'),
          'evidence_slot_open_for_upload keeps its ACL (the storage policy runs it as the caller)');
select matches(pg_get_functiondef('public.evidence_slot_open_for_upload(text,text)'::regprocedure), 'evidence_upload_allowed\(s\.purpose, s\.branch_id\)', 'the storage check and the slot request use one rule');
select matches(pg_get_functiondef('public.request_evidence_upload_slot(text,uuid,text,text,bigint,uuid,timestamptz,integer,numeric,numeric,numeric,boolean,uuid)'::regprocedure), 'evidence_upload_allowed\(p_purpose, p_branch_id\)', '... the same helper');

select * from finish();
rollback;
