-- Slice 4C pgTAP: the known-damage register (migrations 046-047; DEC-42, DEC-24, DEC-04/41, DEC-23, DEC-29). Zones and statuses, transitions,
-- permissions and segregation of duties, damage-photo evidence rules, report_damage (draft only, completer only, interval by chronology),
-- driver visibility, IN007 and new_damage_flag. Synthetic data only; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(171);

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

-- ---------------------------------------------------------------- helpers
alter function tests.ins(text, text) security definer;   -- readable whoever is acting (RLS would hide it from other users)
create function tests.f(n text) returns uuid language sql immutable as $$ select tests.id('f-' || n) $$;
create function tests.arr(variadic n text[]) returns uuid[] language sql immutable as $$ select array_agg(tests.id('f-' || x) order by x) from unnest(n) x $$;
create function tests.dfile(n text, uploader text, branch text default 'A1', purpose text default 'damage', src text default 'in_app_camera') returns void language sql as $$
  select tests.mk_file(n, uploader, branch, purpose, src) $$;
create function tests.onb(veh text, zone text, sev text, descr text, files uuid[], c text) returns text language sql as $$
  select tests.err_of(format('select public.record_onboarding_damage(%L, %L, %L, %L, %L::uuid[], %L)', tests.id('v-' || veh), zone, sev, descr, files, tests.csid(c))) $$;
create function tests.rev(item uuid, decision text, reason text, c text) returns text language sql as $$
  select tests.err_of(format('select public.review_damage(%L, %L, %L, %L)', item, decision, reason, tests.csid(c))) $$;
create function tests.rep(item uuid, note text, c text) returns text language sql as $$
  select tests.err_of(format('select public.mark_damage_repaired(%L, %L, %L)', item, note, tests.csid(c))) $$;
create function tests.item_of(c text, who text) returns uuid language sql stable as $$
  select id from public.vehicle_damage_items where client_submission_id = tests.csid(c) and reported_by = tests.id(who) $$;
create function tests.rpt(label text, zone text, sev text, descr text, files uuid[], c text, stage text default 'pre_shift') returns text language sql as $$
  select tests.err_of(format('select public.report_damage(%L, %L, %L, %L, %L::uuid[], null, false, %L)', tests.ins(label, stage), zone, sev, descr, files, tests.csid(c))) $$;
-- a prior allocation of an existing vehicle (vlabel), inserted directly in the given status, with its own driver and shift
create function tests.sc3(label text, vlabel text, astatus text, s timestamptz, e timestamptz) returns void language plpgsql as $$
begin
  perform tests.mk_driver('u-' || label, 'coA', 'E-' || upper(label), 'A1');
  insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('sh-' || label), tests.id('coA'), tests.id('A1'), (s at time zone 'Africa/Johannesburg')::date, s, e, gen_random_uuid(), tests.id('boot'));
  insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, status, started_at,
                                          opened_at, opened_by, licence_class_check, client_submission_id, created_by)
  values (tests.id('al-' || label), tests.id('coA'), tests.id('A1'), tests.id('v-' || vlabel), tests.id('d-u-' || label), tests.id('sh-' || label),
          s, e, astatus, case when astatus in ('in_use', 'post_inspection_pending', 'closed') then s end,
          case when astatus <> 'planned' then s end, case when astatus <> 'planned' then tests.id('u-' || label) end, 'matched', gen_random_uuid(), tests.id('boot'));
end $$;
-- a SUBMITTED post-shift inspection of an allocation, inserted directly (device time deliberately in the future: chronology must not use it)
create function tests.post_insp(label text) returns void language plpgsql as $$
declare a public.vehicle_allocations;
begin
  select * into a from public.vehicle_allocations where id = tests.al(label);
  insert into public.inspections (id, company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, template_id, inspection_stage, submitted_by, client_submission_id)
  values (tests.id('pi-' || label), a.company_id, a.branch_id, a.vehicle_id, a.driver_id, a.shift_id, a.id, public.inspection_template_for(a.vehicle_id), 'post_shift',
          tests.id('u-' || label), gen_random_uuid());
  update public.inspections set status = 'submitted', submitted_at = now(), device_submitted_at = now() + interval '1 day' where id = tests.id('pi-' || label);
end $$;
-- begin + answer + attach odometer, WITHOUT confirming the known damage list
create function tests.prep0(label text, stage text default 'pre_shift') returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.begin_inspection(tests.al(label), stage, null, false, tests.csid(label || stage || 'b0'));
  perform public.save_inspection_responses(v, tests.answers(stage), true, tests.csid(label || stage || 's0'));
  perform public.attach_odometer_photo(v, tests.id('f-fo-' || label || '-' || case stage when 'pre_shift' then 'pre' else 'post' end), tests.csid(label || stage || 'o0'));
  perform public.record_driver_reading(v, 1000, null, false, gen_random_uuid());
  return v;
end $$;

