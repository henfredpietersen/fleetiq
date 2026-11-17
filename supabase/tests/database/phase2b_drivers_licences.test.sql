-- Slice 2B pgTAP: drivers, licences, licence-evidence privacy, account-admin functions
-- (migrations 018, 019, 020; DEC-08, DEC-23, DEC-24, DEC-34; AD-05, AD-08).
begin;
create extension if not exists pgtap with schema extensions;
select plan(103);

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

-- ---------------------------------------------------------------- fixtures (synthetic)
insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'),
  (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot', 'coA'), tests.mk_user('bootb', 'coB');
select tests.mk_user('fa', 'coA'), tests.mk_user('bm1', 'coA'), tests.mk_user('bm2', 'coA'), tests.mk_user('sup1', 'coA'),
       tests.mk_user('sm', 'coA'), tests.mk_user('ma', 'coA'), tests.mk_user('sys', 'coA');
select tests.grant_role('fa', 'fleet_admin', null, 'boot'), tests.grant_role('bm1', 'branch_manager', 'A1', 'boot'),
       tests.grant_role('bm2', 'branch_manager', 'A2', 'boot'), tests.grant_role('sup1', 'supervisor', 'A1', 'boot'),
       tests.grant_role('sm', 'senior_management', null, 'boot'), tests.grant_role('ma', 'maintenance_admin', null, 'boot'),
       tests.grant_role('sys', 'system_admin', null, 'boot');
select tests.mk_driver('drv1', 'coA', 'D001', 'A1'), tests.mk_driver('drv2', 'coA', 'D002', 'A1'),
       tests.mk_driver('drv3', 'coA', 'D003', 'A2'), tests.mk_driver('drvb', 'coB', 'D001', 'B1');

select tests.mk_evidence('lic1', 'coA', 'A1', 'licence', 'fa'), tests.mk_evidence('lic2', 'coA', 'A1', 'licence', 'fa'),
       tests.mk_evidence('lic3', 'coA', 'A2', 'licence', 'fa'), tests.mk_evidence('spare-a2', 'coA', 'A2', 'licence', 'fa'),
       tests.mk_evidence('odo', 'coA', 'A1', 'odometer', 'fa'), tests.mk_evidence('licb', 'coB', 'B1', 'licence', 'bootb');

insert into public.driver_licences (id, company_id, driver_id, licence_number, licence_code, issue_date, expiry_date,
                                    evidence_file_id, client_submission_id, created_by)
values
  (tests.id('L1'), tests.id('coA'), tests.id('d-drv1'), 'SYN-LIC-D1', 'EB', '2022-01-10', '2030-01-10', tests.id('ev-lic1'), tests.id('s1'), tests.id('fa')),
  (tests.id('L2'), tests.id('coA'), tests.id('d-drv2'), 'SYN-LIC-D2', 'EB', '2022-01-10', '2030-01-10', tests.id('ev-lic2'), tests.id('s2'), tests.id('fa')),
  (tests.id('L3'), tests.id('coA'), tests.id('d-drv3'), 'SYN-LIC-D3', 'C1', '2022-01-10', '2030-01-10', tests.id('ev-lic3'), tests.id('s3'), tests.id('fa'));

-- ================================================================ A. drivers: keys and checks
select is(tests.sqlstate_of($$insert into public.drivers (company_id, profile_id, employee_number, branch_id)
  select tests.id('coA'), tests.id('fa'), 'D001', tests.id('A1')$$), '23505',
  'employee number is unique per company');
select is((select count(*)::int from public.drivers where employee_number = 'D001'), 2,
  'the same employee number can exist in another company');
select is(tests.sqlstate_of($$insert into public.drivers (company_id, profile_id, employee_number, branch_id)
  values (tests.id('coA'), tests.id('drv1'), 'D777', tests.id('A1'))$$), '23505',
  'a profile can be linked to only one driver (profile_id UNIQUE)');
select is(tests.sqlstate_of($$insert into public.drivers (company_id, profile_id, employee_number, branch_id)
  values (tests.id('coA'), tests.id('bm1'), 'bad number', tests.id('A1'))$$), '23514',
  'employee number must be in canonical form');
select is(tests.sqlstate_of($$update public.drivers set employee_number = 'D999' where id = tests.id('d-drv1')$$), '23514',
  'employee number cannot be changed (it is the sign-in identifier)');
select is(tests.sqlstate_of($$delete from public.drivers where id = tests.id('d-drv3')$$), '42501',
  'drivers cannot be hard-deleted');

-- ================================================================ B. licence constraints
select is(tests.sqlstate_of($$insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('d-drv1'), 'X1', 'EB', '2022-01-10', '2022-01-10', tests.id('sx1'), tests.id('fa'))$$), '23514',
  'expiry date must be after issue date');
