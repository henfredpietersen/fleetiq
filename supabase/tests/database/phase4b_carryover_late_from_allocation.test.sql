-- Slice 4B carry-over C1 pgTAP: DEC-17 as amended 2026-11-24 — lateness is measured from the ALLOCATION's planned start
-- (pre-shift, +30 min) and planned end (post-shift, +60 min), not from the shift (migration 040). Synthetic data only; rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

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

-- an allocation (planned_s .. planned_e) INSIDE a longer shift (shift_s .. shift_e), in the given status
create function tests.sc2(label text, astatus text, shift_s timestamptz, shift_e timestamptz, planned_s timestamptz, planned_e timestamptz) returns void language plpgsql as $$
begin
  perform tests.mk_driver('u-' || label, 'coA', 'E-' || upper(label), 'A1');
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('v-' || label), tests.id('coA'), tests.id('A1'), 'FL-' || label, upper('T4B' || label), 'Make', 'Model', 'bakkie');
  insert into public.shifts (id, company_id, branch_id, shift_date, scheduled_start_at, scheduled_end_at, client_submission_id, created_by)
  values (tests.id('sh-' || label), tests.id('coA'), tests.id('A1'), (shift_s at time zone 'Africa/Johannesburg')::date, shift_s, shift_e, gen_random_uuid(), tests.id('boot'));
  insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, status, started_at,
                                          opened_at, opened_by, licence_class_check, client_submission_id, created_by)
  values (tests.id('al-' || label), tests.id('coA'), tests.id('A1'), tests.id('v-' || label), tests.id('d-u-' || label), tests.id('sh-' || label),
          planned_s, planned_e, astatus, case when astatus in ('in_use', 'post_inspection_pending') then planned_s end,
          planned_s, tests.id('u-' || label), 'matched', gen_random_uuid(), tests.id('boot'));
  perform tests.mk_file('fo-' || label || '-pre', 'u-' || label, 'A1');
  perform tests.mk_file('fo-' || label || '-post', 'u-' || label, 'A1');
end $$;
-- ---------------------------------------------------------------- fixtures
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A');
insert into public.branches (id, company_id, name, branch_code) values (tests.id('A1'), tests.id('coA'), 'A one', 'A1');
select tests.mk_user('boot', 'coA');
select public.seed_starter_inspection_template(tests.id('coA'));

-- ================================================================ pre-shift: measured from the allocation's planned start
-- a 06:00-18:00 shift (started 4h20 ago) with a 10:00-14:00 allocation (planned start 20 minutes ago = "10:20")
select tests.sc2('c20', 'pre_inspection_pending', now() - interval '260 minutes', now() + interval '460 minutes', now() - interval '20 minutes', now() + interval '220 minutes');
select tests.sc2('c31', 'pre_inspection_pending', now() - interval '271 minutes', now() + interval '449 minutes', now() - interval '31 minutes', now() + interval '209 minutes');
-- edges, shift started long before
select tests.sc2('e29', 'pre_inspection_pending', now() - interval '5 hours', now() + interval '5 hours', now() - interval '29 minutes', now() + interval '3 hours');
select tests.sc2('e30', 'pre_inspection_pending', now() - interval '5 hours', now() + interval '5 hours', now() - interval '30 minutes', now() + interval '3 hours');
select tests.sc2('e31', 'pre_inspection_pending', now() - interval '5 hours', now() + interval '5 hours', now() - interval '31 minutes', now() + interval '3 hours');
-- post-shift: allocation ends 59 / 60 / 61 minutes ago, inside a shift that ended later
select tests.sc2('q59', 'in_use', now() - interval '10 hours', now() + interval '1 hour', now() - interval '9 hours', now() - interval '59 minutes');
select tests.sc2('q60', 'in_use', now() - interval '10 hours', now() + interval '1 hour', now() - interval '9 hours', now() - interval '60 minutes');
select tests.sc2('q61', 'in_use', now() - interval '10 hours', now() + interval '1 hour', now() - interval '9 hours', now() - interval '61 minutes');

select tests.act_as('u-c20'); select tests.prep('c20');
select is(tests.submit('c20'), null, 'C1: an allocation 10:00-14:00 in a 06:00-18:00 shift submits at 10:20');
select tests.reset();
select is((select late_flag from public.inspections where id = tests.ins('c20')), false, 'C1: ... not late at 10:20 (20 min after the ALLOCATION start; it was 4h20 after the shift start)');

select tests.act_as('u-c31'); select tests.prep('c31');
select is(tests.submit('c31'), null, 'C1: the 10:31 submit succeeds (late never blocks)');
select tests.reset();
select is((select late_flag from public.inspections where id = tests.ins('c31')), true, 'C1: ... late at 10:31 (31 min after the allocation start)');

select tests.act_as('u-e29'); select tests.prep('e29'); select is(tests.submit('e29'), null, 'pre edge: 29 min after the planned start submits');
select tests.act_as('u-e30'); select tests.prep('e30'); select is(tests.submit('e30'), null, 'pre edge: 30 min after the planned start submits');
select tests.act_as('u-e31'); select tests.prep('e31'); select is(tests.submit('e31'), null, 'pre edge: 31 min after the planned start submits');
select tests.reset();
select is((select late_flag from public.inspections where id = tests.ins('e29')), false, 'pre edge: 29 min is not late');
select is((select late_flag from public.inspections where id = tests.ins('e30')), false, 'pre edge: exactly 30 min is not late (strictly more than)');
select is((select late_flag from public.inspections where id = tests.ins('e31')), true, 'pre edge: 31 min is late');

select tests.act_as('u-q59'); select tests.prep('q59', 'post_shift');
select tests.act_as('u-q60'); select tests.prep('q60', 'post_shift');
select tests.act_as('u-q61'); select tests.prep('q61', 'post_shift');
select tests.act_as('u-q59'); select is(tests.submit('q59', 'post_shift'), null, 'post edge: 59 min after the planned end submits');
select tests.act_as('u-q60'); select is(tests.submit('q60', 'post_shift'), null, 'post edge: 60 min after the planned end submits');
select tests.act_as('u-q61'); select is(tests.submit('q61', 'post_shift'), null, 'post edge: 61 min after the planned end submits');
select tests.reset();
select is((select late_flag from public.inspections where id = tests.ins('q59', 'post_shift')), false, 'post edge: 59 min is not late');
select is((select late_flag from public.inspections where id = tests.ins('q60', 'post_shift')), false, 'post edge: exactly 60 min is not late (strictly more than)');
select is((select late_flag from public.inspections where id = tests.ins('q61', 'post_shift')), true, 'post edge: 61 min is late (from the planned end, unchanged)');

select is(public.inspection_is_late('pre_shift', now(), now() - interval '4 hours', now() + interval '8 hours', 30, 60), true, 'rule: the pure function takes the start it is given (the allocation''s)');
select is(public.inspection_is_late('pre_shift', now(), now() - interval '30 minutes', now() + interval '8 hours', 30, 60), false, 'rule: 30 min after that start is not late');

select * from finish();
rollback;