-- ---------------------------------------------------------------- fixtures
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB'), tests.mk_user('fa', 'coA'), tests.mk_user('sup1', 'coA'), tests.mk_user('sup2', 'coA'),
       tests.mk_user('sup3', 'coA'), tests.mk_user('bm1', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('fab', 'coB');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sup2', 'supervisor', 'A1', 'boot'),
       tests.grant_role('sup3', 'supervisor', 'A2', 'boot'), tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'),
       tests.grant_role('sm', 'senior_management', null, 'boot'), tests.grant_role('sa', 'system_admin', null, 'boot'), tests.grant_role('fab', 'fleet_admin', null, 'bootb');
select public.seed_starter_inspection_template(tests.id('coA')), public.seed_starter_inspection_template(tests.id('coB'));

select tests.sc('p1', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc('p2', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc('can', 'A1', 'cancelled', now() - interval '2 hours', now() + interval '9 hours');
select tests.sc('inu', 'A1', 'in_use', now() - interval '2 hours', now() + interval '9 hours');
select tests.sc('pip', 'A1', 'post_inspection_pending', now() - interval '2 hours', now() + interval '9 hours');
select tests.sc('a2', 'A2', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc('b1', 'B1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
-- damage photos (purpose 'damage', in-app camera) and the refusal fixtures
select tests.dfile('d1', 'sup1'), tests.dfile('d2', 'sup1'), tests.dfile('d3', 'sup1'), tests.dfile('d4', 'fa'), tests.dfile('d5', 'sup1'), tests.dfile('d6', 'sup1'), tests.dfile('d7', 'sup1'),
       tests.dfile('d8', 'sup1'), tests.dfile('d9', 'sup1'), tests.dfile('d10', 'sup1'), tests.dfile('d11', 'sup3', 'A2'), tests.dfile('d12', 'sup1'),
       tests.dfile('gal', 'sup1', 'A1', 'damage', 'gallery'), tests.dfile('wp', 'sup1', 'A1', 'inspection'), tests.dfile('oth', 'sup2'), tests.dfile('br', 'sup1', 'A2');

-- ================================================================ 1. zones, severities, display names
select is(cardinality(public.damage_zones()), 13, 'zones: the fixed list has 13 entries');
select is(public.damage_zones(), array['front_bumper', 'bonnet', 'windscreen', 'roof', 'rear_bumper', 'rear_boot_load_area', 'left_front', 'left_rear',
                                       'right_front', 'right_rear', 'wheels_tyres', 'interior', 'other'], 'zones: exactly the DEC-42 list, in order');
select is((select count(*)::int from unnest(public.damage_zones()) z where public.damage_zone_label(z) is null or public.damage_zone_label(z) = z), 0, 'zones: every zone has a plain-words display name');
select is(public.damage_zone_label('left_front'), 'Left front (door and wing)', 'zones: display name example');
select is(public.damage_zone_label('nose'), null, 'zones: an unknown zone has no label');
select is(tests.sqlstate_of(format($q$insert into public.vehicle_damage_items (company_id, branch_id, vehicle_id, zone, severity, description, source, reported_by, client_submission_id)
  values (%L, %L, %L, 'nose', 'minor', 'x', 'onboarding', %L, gen_random_uuid())$q$, tests.id('coA'), tests.id('A1'), tests.id('v-p1'), tests.id('sup1'))), '23514', 'zones: the table refuses a zone outside the list (CHECK)');
select is(tests.sqlstate_of(format($q$insert into public.vehicle_damage_items (company_id, branch_id, vehicle_id, zone, severity, description, source, reported_by, client_submission_id)
  values (%L, %L, %L, 'roof', 'huge', 'x', 'onboarding', %L, gen_random_uuid())$q$, tests.id('coA'), tests.id('A1'), tests.id('v-p1'), tests.id('sup1'))), '23514', 'severity: the table refuses a value outside minor/moderate/major (CHECK)');
select is(tests.sqlstate_of(format($q$insert into public.vehicle_damage_items (company_id, branch_id, vehicle_id, zone, severity, description, status, source, reported_by, client_submission_id)
  values (%L, %L, %L, 'roof', 'minor', 'x', 'verified', 'onboarding', %L, gen_random_uuid())$q$, tests.id('coA'), tests.id('A1'), tests.id('v-p1'), tests.id('sup1'))), '23514', 'status: an item is created as reported');

-- ================================================================ 2. onboarding (day-one load): allocation.manage only, evidence rules
select tests.act_as('sup1');
select is(tests.onb('p1', 'left_front', 'minor', 'Scratch on the front left door', '{}'::uuid[], 'o-0') like 'DM006:%', true, 'onboarding: at least one photo is required (DM006)');
select is(tests.onb('p1', 'nose', 'minor', 'x', tests.arr('d1'), 'o-1') like 'DM005:%', true, 'onboarding: an unknown zone is refused (DM005)');
select is(tests.onb('p1', 'roof', 'huge', 'x', tests.arr('d1'), 'o-2') like 'DM005:%', true, 'onboarding: an unknown severity is refused (DM005)');
select is(tests.onb('p1', 'roof', 'minor', '   ', tests.arr('d1'), 'o-3') like 'DM005:%', true, 'onboarding: a blank description is refused (DM005)');
select is(tests.onb('p1', 'roof', 'minor', repeat('x', 501), tests.arr('d1'), 'o-4') like 'DM005:%', true, 'onboarding: a description over 500 characters is refused (DM005)');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', tests.arr('gal'), 'o-5') like 'IN010:%', true, 'evidence: a gallery/file photo is refused (IN010, DEC-04/41)');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', tests.arr('wp'), 'o-6') like 'IN011:%', true, 'evidence: a photo of another purpose is refused (IN011)');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', tests.arr('oth'), 'o-7') like 'IN012:%', true, 'evidence: a photo uploaded by someone else is refused (IN012)');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', tests.arr('br'), 'o-8') like 'IN013:%', true, 'evidence: a photo from another branch is refused (IN013)');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', array[gen_random_uuid()], 'o-9') like 'IN013:%', true, 'evidence: an unknown photo is refused (IN013)');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', array[tests.f('d1'), tests.f('d1')], 'o-9b') like '22023:%', true, 'evidence: the same photo twice in one report is refused');
select is(tests.onb('p1', 'left_front', 'minor', 'Scratch on the front left door', tests.arr('d1'), 'ob1'), null, 'onboarding: a supervisor records existing damage with a photo');
select is(tests.onb('p1', 'left_front', 'minor', 'Scratch on the front left door', tests.arr('d1'), 'ob1'), null, 'onboarding: the retry (same client_submission_id) is idempotent');
select is(tests.onb('p1', 'right_rear', 'minor', 'Scratch on the front left door', tests.arr('d1'), 'ob1') like '22023:%', true, 'onboarding: the same id with a different request is refused');
select is(tests.onb('p1', 'bonnet', 'minor', 'Chip', tests.arr('d1'), 'ob1x') like 'IN014:%', true, 'evidence: a photo already used as evidence is refused (IN014)');
select tests.reset();
select is((select count(*)::int from public.vehicle_damage_items where vehicle_id = tests.id('v-p1')), 1, 'onboarding: one item despite the retry');
select is((select source || '/' || status || '/' || zone || '/' || severity from public.vehicle_damage_items where vehicle_id = tests.id('v-p1')), 'onboarding/reported/left_front/minor', '... source onboarding, status reported');
select is((select reported_in_inspection_id is null and interval_previous_allocation_id is null and reported_stage is null from public.vehicle_damage_items where vehicle_id = tests.id('v-p1')), true, '... no inspection, no interval');
select is((select count(*)::int from public.vehicle_damage_evidence where damage_item_id = (select id from public.vehicle_damage_items where vehicle_id = tests.id('v-p1'))), 1, '... one evidence row');
select tests.act_as('u-p1');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', tests.arr('d2'), 'o-10') like '42501:%', true, 'onboarding: a driver (no allocation.manage) is refused');
select tests.act_as('sup3');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', tests.arr('d2'), 'o-11') like '42501:%', true, 'onboarding: a supervisor of another branch is refused');
select tests.act_as('ma');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', tests.arr('d2'), 'o-12') like '42501:%', true, 'onboarding: a maintenance administrator is refused');
select tests.act_as('sa');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', tests.arr('d2'), 'o-13') like '42501:%', true, 'onboarding: a system administrator is refused');
select tests.act_as('fab');
select is(tests.onb('p1', 'roof', 'minor', 'Dent', tests.arr('d2'), 'o-14') like '42501:%', true, 'onboarding: another company''s user is refused');
select tests.act_as('sup1');
select is(tests.onb('p2', 'right_rear', 'major', 'Crumpled rear right panel', tests.arr('d2'), 'ob2'), null, 'onboarding: a second item (right_rear, major) on p1''s... other vehicle p2');
select is(tests.onb('p1', 'rear_bumper', 'moderate', 'Cracked rear bumper', tests.arr('d3'), 'ob3'), null, 'onboarding: a second item on p1');
select tests.act_as('fa');
select is(tests.onb('p1', 'interior', 'minor', 'Torn seat cover', tests.arr('d4'), 'ob4'), null, 'onboarding: a fleet administrator (allocation.manage, company-wide) can record too');
select tests.act_as('sup1');
select is(tests.onb('can', 'roof', 'minor', 'Dent in the roof', tests.arr('d5'), 'ob5'), null, 'onboarding: an item on the vehicle of a cancelled allocation');
select is(tests.onb('inu', 'wheels_tyres', 'moderate', 'Scuffed alloy wheel', tests.arr('d6'), 'ob6'), null, 'onboarding: an item on the vehicle of an in-use allocation');
select is(tests.onb('pip', 'windscreen', 'minor', 'Small chip', tests.arr('d7'), 'ob7'), null, 'onboarding: an item on the vehicle of a post-inspection-pending allocation');
select tests.act_as('sup3');
select is(tests.onb('a2', 'other', 'minor', 'Missing mud flap', tests.arr('d11'), 'ob8'), null, 'onboarding: a supervisor records on a vehicle of their own branch (A2)');
select tests.act_as('sup1');
select is(tests.onb('a2', 'other', 'minor', 'Missing mud flap', tests.arr('d12'), 'ob8b') like '42501:%', true, 'onboarding: ... but not on another branch''s vehicle');
select tests.reset();