select is(tests.sqlstate_of($$insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, prdp_required, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('d-drv1'), 'X2', 'EB', '2022-01-10', '2030-01-10', true, tests.id('sx2'), tests.id('fa'))$$), '23514',
  'PrDP expiry is required when a PrDP is required');
select is(tests.sqlstate_of($$insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, evidence_file_id, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('d-drv1'), 'X3', 'EB', '2022-01-10', '2030-01-10', tests.id('ev-odo'), tests.id('sx3'), tests.id('fa'))$$), '23514',
  'evidence must have purpose licence');
select is(tests.sqlstate_of($$insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, evidence_file_id, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('d-drv1'), 'X4', 'EB', '2022-01-10', '2030-01-10', tests.id('ev-spare-a2'), tests.id('sx4'), tests.id('fa'))$$), '23514',
  'evidence must be stored against the driver''s own branch');
select is(tests.sqlstate_of($$insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, evidence_file_id, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('d-drv1'), 'X5', 'EB', '2022-01-10', '2030-01-10', tests.id('ev-licb'), tests.id('sx5'), tests.id('fa'))$$), '23514',
  'evidence from another company is refused');
select is(tests.sqlstate_of($$insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, evidence_file_id, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('d-drv1'), 'X6', 'EB', '2022-01-10', '2030-01-10', tests.id('ev-lic1'), tests.id('sx6'), tests.id('fa'))$$), '23505',
  'one licence photo cannot back two licence records');
select is(tests.sqlstate_of($$insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date, client_submission_id, created_by)
  values (tests.id('coA'), tests.id('d-drv1'), 'SYN-LIC-D1', 'EB', '2022-01-10', '2031-01-10', tests.id('sx7'), tests.id('fa'))$$), '23505',
  'the same licence number and issue date is not recorded twice for a driver');
select is(tests.sqlstate_of($$update public.driver_licences set verification_status = 'verified', verified_by = created_by, verified_at = now()
  where id = tests.id('L1')$$), '23514', 'verifier <> creator is enforced by a CHECK (DEC-24)');
select is(tests.sqlstate_of($$update public.driver_licences set licence_number = 'CHANGED' where id = tests.id('L2')$$), '23514',
  'licence content is immutable after capture');
select is(tests.sqlstate_of($$delete from public.driver_licences where id = tests.id('L3')$$), '42501',
  'licence records cannot be hard-deleted');

-- ================================================================ C. who sees licence numbers (RLS)
select tests.act_as('sm');
select is(tests.n('select count(*)::int from public.driver_licences'), 0, 'senior management cannot read licence numbers');
select is(tests.n('select count(*)::int from public.driver_licences_safe'), 3, 'senior management sees the safe view (expiry, class, status)');
select is(tests.n('select count(*)::int from public.drivers'), 3, 'senior management sees the register of their company');
select tests.act_as('ma');
select is(tests.n('select count(*)::int from public.driver_licences'), 0, 'maintenance admin cannot read licence numbers');
select is(tests.n('select count(*)::int from public.drivers') + tests.n('select count(*)::int from public.driver_licences_safe'), 0,
  'maintenance admin does not see the driver register at all');
select tests.act_as('sys');
select is(tests.n('select count(*)::int from public.driver_licences') + tests.n('select count(*)::int from public.drivers'), 0,
  'system admin has no access to licence data or the register');
select tests.act_as('drv1');
select is((select string_agg(licence_number, ',') from public.driver_licences), 'SYN-LIC-D1', 'a driver sees their own licence only');
select is(tests.n('select count(*)::int from public.drivers'), 1, 'a driver sees only their own driver row');
select tests.act_as('sup1');
select is(tests.n('select count(*)::int from public.driver_licences'), 2, 'a supervisor sees licences of their own branch');
select is(tests.n('select count(*)::int from public.driver_register where phone is not null'), 0,
  'a supervisor sees names but not phone numbers (driver.manage only)');
