-- Slice 4A pgTAP: inspection templates and items (migration 037; PRD v1.15 §5.6; DB v1.10 §6; DEC-17, DEC-21, DEC-24).
-- Synthetic data only; everything rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

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
create function tests.mk_vehicle(label text, comp text, branch text, category text) returns void language sql as $$
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model, vehicle_category)
  values (tests.id('v-' || label), tests.id(comp), tests.id(branch), 'FL-' || label, upper('T4T' || label), 'Make', 'Model', category);
$$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B'), (tests.id('coC'), 'Synthetic Co C (no templates)');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('B1'), tests.id('coB'), 'B one', 'B1'), (tests.id('C1'), tests.id('coC'), 'C one', 'C1');
select tests.mk_user('boot', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('drv', 'coA', 'driver'), tests.mk_user('bootb', 'coB'), tests.mk_user('fab', 'coB');
select tests.grant_role('sa', 'system_admin', null, 'boot'), tests.grant_role('drv', 'driver', 'A1', 'boot'), tests.grant_role('fab', 'fleet_admin', null, 'bootb');
select public.seed_starter_inspection_template(tests.id('coA')), public.seed_starter_inspection_template(tests.id('coB'));
select tests.mk_vehicle('bak', 'coA', 'A1', 'bakkie'), tests.mk_vehicle('trk', 'coA', 'A1', 'truck'), tests.mk_vehicle('nob', 'coC', 'C1', 'bakkie');

-- ================================================================ settings (DEC-17, DEC-40): one place
select is((select row(open_before_start_minutes, no_show_grace_minutes, pre_shift_late_minutes, post_shift_late_minutes)::text
             from public.allocation_settings(tests.id('coA'))), '(60,30,30,60)', 'allocation_settings: start 60, no-show 30, pre-shift late 30, post-shift late 60');
select is(has_function_privilege('authenticated', 'public.allocation_settings(uuid)', 'execute'), false, 'allocation_settings stays internal');

-- ================================================================ inspection_template_for: category-specific over all-categories
select is(public.inspection_template_for(tests.id('v-bak')), (select id from public.inspection_templates where company_id = tests.id('coA') and vehicle_category is null),
          'no category template yet: the all-categories template is used');
insert into public.inspection_templates (id, company_id, name, vehicle_category, version) values (tests.id('t-bak1'), tests.id('coA'), 'Bakkie checklist', 'bakkie', 1);
insert into public.inspection_template_items (company_id, template_id, item_key, question, response_type, applies_to_stage, sequence)
values (tests.id('coA'), tests.id('t-bak1'), 'tyres', 'Tyres', 'ok_defect', 'pre_shift', 1);
select is(public.inspection_template_for(tests.id('v-bak')), tests.id('t-bak1'), 'a bakkie gets the bakkie template over the all-categories one');
select is(public.inspection_template_for(tests.id('v-trk')), (select id from public.inspection_templates where company_id = tests.id('coA') and vehicle_category is null),
          'a truck (no truck template) gets the all-categories template');
select is(public.inspection_template_for(tests.id('v-nob')), null, 'a company with no template: NULL');
select is(public.inspection_template_for(gen_random_uuid()), null, 'unknown vehicle: NULL');
update public.inspection_templates set active_status = 'retired' where id = tests.id('t-bak1');
select is(public.inspection_template_for(tests.id('v-bak')), (select id from public.inspection_templates where company_id = tests.id('coA') and vehicle_category is null),
          'a retired category template is ignored: back to all-categories');
select is(has_function_privilege('authenticated', 'public.inspection_template_for(uuid)', 'execute'), false, 'inspection_template_for is internal');

-- ================================================================ uniqueness
select is(tests.sqlstate_of($$insert into public.inspection_templates (company_id, name, vehicle_category, version) values (tests.id('coA'), 'Starter checklist', null, 1)$$), '23505', 'same company + category + name + version is refused');
select is(tests.sqlstate_of($$insert into public.inspection_templates (company_id, name, vehicle_category, version) values (tests.id('coA'), 'Another', null, 2)$$), '23505', 'one active template per (company, category): a second all-categories active is refused');
select is(tests.sqlstate_of($$insert into public.inspection_templates (company_id, name, vehicle_category, version) values (tests.id('coA'), 'Bakkie checklist', 'bakkie', 2)$$), null, 'a new active bakkie version is fine once the old one is retired');
select is(tests.sqlstate_of($$insert into public.inspection_templates (company_id, name, vehicle_category, version) values (tests.id('coA'), 'Bakkie again', 'bakkie', 3)$$), '23505', 'one active per category: a second active bakkie is refused');
select is(tests.sqlstate_of($$insert into public.inspection_templates (company_id, name, vehicle_category, version) values (tests.id('coB'), 'Starter checklist', null, 2)$$), '23505', 'the active rule is per company too (coB already has its active all-categories template)');
select is(tests.sqlstate_of($$insert into public.inspection_templates (company_id, name, vehicle_category, version) values (tests.id('coA'), 'Truck checklist', 'truck', 1)$$), null, 'another category is independent');
select is(tests.sqlstate_of($$insert into public.inspection_template_items (company_id, template_id, item_key, question, response_type, applies_to_stage, sequence)
  values (tests.id('coA'), tests.id('t-bak1'), 'tyres', 'Tyres again', 'ok_defect', 'pre_shift', 2)$$), '23505', 'UNIQUE (template, item_key)');
select is(tests.sqlstate_of($$insert into public.inspection_template_items (company_id, template_id, item_key, question, response_type, applies_to_stage, sequence)
  values (tests.id('coA'), tests.id('t-bak1'), 'lights', 'Lights', 'ok_defect', 'pre_shift', 1)$$), '23505', 'UNIQUE (template, stage, sequence)');
select is(tests.sqlstate_of($$insert into public.inspection_template_items (company_id, template_id, item_key, question, response_type, applies_to_stage, sequence)
  values (tests.id('coA'), tests.id('t-bak1'), 'lights', 'Lights', 'ok_defect', 'post_shift', 1)$$), null, '... the same sequence in the other stage is fine');
select is(tests.sqlstate_of($$insert into public.inspection_template_items (company_id, template_id, item_key, question, response_type, applies_to_stage, sequence)
  values (tests.id('coA'), tests.id('t-bak1'), 'x1', 'Odd', 'rating', 'pre_shift', 5)$$), '23514', 'response_type is one of ok_defect / fuel_quarter / yes_no_detail');
select is(tests.sqlstate_of($$insert into public.inspection_template_items (company_id, template_id, item_key, question, response_type, applies_to_stage, sequence, configuration)
  values (tests.id('coA'), tests.id('t-bak1'), 'x2', 'Fuel', 'fuel_quarter', 'pre_shift', 6, '{"allow_na": true}')$$), '23514', 'N/A is only possible on an ok/defect item');
select is(tests.sqlstate_of($$insert into public.inspection_template_items (company_id, template_id, item_key, question, response_type, applies_to_stage, sequence, configuration)
  values (tests.id('coA'), tests.id('t-bak1'), 'x3', 'Q', 'ok_defect', 'pre_shift', 7, '{"allow_na": "yes"}')$$), '23514', 'allow_na must be a boolean');
select is(tests.sqlstate_of($$insert into public.inspection_template_items (company_id, template_id, item_key, question, response_type, applies_to_stage, sequence, severity_rule)
  values (tests.id('coA'), tests.id('t-bak1'), 'x4', 'Q', 'ok_defect', 'pre_shift', 8, 'critical')$$), '23514', 'severity_rule is safety_critical or standard');

-- ================================================================ immutability once used
update public.inspection_templates set name = 'Bakkie checklist (edited)' where id = tests.id('t-bak1');
select is((select name from public.inspection_templates where id = tests.id('t-bak1')), 'Bakkie checklist (edited)', 'an unused template can still be edited');
update public.inspection_templates set first_used_at = now() where id = tests.id('t-bak1');
select is(tests.sqlstate_of($$update public.inspection_templates set name = 'Changed' where id = tests.id('t-bak1')$$), '23514', 'a used template cannot be renamed');
select is(tests.sqlstate_of($$update public.inspection_templates set version = 9 where id = tests.id('t-bak1')$$), '23514', '... or re-versioned');
select is(tests.sqlstate_of($$update public.inspection_templates set first_used_at = null where id = tests.id('t-bak1')$$), '23514', '... or marked unused again');
select is(tests.sqlstate_of($$update public.inspection_templates set active_status = 'active' where id = tests.id('t-bak1')$$), '23505', 'only active_status may change: re-activating is judged by the one-active rule (a newer version is active)');
select is(tests.sqlstate_of($$update public.inspection_templates set active_status = 'retired' where id = tests.id('t-bak1')$$), null, 'retiring a used template is allowed');
select is(tests.sqlstate_of($$update public.inspection_template_items set question = 'Changed' where template_id = tests.id('t-bak1') and item_key = 'tyres'$$), '23514', 'items of a used template never change');
select is(tests.sqlstate_of($$insert into public.inspection_template_items (company_id, template_id, item_key, question, response_type, applies_to_stage, sequence)
  values (tests.id('coA'), tests.id('t-bak1'), 'extra', 'Extra', 'ok_defect', 'pre_shift', 20)$$), '23514', '... and no item can be added to it');

-- ================================================================ no delete anywhere
select is(tests.sqlstate_of($$delete from public.inspection_templates where id = tests.id('t-bak1')$$), '42501', 'no DELETE on inspection_templates');
select is(tests.sqlstate_of($$delete from public.inspection_template_items where template_id = tests.id('t-bak1')$$), '42501', 'no DELETE on inspection_template_items');
select is(tests.sqlstate_of($$truncate public.inspection_templates cascade$$), '42501', 'no TRUNCATE on inspection_templates');
select is(tests.sqlstate_of($$truncate public.inspection_template_items cascade$$), '42501', 'no TRUNCATE on inspection_template_items');

-- ================================================================ RLS: readable by the company's signed-in users, no client writes
select tests.act_as('drv');
select is((select count(*)::int from public.inspection_templates), 4, 'a driver reads the company''s templates (starter + 2 bakkie versions + truck)');
select is((select count(*)::int from public.inspection_template_items where template_id = (select id from public.inspection_templates where vehicle_category is null)), 27, '... and the starter items');
select is(tests.sqlstate_of($$insert into public.inspection_templates (company_id, name, version) values (tests.id('coA'), 'Mine', 5)$$), '42501', 'no client INSERT');
select is(tests.sqlstate_of($$update public.inspection_templates set name = 'x'$$), '42501', 'no client UPDATE');
select tests.act_as('sa');
select is((select count(*)::int from public.inspection_templates), 4, 'a system administrator also reads templates (configuration, not evidence)');
select tests.act_as('fab');
select is((select count(*)::int from public.inspection_templates where company_id = tests.id('coA')), 0, 'another company''s templates are invisible');

select * from finish();
rollback;