-- ================================================================ 3. review: verify / dispute (allocation.manage only; never your own report)
-- ob1: p1 / left_front by sup1; ob3: p1 / rear_bumper by sup1; ob4: p1 / interior by fa; ob2: p2 / right_rear by sup1
select tests.act_as('sup1');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-own') like 'DM003:%', true, 'review: nobody verifies their own report (DM003, DEC-24)');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'disputed', 'no', 'v-own2') like 'DM003:%', true, 'review: nor disputes it (DM003)');
select tests.act_as('ma');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-ma') like '42501:%', true, 'review: a maintenance administrator cannot verify (no allocation.manage)');
select tests.act_as('sm');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-sm') like '42501:%', true, 'review: senior management (view-only) cannot verify');
select tests.act_as('sa');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-sa') like '42501:%', true, 'review: a system administrator cannot verify');
select tests.act_as('sup3');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-sup3') like '42501:%', true, 'review: a supervisor of another branch cannot verify');
select tests.act_as('fab');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-fab') like '42501:%', true, 'review: another company''s administrator cannot verify');
select tests.act_as('u-p1');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-drv') like '42501:%', true, 'review: a driver cannot verify');
select tests.act_as('sup2');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'maybe', null, 'v-bad') like '22023:%', true, 'review: the decision must be verified or disputed');
select is(tests.rev(tests.item_of('ob3', 'sup1'), 'disputed', null, 'v-nor') like 'DM004:%', true, 'review: a dispute needs a reason (DM004)');
select is(tests.rev(tests.item_of('ob3', 'sup1'), 'disputed', repeat('x', 501), 'v-long') like 'DM004:%', true, 'review: a reason over 500 characters is refused');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-1'), null, 'review: a different manager verifies ob1');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-1'), null, 'review: the retry is idempotent');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'verified', null, 'v-1b') like 'DM002:%', true, 'review: a verified item cannot be reviewed again (DM002)');
select is(tests.rev(tests.item_of('ob1', 'sup1'), 'disputed', 'changed my mind', 'v-1c') like 'DM002:%', true, 'review: ... nor disputed afterwards');
select is(tests.rev(tests.item_of('ob3', 'sup1'), 'disputed', 'Not damage: a shadow in the photo', 'v-3'), null, 'review: a dispute with a reason');
select is(tests.rev(tests.item_of('ob3', 'sup1'), 'verified', null, 'v-3b') like 'DM002:%', true, 'review: disputed is final: it cannot be verified (DM002)');
select tests.reset();
select is((select status || '/' || (reviewed_by = tests.id('sup2'))::text || '/' || (reviewed_at = now())::text from public.vehicle_damage_items where id = tests.item_of('ob1', 'sup1')), 'verified/true/true', 'review: reviewed_by and the server time are stored');
select is((select review_reason from public.vehicle_damage_items where id = tests.item_of('ob3', 'sup1')), 'Not damage: a shadow in the photo', 'review: the dispute reason is stored');
select tests.act_as('bm1');
select is(tests.rev(tests.item_of('ob4', 'fa'), 'verified', null, 'v-4'), null, 'review: a branch manager (own branch) verifies a fleet administrator''s report');
select tests.act_as('fa');
select is(tests.rev(tests.item_of('ob2', 'sup1'), 'verified', null, 'v-2'), null, 'review: a fleet administrator verifies');
select is(tests.rev(tests.item_of('ob4', 'fa'), 'verified', null, 'v-4x') like 'DM003:%' or tests.rev(tests.item_of('ob4', 'fa'), 'verified', null, 'v-4y') like 'DM003:%', true, 'review: the fleet administrator cannot review their own report either (DM003 before status)');
select tests.reset();