select tests.act_as('bm1');
select is(tests.n('select count(*)::int from public.driver_licences'), 2, 'a branch manager sees licences of their own branch only');
select is(tests.n($$select count(*)::int from public.driver_licences where licence_number = 'SYN-LIC-D3'$$), 0, '… not another branch''s');
select tests.act_as('bm2');
select is(tests.n('select count(*)::int from public.driver_licences'), 1, 'the other branch manager sees only theirs');
select tests.act_as('fa');
select is(tests.n('select count(*)::int from public.driver_licences'), 3, 'a fleet administrator sees all licences');
select is(tests.n('select count(*)::int from public.driver_register where phone is not null'), 3, 'driver.manage holders see phone numbers');
select tests.reset();
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name in ('driver_licences_safe', 'driver_register')
              and column_name in ('licence_number', 'evidence_file_id')), 0,
  'the safe views have no licence_number or evidence column');

-- ================================================================ D. licence evidence privacy (019)
select tests.act_as('sm');
select is(tests.n('select count(*)::int from public.evidence_files'), 1, 'senior management sees non-licence evidence only (the odometer photo)');
select is(tests.sqlstate_of($$select * from public.issue_evidence_access(tests.id('ev-lic1'))$$), '42501', 'senior management cannot get a signed grant for a licence photo');
select ok(public.can_view_evidence(tests.id('coA'), tests.id('A1'), tests.id('fa'), 'odometer'), 'non-licence evidence is unchanged for senior management');
select ok(not public.can_view_evidence(tests.id('coA'), tests.id('A1'), tests.id('fa'), 'licence'), 'licence evidence is not');
select tests.act_as('ma');
select is(tests.n($$select count(*)::int from public.evidence_files where purpose = 'licence'$$), 0, 'maintenance admin cannot see licence photos');
select tests.act_as('sup1');
select is(tests.n($$select count(*)::int from public.evidence_files where purpose = 'licence'$$), 2, 'a supervisor sees licence photos of their branch');
select tests.act_as('bm1');
select is(tests.n($$select count(*)::int from public.evidence_files where purpose = 'licence'$$), 2, 'a branch manager sees licence photos of their branch only');
select tests.act_as('fa');
select is(tests.n($$select count(*)::int from public.evidence_files where purpose = 'licence' and company_id = tests.id('coA')$$), 4, 'a fleet administrator sees all licence photos of the company');
select tests.act_as('drv1');
select is((select string_agg(id::text, ',') from public.evidence_files where purpose = 'licence'), tests.id('ev-lic1')::text, 'a driver sees their own licence photo only');
select lives_ok($$select * from public.issue_evidence_access(tests.id('ev-lic1'))$$, 'a driver can open their own licence photo (logged grant)');
select tests.act_as('drv2');
select is(tests.n($$select count(*)::int from public.evidence_files where id = tests.id('ev-lic1')$$), 0, 'a driver cannot see another driver''s licence photo');
select is(tests.sqlstate_of($$select * from public.issue_evidence_access(tests.id('ev-lic1'))$$), '42501', '… nor get a grant for it');
select tests.reset();

-- ================================================================ E. licence write functions and DEC-24
select tests.act_as('sup1');
select is(tests.sqlstate_of($$select public.record_driver_licence(tests.id('d-drv1'), 'SYN-NEW', 'EB', date '2023-01-01', date '2031-01-01', false, null, null, tests.id('sn1'))$$), '42501',
  'a supervisor cannot record licences');
select is(tests.sqlstate_of($$select public.update_driver_details(tests.id('d-drv1'), 'New Name', null)$$), '42501', 'a supervisor cannot edit drivers');
select ok(not public.has_permission('driver.manage', tests.id('A1')), 'a supervisor does not hold driver.manage');
select tests.act_as('fa');
select lives_ok($$select public.record_driver_licence(tests.id('d-drv2'), 'SYN-LIC-D2B', 'EB', date '2023-01-01', date '2031-01-01', false, null, null, tests.id('sn2'))$$,
  'a fleet administrator records a licence');
select is((select count(*)::int from public.driver_licences where licence_number = 'SYN-LIC-D2B'), 1, 'the licence record exists');
select is(public.record_driver_licence(tests.id('d-drv2'), 'SYN-LIC-D2B', 'EB', date '2023-01-01', date '2031-01-01', false, null, null, tests.id('sn2')),
  (select id from public.driver_licences where licence_number = 'SYN-LIC-D2B'), 'a retry with the same client_submission_id returns the same record');
select is((select count(*)::int from public.driver_licences where licence_number = 'SYN-LIC-D2B'), 1, '… and creates no second row');
select is(tests.sqlstate_of($$select public.verify_driver_licence(tests.id('L1'), 'verified')$$), '42501',
  'nobody verifies a record they created (DEC-24), enforced in the database function');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.verify_driver_licence(tests.id('L1'), 'rejected')$$), '22023', 'rejecting needs a reason');
