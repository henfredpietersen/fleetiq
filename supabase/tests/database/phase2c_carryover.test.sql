-- Slice 2C carry-over pgTAP (migration 021): C1 security_invoker views, C2 admin-flag permission refusals, C3 DEC-37 comment.
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

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


insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2');
select tests.mk_user('boot', 'coA'), tests.mk_user('fa', 'coA'), tests.mk_user('bm2', 'coA'), tests.mk_user('sup1', 'coA'),
       tests.mk_user('sys', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('ns1', 'coA');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('bm2', 'branch_manager', 'A2', 'boot'),
       tests.grant_role('sup1', 'supervisor', 'A1', 'boot'), tests.grant_role('sys', 'system_admin', null, 'boot'),
       tests.grant_role('ma', 'maintenance_admin', null, 'boot');
select tests.mk_driver('drv1', 'coA', 'D001', 'A1');
insert into public.driver_licences (id, company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, client_submission_id, created_by)
values (tests.id('L1'), tests.id('coA'), tests.id('d-drv1'), 'SYN-LIC-1', 'EB', '2022-01-10', '2030-01-10', tests.id('s1'), tests.id('fa'));

-- ================================================================ C1
select ok((select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.driver_register'::regclass), 'driver_register is security_invoker');
select ok((select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.driver_licences_safe'::regclass), 'driver_licences_safe is security_invoker');
select is((select array_agg(attname::text order by attnum) from pg_attribute where attrelid = 'public.driver_register'::regclass and attnum > 0),
  array['id','company_id','branch_id','employee_number','active_status','display_name','phone','pin_change_pending','licence_expiry_date','prdp_expiry_date','licence_verification_status'],
  'driver_register keeps its columns and order');
select is((select array_agg(attname::text order by attnum) from pg_attribute where attrelid = 'public.driver_licences_safe'::regclass and attnum > 0),
  array['id','company_id','driver_id','branch_id','licence_code','issue_date','expiry_date','prdp_required','prdp_expiry_date','verification_status','has_evidence','created_at'],
  'driver_licences_safe keeps its columns and order');
select ok((select prosecdef and provolatile = 's' and proconfig = array['search_path=""'] from pg_proc where oid = 'public.driver_register_rows()'::regprocedure), 'driver_register_rows is SECURITY DEFINER STABLE with an empty search_path');
select ok((select prosecdef and provolatile = 's' and proconfig = array['search_path=""'] from pg_proc where oid = 'public.driver_licences_safe_rows()'::regprocedure), 'driver_licences_safe_rows is SECURITY DEFINER STABLE with an empty search_path');
select tests.act_as('sup1');
select is((select count(*)::int from public.driver_register), 1, 'supervisor in scope still sees the driver');
select is((select count(*)::int from public.driver_register where phone is null and pin_change_pending is null), 1, 'supervisor (no driver.manage) still gets no phone or PIN flag');
select is((select count(*)::int from public.driver_licences_safe), 1, 'supervisor still sees the safe licence row');
select tests.act_as('fa');
select is((select count(*)::int from public.driver_register where phone is not null), 1, 'fleet admin (driver.manage) still sees the phone');
select tests.act_as('bm2');
select is((select count(*)::int from public.driver_register), 0, 'branch manager of another branch still sees nothing');
select tests.act_as('ma');
select is((select count(*)::int from public.driver_register), 0, 'maintenance admin still sees nothing');
select is((select count(*)::int from public.driver_register_rows()), 0, 'the function returns the same nothing');
select tests.act_anon();
select throws_ok($$select * from public.driver_register_rows()$$, '42501', null, 'anon cannot call driver_register_rows()');

-- ================================================================ C2 (service role only)
select tests.act_service();
select is(tests.sqlstate_of($$select public.auth_issue_staff_password_flags(tests.id('ns1'), tests.id('bm2'))$$), '42501', 'staff password flags: an actor without users.roles.manage is refused');
select lives_ok($$select public.auth_issue_staff_password_flags(tests.id('ns1'), tests.id('sys'))$$, 'staff password flags: system admin allowed');
select is(tests.sqlstate_of($$select public.auth_issue_pin_flags(tests.id('drv1'), tests.id('bm2'), 'reset')$$), '42501', 'PIN flags: driver.manage in another branch is refused');
select is(tests.sqlstate_of($$select public.auth_issue_pin_flags(tests.id('drv1'), tests.id('sup1'), 'reset')$$), '42501', 'PIN flags: supervisor without driver.manage is refused');
select lives_ok($$select public.auth_issue_pin_flags(tests.id('drv1'), tests.id('fa'), 'reset')$$, 'PIN flags: fleet admin allowed');

-- ================================================================ C3
select tests.reset();
select ok((select obj_description('public.driver_register_visible(uuid, uuid)'::regprocedure, 'pg_proc')
           like 'DEC-37 Approved 2026-11-17: supervisor, fleet admin, branch manager, senior management within scope; driver own record; maintenance and system admin none.%'), 'DEC-37 recorded on driver_register_visible');

select finish();
rollback;