-- ================================================================ 4. repair (service.record.create only; verified only; never your own report)
select tests.act_as('sup1');
select is(tests.rep(tests.item_of('ob1', 'sup1'), 'Panel repaired', 'r-sup') like '42501:%', true, 'repair: a supervisor (no service.record.create) cannot mark repaired');
select tests.act_as('sm');
select is(tests.rep(tests.item_of('ob1', 'sup1'), 'Panel repaired', 'r-sm') like '42501:%', true, 'repair: senior management cannot');
select tests.act_as('sa');
select is(tests.rep(tests.item_of('ob1', 'sup1'), 'Panel repaired', 'r-sa') like '42501:%', true, 'repair: a system administrator cannot');
select tests.act_as('fab');
select is(tests.rep(tests.item_of('ob1', 'sup1'), 'Panel repaired', 'r-fab') like '42501:%', true, 'repair: another company''s fleet administrator cannot');
select tests.act_as('fa');
select is(tests.rep(tests.item_of('ob4', 'fa'), 'Seat re-covered', 'r-own') like 'DM003:%', true, 'repair: a fleet administrator cannot mark their own report repaired (DM003, DEC-24)');
select is(tests.rep(tests.item_of('ob3', 'sup1'), 'x', 'r-disp') like 'DM002:%', true, 'repair: a disputed item cannot be repaired (final)');
select tests.act_as('ma');
select is(tests.rep(tests.item_of('ob1', 'sup1'), '   ', 'r-nonote') like 'DM004:%', true, 'repair: a note is required (DM004)');
select is(tests.rep(tests.item_of('ob1', 'sup1'), 'Panel repaired and repainted', 'r-1'), null, 'repair: a maintenance administrator marks a verified item repaired');
select is(tests.rep(tests.item_of('ob1', 'sup1'), 'Panel repaired and repainted', 'r-1'), null, 'repair: the retry is idempotent');
select is(tests.rep(tests.item_of('ob1', 'sup1'), 'again', 'r-1b') like 'DM002:%', true, 'repair: repaired is final (DM002)');
select is(tests.rep(tests.item_of('ob4', 'fa'), 'Seat re-covered', 'r-4'), null, 'repair: a verified fleet-admin item is repaired by someone else');
select tests.reset();
select is((select status || '/' || (repaired_by = tests.id('ma'))::text || '/' || repair_note from public.vehicle_damage_items where id = tests.item_of('ob1', 'sup1')), 'repaired/true/Panel repaired and repainted', 'repair: repaired_by and the note are stored; the review stays');
select is((select reviewed_by = tests.id('sup2') from public.vehicle_damage_items where id = tests.item_of('ob1', 'sup1')), true, '... and the earlier reviewer is kept');
-- an item still 'reported' cannot be repaired
select tests.act_as('ma');
select is(tests.rep(tests.item_of('ob5', 'sup1'), 'x', 'r-rep') like 'DM002:%', true, 'repair: a reported (not yet verified) item cannot be marked repaired');
select tests.reset();