select lives_ok($$select public.verify_driver_licence(tests.id('L1'), 'verified')$$, 'a different administrator can verify');
select tests.reset();
select is((select verification_status || ':' || (verified_by = tests.id('bm1'))::text from public.driver_licences where id = tests.id('L1')), 'verified:true',
  'the verifier is recorded');
select tests.act_as('bm1');
select is(tests.sqlstate_of($$select public.verify_driver_licence(tests.id('L1'), 'verified')$$), '55000', 'a decided record cannot be decided again');
select tests.reset();
select is(tests.sqlstate_of($$update public.driver_licences set verified_at = now() where id = tests.id('L1')$$), '55000', 'a decided record cannot change at all');
select tests.act_as('bm2');
select is(tests.sqlstate_of($$select public.verify_driver_licence(tests.id('L2'), 'verified')$$), '42501', 'a branch manager cannot verify another branch''s licence');
select tests.act_as('fa');
select is(tests.sqlstate_of($$insert into public.drivers (company_id, profile_id, employee_number, branch_id) values (tests.id('coA'), tests.id('bm2'), 'D555', tests.id('A1'))$$), '42501',
  'clients have no INSERT on drivers');
select is(tests.sqlstate_of($$update public.driver_licences set verification_status = 'verified' where id = tests.id('L3')$$), '42501',
  'clients have no UPDATE on driver_licences');
select lives_ok($$select public.set_driver_status(tests.id('d-drv2'), 'inactive', 'Left the company')$$, 'deactivate a driver with a reason');
select tests.reset();
select is((select active_status || ':' || p.status from public.drivers d join public.profiles p on p.id = d.profile_id where d.id = tests.id('d-drv2')), 'inactive:disabled',
  'deactivating also stops sign-in (profile disabled); nothing is deleted');
select ok(not public.access_cleared(tests.id('drv2')), 'a deactivated driver has no access');
select tests.act_as('fa');
select is(tests.sqlstate_of($$select public.record_driver_licence(tests.id('d-drv2'), 'SYN-LIC-D2C', 'EB', date '2023-01-01', date '2031-01-01', false, null, null, tests.id('sn3'))$$), '23514',
  'licences cannot be recorded for an inactive driver');
select is(tests.sqlstate_of($$select public.set_driver_status(tests.id('d-drv2'), 'inactive', '')$$), '22023', 'a reason is required to change status');
select tests.reset();

-- ================================================================ F. account administration functions (020)
select is(tests.sqlstate_of($$select public.admin_create_driver(tests.id('sup1'), tests.id('nd1'), tests.id('A1'), 'D900', 'd-abc123@drivers.fleetiq.invalid', 'Synthetic New', null)$$), '42501',
  'a supervisor cannot create drivers');
select is(tests.sqlstate_of($$select public.admin_create_driver(tests.id('bm1'), tests.id('nd1'), tests.id('A2'), 'D900', 'd-abc123@drivers.fleetiq.invalid', 'Synthetic New', null)$$), '42501',
  'a branch manager cannot create drivers in another branch');
insert into auth.users (id, email) values (tests.id('nd1'), 'd-abc123@drivers.fleetiq.invalid');
select is(tests.sqlstate_of($$select public.admin_create_driver(tests.id('fa'), tests.id('nd1'), tests.id('A1'), 'D900', 'real-looking@example.com', 'Synthetic New', null)$$), '23514',
  'a driver login identifier must be the internal, non-deliverable kind (AD-08)');
select lives_ok($$select public.admin_create_driver(tests.id('fa'), tests.id('nd1'), tests.id('A1'), 'D900', 'd-abc123@drivers.fleetiq.invalid', 'Synthetic New', '0000000')$$,
  'a fleet administrator creates a driver (profile, driver row, role)');
select is((select must_change_pin::text || ':' || user_type from public.profiles where id = tests.id('nd1')), 'true:driver', 'the temporary PIN must be changed');
select is((select count(*)::int from public.drivers where profile_id = tests.id('nd1') and employee_number = 'D900' and branch_id = tests.id('A1')), 1, 'the driver row exists');
select is((select count(*)::int from public.user_roles ur join public.roles r on r.id = ur.role_id
            where ur.user_id = tests.id('nd1') and r.name = 'driver' and ur.branch_id = tests.id('A1') and ur.granted_by = tests.id('fa')), 1,
  'the driver role is granted at the branch, by the administrator (never by the driver)');