-- ================================================================ 5. guards: only the functions change an item; nothing is deleted; audit
select is(tests.sqlstate_of(format('update public.vehicle_damage_items set status = %L, reviewed_by = %L, reviewed_at = now() where id = %L', 'verified', tests.id('sup2'), tests.item_of('ob5', 'sup1'))), '55000', 'guard: a status change outside review_damage() is refused');
select is(tests.sqlstate_of(format('update public.vehicle_damage_items set description = %L where id = %L', 'changed', tests.item_of('ob5', 'sup1'))), '23514', 'guard: the description is immutable');
select is(tests.sqlstate_of(format('update public.vehicle_damage_items set zone = %L where id = %L', 'roof', tests.item_of('ob6', 'sup1'))), '23514', 'guard: the zone is immutable');
select set_config('app.damage_write', 'review', true);
select is(tests.sqlstate_of(format('update public.vehicle_damage_items set status = %L, reviewed_by = reported_by, reviewed_at = now() where id = %L', 'verified', tests.item_of('ob5', 'sup1'))), '23514', 'DEC-24 CHECK: reviewed_by <> reported_by even when the flag is set');
select is(tests.sqlstate_of(format('update public.vehicle_damage_items set status = %L, reviewed_by = %L, reviewed_at = now() - interval %L where id = %L', 'verified', tests.id('sup2'), '1 hour', tests.item_of('ob5', 'sup1'))), '23514', 'guard: reviewed_at is the server time');
select is(tests.sqlstate_of(format('update public.vehicle_damage_items set status = %L, reviewed_by = %L, reviewed_at = now() where id = %L', 'repaired', tests.id('sup2'), tests.item_of('ob5', 'sup1'))), '55000', 'guard: reported -> repaired is not a transition');
select set_config('app.damage_write', '', true);
select is(tests.sqlstate_of('delete from public.vehicle_damage_items'), '42501', 'no DELETE on damage items');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.vehicle_damage_items'::regclass and tgname = 'vdi_no_truncate'), 'no TRUNCATE on damage items (statement trigger)');
select is(tests.sqlstate_of('update public.vehicle_damage_evidence set added_by = added_by'), '42501', 'evidence rows are append-only (update)');
select is(tests.sqlstate_of('delete from public.vehicle_damage_evidence'), '42501', 'evidence rows are append-only (delete)');
select is(tests.sqlstate_of(format($q$insert into public.vehicle_damage_evidence (company_id, damage_item_id, evidence_file_id, added_by) values (%L, %L, %L, %L)$q$,
  tests.id('coA'), tests.item_of('ob1', 'sup1'), tests.f('d8'), tests.id('sup1'))), '55000', 'evidence: photos cannot be added to a reviewed item (a new report instead)');
select is((select count(*)::int from public.audit_logs where entity_type = 'vehicle_damage_items' and entity_id = tests.item_of('ob1', 'sup1')), 3, 'audit: insert, verify and repair of ob1 are logged');
select is((select count(*)::int from public.audit_logs where entity_type = 'vehicle_damage_items' and entity_id = tests.item_of('ob3', 'sup1') and reason = 'Not damage: a shadow in the photo'), 1, 'audit: the dispute reason is in the audit row');
select is((select count(*)::int from public.audit_logs where entity_type = 'vehicle_damage_evidence'), (select count(*)::int from public.vehicle_damage_evidence), 'audit: every evidence row is logged');
-- a damage item without a photo cannot be committed (checked at commit; here forced)
select is(tests.sqlstate_of(format($q$do $d$ begin
  insert into public.vehicle_damage_items (company_id, branch_id, vehicle_id, zone, severity, description, source, reported_by, client_submission_id)
  values (%L, %L, %L, 'roof', 'minor', 'No photo', 'onboarding', %L, gen_random_uuid());
  set constraints all immediate; end $d$$q$, tests.id('coA'), tests.id('A1'), tests.id('v-p1'), tests.id('sup1'))), 'DM006', 'the database refuses a report with no photo at commit (deferred constraint)');

-- ================================================================ 6. visibility (RLS)
select tests.act_as('sup1');
select is((select count(*)::int from public.vehicle_damage_items where vehicle_id = tests.id('v-p1')), 3, 'RLS: a supervisor of the branch sees the register (p1: 3 items)');
select is((select count(*)::int from public.vehicle_damage_items where vehicle_id = tests.id('v-a2')), 0, 'RLS: ... not another branch''s');
select is((select count(*)::int from public.vehicle_damage_evidence where damage_item_id = tests.item_of('ob1', 'sup1')), 1, 'RLS: ... and the evidence rows of visible items');
select is((select count(*)::int from public.evidence_files where id = tests.f('d1')), 1, 'RLS: ... and the photo itself (evidence.view for the branch)');
select tests.act_as('sup3');
select is((select count(*)::int from public.vehicle_damage_items), 1, 'RLS: the A2 supervisor sees only A2 damage');
select tests.act_as('ma');
select cmp_ok((select count(*)::int from public.vehicle_damage_items), '>=', 8, 'RLS: a maintenance administrator reads the register through reports.view');
select is((select count(*)::int from public.evidence_files where id = tests.f('d1')), 0, 'RLS: ... but sees no damage photos (evidence scope: service_record only; default to confirm)');
select tests.act_as('sm');
select cmp_ok((select count(*)::int from public.vehicle_damage_items), '>=', 8, 'RLS: senior management reads');
select tests.act_as('sa');
select is((select count(*)::int from public.vehicle_damage_items), 0, 'RLS: a system administrator sees nothing');
select tests.act_as('fab');
select is((select count(*)::int from public.vehicle_damage_items), 0, 'RLS: another company sees nothing');
select tests.act_as('u-p1');
select is((select count(*)::int from public.vehicle_damage_items where vehicle_id = tests.id('v-p1')), 3, 'driver: sees the register of the vehicle they hold a live allocation for (pre_inspection_pending)');
select is((select count(*)::int from public.vehicle_damage_items where vehicle_id <> tests.id('v-p1')), 0, 'driver: never another vehicle''s items');
select is((select count(*)::int from public.vehicle_damage_evidence), 3, 'driver: the evidence rows of those items are listed...');
select is((select count(*)::int from public.evidence_files where id = any (tests.arr('d1', 'd3', 'd4'))), 0, 'driver: ... but cannot read other people''s damage photos');
select is(tests.sqlstate_of(format('insert into public.vehicle_damage_items (company_id, branch_id, vehicle_id, zone, severity, description, source, reported_by, client_submission_id) values (%L, %L, %L, %L, %L, %L, %L, %L, gen_random_uuid())',
  tests.id('coA'), tests.id('A1'), tests.id('v-p1'), 'roof', 'minor', 'x', 'onboarding', tests.id('u-p1'))), '42501', 'driver: no direct INSERT');
select is(tests.sqlstate_of('update public.vehicle_damage_items set severity = ''major'''), '42501', 'driver: no direct UPDATE');
select is(tests.sqlstate_of('delete from public.vehicle_damage_items'), '42501', 'driver: no direct DELETE');
select tests.act_as('u-p2');
select is((select count(*)::int from public.vehicle_damage_items), 1, 'driver of p2: sees only p2''s vehicle (1 item)');
select tests.act_as('u-can');
select is((select count(*)::int from public.vehicle_damage_items), 0, 'driver: sees nothing once the allocation is cancelled');
select tests.act_as('u-inu');
select is((select count(*)::int from public.vehicle_damage_items), 1, 'driver: sees the register while in_use');
select tests.act_as('u-pip');
select is((select count(*)::int from public.vehicle_damage_items), 1, 'driver: sees the register while post_inspection_pending');
select tests.reset();

-- ================================================================ 7. report_damage in an inspection
select tests.dfile('r1', 'u-p1'), tests.dfile('r2', 'u-p1'), tests.dfile('r3', 'u-p1'), tests.dfile('r4', 'u-p1'), tests.dfile('r5', 'u-p1'), tests.dfile('rg', 'u-p1', 'A1', 'damage', 'gallery');
select tests.act_as('u-p1');
select public.begin_inspection(tests.al('p1'), 'pre_shift', null, false, tests.csid('p1b'));
select is(tests.rpt('p1', 'front_bumper', 'moderate', 'Dent in the front bumper', '{}'::uuid[], 'rd-0') like 'DM006:%', true, 'report: at least one photo (DM006)');
select is(tests.rpt('p1', 'nose', 'moderate', 'Dent', tests.arr('r1'), 'rd-1') like 'DM005:%', true, 'report: an unknown zone (DM005)');
select is(tests.rpt('p1', 'roof', 'huge', 'Dent', tests.arr('r1'), 'rd-2') like 'DM005:%', true, 'report: an unknown severity (DM005)');
select is(tests.rpt('p1', 'roof', 'minor', repeat('y', 501), tests.arr('r1'), 'rd-3') like 'DM005:%', true, 'report: a description over 500 characters (DM005)');
select is(tests.rpt('p1', 'roof', 'minor', 'Dent', tests.arr('rg'), 'rd-4') like 'IN010:%', true, 'report: a gallery photo is refused (IN010)');
select is(tests.rpt('p1', 'roof', 'minor', 'Dent', array[tests.id('f-fo-p1-pre')], 'rd-5') like 'IN011:%', true, 'report: an odometer-purpose photo is refused (IN011)');
select is(tests.rpt('p1', 'roof', 'minor', 'Dent', tests.arr('oth'), 'rd-6') like 'IN012:%', true, 'report: someone else''s photo is refused (IN012)');
select tests.act_as('u-p2');
select is(tests.rpt('p1', 'roof', 'minor', 'Dent', tests.arr('r1'), 'rd-7') like '42501:%', true, 'report: another driver is not the completer (42501)');
select tests.act_as('sup1');
select is(tests.rpt('p1', 'roof', 'minor', 'Dent', tests.arr('r1'), 'rd-8') like '42501:%', true, 'report: a supervisor is not the completer of a driver''s inspection (42501)');
select tests.act_as('u-p1');
select is(tests.rpt('p1', 'front_bumper', 'moderate', 'Dent in the front bumper', tests.arr('r1', 'r2'), 'rd-ok'), null, 'report: the completer reports damage with two photos');
select is(tests.rpt('p1', 'front_bumper', 'moderate', 'Dent in the front bumper', tests.arr('r1', 'r2'), 'rd-ok'), null, 'report: the retry is idempotent');
select is(tests.rpt('p1', 'roof', 'moderate', 'Dent in the front bumper', tests.arr('r1', 'r2'), 'rd-ok') like '22023:%', true, 'report: the same id with a different request is refused');
select is(tests.rpt('p1', 'roof', 'minor', 'Another', tests.arr('r1'), 'rd-9') like 'IN014:%', true, 'report: a photo already used is refused (IN014)');
select public.attach_inspection_photo(tests.ins('p1'), tests.f('r3'), 'damage', null, tests.csid('ap-r3'));
select is(tests.rpt('p1', 'roof', 'minor', 'Another', tests.arr('r3'), 'rd-10') like 'IN014:%', true, 'report: a photo already attached to the inspection another way is refused (IN014)');
select tests.reset();
select is((select count(*)::int from public.vehicle_damage_items where reported_in_inspection_id = tests.ins('p1')), 1, 'report: exactly one item despite the retries');
select is((select source || '/' || reported_stage || '/' || status || '/' || (reported_by = tests.id('u-p1'))::text from public.vehicle_damage_items where reported_in_inspection_id = tests.ins('p1')), 'inspection/pre_shift/reported/true', '... source, stage, status, reporter');
select is((select count(*)::int from public.vehicle_damage_evidence e join public.vehicle_damage_items d on d.id = e.damage_item_id where d.reported_in_inspection_id = tests.ins('p1')), 2, '... two evidence rows');
select is((select count(*)::int from public.inspection_photos where inspection_id = tests.ins('p1') and photo_category = 'damage' and template_item_id is null and evidence_file_id = any (tests.arr('r1', 'r2'))), 2, '... and two inspection_photos rows (category damage) so the inspection detail shows them');
select is((select interval_previous_allocation_id is null and interval_previous_inspection_id is null from public.vehicle_damage_items where reported_in_inspection_id = tests.ins('p1')), true, '... no previous allocation on this vehicle: both interval fields are null');
select is(tests.sqlstate_of(format('update public.inspections set new_damage_flag = true where id = %L', tests.ins('p1'))), '23514', 'a draft inspection cannot have new_damage_flag set by anything but submit_inspection');