select ok(not public.access_cleared(tests.id('nd1')), 'access is not cleared until the PIN is changed');
select tests.act_as('nd1');
select ok(not public.has_permission('evidence.view', tests.id('A1')), 'a driver with a temporary PIN holds no permissions yet');
select tests.reset();
select public.auth_complete_pin_change(tests.id('nd1'));
select ok(public.access_cleared(tests.id('nd1')), 'after the PIN change access is cleared');
select tests.act_as('nd1');
select ok(public.has_permission('evidence.view', tests.id('A1')), '… and the driver role applies');
select tests.reset();
select cmp_ok((select count(*)::int from public.audit_logs where actor_id = tests.id('fa') and entity_type in ('drivers', 'profiles', 'user_roles')
                 and occurred_at >= now() - interval '1 hour' and entity_id in (tests.id('nd1'), (select id from public.drivers where profile_id = tests.id('nd1')))),
  '>=', 2, 'creating a driver leaves audit rows attributed to the administrator');
select ok(exists (select 1 from public.audit_logs where actor_id = tests.id('fa') and reason = 'driver PIN issued by administrator' and entity_id = tests.id('nd1')),
  'the PIN issue is audited with its reason');

-- atomic: a failure part-way leaves nothing behind (the server then deletes the Auth user)
insert into auth.users (id, email) values (tests.id('nd2'), 'd-def456@drivers.fleetiq.invalid');
select is(tests.sqlstate_of($$select public.admin_create_driver(tests.id('fa'), tests.id('nd2'), tests.id('A1'), 'D900', 'd-def456@drivers.fleetiq.invalid', 'Synthetic Dup', null)$$), '23505',
  'a duplicate employee number fails');
select is((select count(*)::int from public.profiles where id = tests.id('nd2')) + (select count(*)::int from public.user_roles where user_id = tests.id('nd2'))
          + (select count(*)::int from public.drivers where profile_id = tests.id('nd2')), 0,
  'and leaves no profile, driver or role behind (no orphan)');

-- PIN reset: clears the lock, forces a change, audited (reuses auth_issue_pin_flags)
update public.profiles set locked_until = now() + interval '1 hour', must_change_pin = false where id = tests.id('drv1');
select public.auth_issue_pin_flags(tests.id('drv1'), tests.id('fa'), 'reset');
select is((select (locked_until is null)::text || ':' || must_change_pin::text from public.profiles where id = tests.id('drv1')), 'true:true', 'a PIN reset clears the lockout and forces a change');
select ok(exists (select 1 from public.audit_logs where actor_id = tests.id('fa') and reason = 'driver PIN reset by administrator' and entity_id = tests.id('drv1')), 'the reset is audited');
select is(tests.sqlstate_of($$select public.auth_issue_pin_flags(tests.id('fa'), tests.id('fa'), 'reset')$$), '42501', 'nobody resets their own PIN');

-- staff accounts
insert into auth.users (id, email) values (tests.id('ns1'), 'newstaff@example.test');
select is(tests.sqlstate_of($$select public.admin_create_staff(tests.id('fa'), tests.id('ns1'), 'newstaff@example.test', 'Synthetic Staff')$$), '42501',
  'only users.roles.manage can create staff (a fleet administrator cannot)');
select is(tests.sqlstate_of($$select public.admin_create_staff(tests.id('sys'), tests.id('ns1'), 'NewStaff@Example.test', 'Synthetic Staff')$$), '22023', 'staff email must be lower-case and deliverable');
select lives_ok($$select public.admin_create_staff(tests.id('sys'), tests.id('ns1'), 'newstaff@example.test', 'Synthetic Staff')$$, 'a system administrator creates a staff profile');
select is((select must_change_pin::text || ':' || user_type || ':' || email from public.profiles where id = tests.id('ns1')), 'true:staff:newstaff@example.test', 'the staff password must be changed at first sign-in');
select ok(exists (select 1 from public.audit_logs where actor_id = tests.id('sys') and reason = 'staff account created by administrator' and entity_id = tests.id('ns1')), 'staff creation is audited');
select public.auth_complete_password_change(tests.id('ns1'));
select is((select must_change_pin::text from public.profiles where id = tests.id('ns1')), 'false', 'changing the password clears the forced-change flag');
select public.auth_issue_staff_password_flags(tests.id('ns1'), tests.id('sys'));
select is((select must_change_pin::text from public.profiles where id = tests.id('ns1')), 'true', 'a staff password reset forces a change');
select is(tests.sqlstate_of($$select public.auth_issue_staff_password_flags(tests.id('sys'), tests.id('sys'))$$), '42501', 'nobody resets their own password through the admin path');
select is(tests.sqlstate_of($$select public.auth_issue_staff_password_flags(tests.id('drv1'), tests.id('sys'))$$), '42501', 'the staff path refuses a driver target');
select public.auth_complete_password_change(tests.id('ns1'));