-- the form document: known damage list (no photos, no names), reported-now marker, confirmation
select tests.act_as('u-p1');
select is(jsonb_array_length(public.my_inspection(tests.al('p1'), 'pre_shift') -> 'known_damage'), 1, 'my_inspection: the open list holds only what is still open (repaired and disputed items are gone) plus the item reported now');
select is((select count(*)::int from jsonb_array_elements(public.my_inspection(tests.al('p1'), 'pre_shift') -> 'known_damage') e where (e ->> 'reported_now')::boolean), 1, 'my_inspection: the item reported in this inspection is marked reported now');
select is((public.my_inspection(tests.al('p1'), 'pre_shift') -> 'known_damage' -> 0) ? 'evidence_file_id' or (public.my_inspection(tests.al('p1'), 'pre_shift') ->> 'known_damage') ~ 'evidence|photo', false, 'my_inspection: the list carries no photos');
select is((public.my_inspection(tests.al('p1'), 'pre_shift') ->> 'known_damage_reviewed')::boolean, false, 'my_inspection: known_damage_reviewed starts false');
select is(public.confirm_known_damage_reviewed(tests.ins('p1'), tests.csid('ck1')), tests.ins('p1'), 'confirm: the completer confirms the list');
select is(public.confirm_known_damage_reviewed(tests.ins('p1'), tests.csid('ck1')), tests.ins('p1'), 'confirm: the retry is idempotent');
select is((public.my_inspection(tests.al('p1'), 'pre_shift') ->> 'known_damage_reviewed')::boolean, true, 'my_inspection: known_damage_reviewed is now true');
select tests.act_as('u-p2');
select is(tests.sqlstate_of(format('select public.confirm_known_damage_reviewed(%L, %L)', tests.ins('p1'), tests.csid('ck2'))), '42501', 'confirm: another driver is refused');
select tests.act_as('sup1');
select is(tests.sqlstate_of(format('select public.confirm_known_damage_reviewed(%L, %L)', tests.ins('p1'), tests.csid('ck3'))), '42501', 'confirm: a supervisor is refused on a driver''s inspection');
select tests.reset();

-- ================================================================ 8. the interval, by allocation chronology (not by highest value or device time)
-- vehicle chA: older o1 (-30h..-22h), newer o2 (-20h..-12h), both closed with a submitted post-shift inspection whose DEVICE time is in the
-- future; x1 cancelled later (-10h..-6h) must be ignored. vehicle chB: one closed allocation with no post-shift inspection.
select tests.sc('chA', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc3('o1', 'chA', 'closed', now() - interval '30 hours', now() - interval '22 hours');
select tests.sc3('o2', 'chA', 'closed', now() - interval '20 hours', now() - interval '12 hours');
select tests.sc3('x1', 'chA', 'cancelled', now() - interval '10 hours', now() - interval '6 hours');
select tests.post_insp('o1'); select tests.post_insp('o2');
select tests.sc('chB', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc3('ob', 'chB', 'closed', now() - interval '20 hours', now() - interval '12 hours');
select tests.dfile('c1', 'u-chA'), tests.dfile('c2', 'u-chB'), tests.dfile('c3', 'u-chA'), tests.dfile('c4', 'u-pip');
select tests.act_as('u-chA'); select public.begin_inspection(tests.al('chA'), 'pre_shift', null, false, tests.csid('chA-b'));
select is(tests.rpt('chA', 'roof', 'minor', 'Dent in the roof', tests.arr('c1'), 'chA-r'), null, 'interval: a pre-shift report on a vehicle with earlier allocations');
select tests.act_as('u-chB'); select public.begin_inspection(tests.al('chB'), 'pre_shift', null, false, tests.csid('chB-b'));
select is(tests.rpt('chB', 'roof', 'minor', 'Dent in the roof', tests.arr('c2'), 'chB-r'), null, 'interval: a pre-shift report where the previous allocation has no post-shift inspection');
select tests.reset();
select is((select interval_previous_allocation_id from public.vehicle_damage_items where reported_in_inspection_id = tests.ins('chA')), tests.al('o2'), 'interval: the previous allocation is the latest USED one by chronology (o2), ignoring the older o1 and the cancelled x1');
select is((select interval_previous_inspection_id from public.vehicle_damage_items where reported_in_inspection_id = tests.ins('chA')), tests.id('pi-o2'), '... and its submitted post-shift inspection');
select is((select interval_previous_allocation_id from public.vehicle_damage_items where reported_in_inspection_id = tests.ins('chB')), tests.al('ob'), 'interval: without a post-shift inspection the allocation is still recorded');
select is((select interval_previous_inspection_id from public.vehicle_damage_items where reported_in_inspection_id = tests.ins('chB')), null, '... and the inspection is null ("no previous post-shift inspection")');
select tests.act_as('sup1');
select is((public.inspection_new_damage(tests.ins('chA')) -> 0 -> 'interval' ->> 'previous_allocation_id')::uuid, tests.al('o2'), 'inspection_new_damage: a supervisor sees the interval');
select is(jsonb_array_length(public.inspection_new_damage(tests.ins('chA')) -> 0 -> 'photo_ids'), 1, 'inspection_new_damage: ... and the photo ids (viewed through signed URLs)');
select tests.act_as('sup3');
select is(tests.sqlstate_of(format('select public.inspection_new_damage(%L)', tests.ins('chA'))), 'P0002', 'inspection_new_damage: another branch''s supervisor is refused');
select tests.act_as('u-chA');
select is(tests.sqlstate_of(format('select public.inspection_new_damage(%L)', tests.ins('chA'))), 'P0002', 'inspection_new_damage: a driver is refused');
select tests.reset();

-- ================================================================ 9. submit: IN007 and new_damage_flag
select tests.sc('f0', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.sc('f2', 'A1', 'in_use', now() - interval '4 hours', now() + interval '4 hours');
select tests.sc('f3', 'A1', 'pre_inspection_pending', now() - interval '10 minutes', now() + interval '9 hours');
select tests.dfile('f2d', 'u-f2'), tests.dfile('f3x', 'sup1');
select tests.act_as('sup1'); select tests.onb('f3', 'roof', 'minor', 'Existing roof dent', tests.arr('f3x'), 'f3-ob');
select tests.act_as('u-f0');
select tests.prep0('f0');
select matches(tests.submit('f0'), '^IN007:Confirm that you checked the vehicle''s known damage list before you submit\.$', 'submit: IN007 when the known damage list was not confirmed');
select is(public.confirm_known_damage_reviewed(tests.ins('f0'), tests.csid('f0-k')), tests.ins('f0'), 'submit: the driver confirms the list');
select is(tests.submit('f0'), null, 'submit: succeeds after the confirmation');
select tests.reset();
select is((select new_damage_flag from public.inspections where id = tests.ins('f0')), false, 'new_damage_flag: false when nothing new was reported');
select is((select known_damage_reviewed from public.inspections where id = tests.ins('f0')), true, '... and known_damage_reviewed is kept on the submitted row');
select tests.act_as('u-p1');
select public.save_inspection_responses(tests.ins('p1'), tests.answers('pre_shift'), true, tests.csid('p1-ans'));
select public.attach_odometer_photo(tests.ins('p1'), tests.id('f-fo-p1-pre'), tests.csid('p1-odo'));
select public.record_driver_reading(tests.ins('p1'), 1000, null, false, gen_random_uuid());
select is(tests.submit('p1', 'pre_shift', 'p1-sub'), null, 'submit: a pre-shift inspection with new damage submits (never blocks)');
select tests.reset();
select is((select new_damage_flag from public.inspections where id = tests.ins('p1')), true, 'new_damage_flag: true on a pre-shift inspection that reported new damage');
select is((select status from public.vehicle_allocations where id = tests.al('p1')), 'in_use', '... and the allocation moved to in_use as before');
select tests.act_as('u-p1');
select is(tests.rpt('p1', 'roof', 'minor', 'Late report', tests.arr('r4'), 'rd-late') like 'DM007:%', true, 'report: damage cannot be added to a submitted inspection (DM007)');
select tests.act_as('u-f3');
select tests.prep('f3');
select is(tests.submit('f3'), null, 'submit: pre-shift with an onboarding item on the vehicle and nothing reported');
select tests.reset();
select is((select new_damage_flag from public.inspections where id = tests.ins('f3')), false, 'new_damage_flag: onboarding items never raise it');
select tests.act_as('u-f2');
select tests.prep('f2', 'post_shift');
select is(tests.rpt('f2', 'left_rear', 'minor', 'Scrape in the yard', tests.arr('f2d'), 'f2-r', 'post_shift'), null, 'report: damage in a POST-shift inspection is recorded against that allocation');
select is(tests.submit('f2', 'post_shift'), null, 'submit: the post-shift inspection submits');
select tests.reset();
select is((select new_damage_flag from public.inspections where id = tests.ins('f2', 'post_shift')), false, 'new_damage_flag: false on a post-shift inspection, even with damage reported');
select is((select reported_stage || '/' || (interval_previous_allocation_id is null)::text from public.vehicle_damage_items where reported_in_inspection_id = tests.ins('f2', 'post_shift')), 'post_shift/true', '... and no interval is recorded for it');
select is((select count(*)::int from public.inspections where new_damage_flag and inspection_stage = 'post_shift'), 0, 'new_damage_flag: never set on any post-shift inspection');

-- ================================================================ 10. privileges
select ok((select bool_and(has_function_privilege('authenticated', p, 'EXECUTE') and not has_function_privilege('anon', p, 'EXECUTE'))
             from unnest(array['public.confirm_known_damage_reviewed(uuid,uuid)', 'public.report_damage(uuid,text,text,text,uuid[],timestamptz,boolean,uuid)',
                               'public.record_onboarding_damage(uuid,text,text,text,uuid[],uuid)', 'public.review_damage(uuid,text,text,uuid)',
                               'public.mark_damage_repaired(uuid,text,uuid)', 'public.inspection_new_damage(uuid)']) p), 'the six client functions: authenticated yes, anon no');
select ok((select bool_and(not has_function_privilege('authenticated', p, 'EXECUTE') and not has_function_privilege('anon', p, 'EXECUTE'))
             from unnest(array['public.evidence_check_attachable(uuid,uuid,uuid,uuid,text[],uuid)', 'public.damage_check_input(text,text,text,uuid[])',
                               'public.damage_replay(uuid,uuid,uuid,text,text)']) p), 'the internal helpers: no client grant');
select ok((select bool_and(not has_table_privilege('authenticated', t, 'INSERT') and not has_table_privilege('authenticated', t, 'UPDATE')
                           and not has_table_privilege('authenticated', t, 'DELETE') and not has_table_privilege('anon', t, 'SELECT'))
             from unnest(array['public.vehicle_damage_items', 'public.vehicle_damage_evidence', 'public.damage_requests']) t), 'the damage tables: no client write grants, no anon read');
select is(has_table_privilege('authenticated', 'public.damage_requests', 'SELECT'), false, 'the review ledger is not readable by clients');

select * from finish();
rollback;