-- role assignment: reuse of the user_roles policies
select tests.act_as('sys');
select is(tests.sqlstate_of($$insert into public.user_roles (user_id, role_id, company_id, branch_id, granted_by)
  select tests.id('sys'), r.id, tests.id('coA'), null, tests.id('sys') from public.roles r where r.name = 'fleet_admin' and r.company_id is null$$), '42501',
  'a user cannot grant themselves a role');
select lives_ok($$insert into public.user_roles (user_id, role_id, company_id, branch_id, granted_by)
  select tests.id('ns1'), r.id, tests.id('coA'), tests.id('A1'), tests.id('sys') from public.roles r where r.name = 'supervisor' and r.company_id is null$$,
  'users.roles.manage can assign a branch-scoped role to someone else');
select tests.act_as('fa');
select is(tests.sqlstate_of($$insert into public.user_roles (user_id, role_id, company_id, branch_id, granted_by)
  select tests.id('ns1'), r.id, tests.id('coA'), null, tests.id('fa') from public.roles r where r.name = 'supervisor' and r.company_id is null$$), '42501',
  'without users.roles.manage nobody can assign roles');
select tests.reset();
select ok(exists (select 1 from public.audit_logs where actor_id = tests.id('sys') and entity_type = 'user_roles' and (after_values ->> 'user_id') = tests.id('ns1')::text), 'role assignment is audited');

-- ================================================================ G. privileges and audit hygiene
select is((select count(*)::int from unnest(array['admin_create_driver(uuid,uuid,uuid,text,text,text,text)', 'admin_create_staff(uuid,uuid,text,text)',
   'user_has_permission(uuid,text,uuid)', 'auth_issue_staff_password_flags(uuid,uuid)', 'auth_complete_password_change(uuid)']) f
   where has_function_privilege('anon', 'public.' || f, 'execute') or has_function_privilege('authenticated', 'public.' || f, 'execute')
      or has_function_privilege('public', 'public.' || f, 'execute')), 0, 'the admin functions are not executable by anon, authenticated or PUBLIC');
select is((select count(*)::int from unnest(array['admin_create_driver(uuid,uuid,uuid,text,text,text,text)', 'admin_create_staff(uuid,uuid,text,text)',
   'user_has_permission(uuid,text,uuid)', 'auth_issue_staff_password_flags(uuid,uuid)', 'auth_complete_password_change(uuid)']) f
   where has_function_privilege('service_role', 'public.' || f, 'execute')), 5, 'the service role can run them');
select is((select count(*)::int from unnest(array['driver_licences_guard()', 'driver_licences_validate()']) f
   where has_function_privilege('anon', 'public.' || f, 'execute') or has_function_privilege('authenticated', 'public.' || f, 'execute')
      or has_function_privilege('public', 'public.' || f, 'execute')), 0, 'the new trigger functions are not executable by anon, authenticated or PUBLIC');
select is((select count(*)::int
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype and p.prosecdef
              and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
  'still no SECURITY DEFINER trigger function in public is client-executable');
select is((select count(*)::int from unnest(array['update_driver_details(uuid,text,text)', 'set_driver_status(uuid,text,text)',
   'record_driver_licence(uuid,text,text,date,date,boolean,date,uuid,uuid)', 'verify_driver_licence(uuid,text,text)']) f
   where has_function_privilege('authenticated', 'public.' || f, 'execute') and not has_function_privilege('anon', 'public.' || f, 'execute')), 4,
  'driver write functions are callable by signed-in users only (they authorise themselves)');
select is((select count(*)::int from public.audit_logs
            where before_values::text like '%SYN-LIC%' or after_values::text like '%SYN-LIC%' or before_values::text like '%SYN-NEW%' or after_values::text like '%SYN-NEW%'), 0,
  'licence numbers never appear in audit values');
select cmp_ok((select count(*)::int from public.audit_logs where entity_type = 'driver_licences'), '>=', 3, 'licence records are audited');

select * from finish();
rollback;
