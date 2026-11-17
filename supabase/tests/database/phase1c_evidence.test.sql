-- Phase 1C pgTAP: private evidence storage (migrations 000010, 000011).
--   slots + server-chosen path · permission per purpose · idempotency · register only via service role ·
--   evidence rows immutable · Own/Branch/All visibility · cross-branch/company denial ·
--   access log for every signed URL · cleanup of unregistered uploads · storage policies · private bucket
begin;
create extension if not exists pgtap with schema extensions;
select plan(95);

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
create function tests.fails(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when others then return true; end $$;
create function tests.affected(q text) returns bigint language plpgsql as $$
declare n bigint; begin execute q; get diagnostics n = row_count; return n; end $$;
create function tests.mk_user(n text, comp text, utype text default 'staff') returns void language sql as $$
  insert into auth.users (id, email) values (tests.id(n), n || '@example.test');
  insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier)
  values (tests.id(n), tests.id(comp), 'Synthetic ' || n, n || '@example.test', utype, n);
$$;
create function tests.grant_role(n text, role_name text, branch text, by text,
  from_ts timestamptz default now() - interval '5 hours', to_ts timestamptz default null) returns void language sql as $$
  insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, effective_to, granted_by)
  select tests.id(n), r.id, p.company_id, case when branch is null then null else tests.id(branch) end, from_ts, to_ts, tests.id(by)
  from public.roles r, public.profiles p where r.name = role_name and r.company_id is null and p.id = tests.id(n);
$$;
create function tests.sqlstate(q text) returns text language plpgsql as $$
begin execute q; return null; exception when others then return sqlstate; end $$;
-- Request a slot as `usr`, then register it the way the server does (service path); returns the evidence file id.
create function tests.mk_evidence(lbl text, usr text, br text, purp text) returns uuid language plpgsql as $$
declare s public.evidence_upload_slots; f uuid;
begin
  perform tests.act_as(usr);
  s := public.request_evidence_upload_slot(purp, tests.id(br), 'in_app_camera', 'image/jpeg', 1000, tests.id('csid-' || lbl));
  perform tests.reset();
  f := public.register_evidence_file(s.id, tests.id(usr), md5(lbl) || md5(lbl), 'image/jpeg', 1000, 100, 100, true);
  return f;
end $$;

insert into public.companies (id, name) values (tests.id('coA'), 'Synthetic Co A'), (tests.id('coB'), 'Synthetic Co B');
insert into public.branches (id, company_id, name, branch_code) values
  (tests.id('A1'), tests.id('coA'), 'A one', 'A1'), (tests.id('A2'), tests.id('coA'), 'A two', 'A2'),
  (tests.id('B1'), tests.id('coB'), 'B one', 'B1');
select tests.mk_user('boot_a', 'coA', 'staff'), tests.mk_user('boot_b', 'coB', 'staff'),
       tests.mk_user('drv_a1', 'coA', 'driver'), tests.mk_user('drv_a1b', 'coA', 'driver'), tests.mk_user('drv_a2', 'coA', 'driver'),
       tests.mk_user('drv_b1', 'coB', 'driver'),
       tests.mk_user('sup_a1', 'coA'), tests.mk_user('sup_a2', 'coA'), tests.mk_user('fla', 'coA'), tests.mk_user('mnt', 'coA'),
       tests.mk_user('bm_a1', 'coA'), tests.mk_user('sm', 'coA'), tests.mk_user('sa', 'coA'), tests.mk_user('fla_b', 'coB'),
       tests.mk_user('expd', 'coA');
select tests.grant_role('drv_a1', 'driver', 'A1', 'boot_a'), tests.grant_role('drv_a1b', 'driver', 'A1', 'boot_a'),
       tests.grant_role('drv_a2', 'driver', 'A2', 'boot_a'), tests.grant_role('drv_b1', 'driver', 'B1', 'boot_b'),
       tests.grant_role('sup_a1', 'supervisor', 'A1', 'boot_a'), tests.grant_role('sup_a2', 'supervisor', 'A2', 'boot_a'),
       tests.grant_role('fla', 'fleet_admin', null, 'boot_a'), tests.grant_role('mnt', 'maintenance_admin', null, 'boot_a'),
       tests.grant_role('bm_a1', 'branch_manager', 'A1', 'boot_a'), tests.grant_role('sm', 'senior_management', null, 'boot_a'),
       tests.grant_role('sa', 'system_admin', null, 'boot_a'), tests.grant_role('fla_b', 'fleet_admin', null, 'boot_b'),
       tests.grant_role('expd', 'fleet_admin', null, 'boot_a', now() - interval '5 hours', now() - interval '1 hour');

-- evidence: F1 drv_a1/A1/odometer · F2 drv_a1b/A1/odometer · F3 drv_a2/A2/incident · F4 mnt/A1/service_record · F5 drv_b1/B1/odometer
select tests.mk_evidence('F1', 'drv_a1', 'A1', 'odometer');
select tests.mk_evidence('F2', 'drv_a1b', 'A1', 'odometer');
select tests.mk_evidence('F3', 'drv_a2', 'A2', 'incident');
select tests.mk_evidence('F4', 'mnt', 'A1', 'service_record');
select tests.mk_evidence('F5', 'drv_b1', 'B1', 'odometer');

-- ---------------------------------------------------------------- 1. purposes and permissions
select is((select array_agg(public.evidence_upload_permission(p) order by p)
           from unnest(array['odometer','inspection','damage','incident','vehicle_document','licence','service_record']) p),
          array['inspection.submit','incident.record','inspection.submit','driver.manage','inspection.submit','service.record.create','vehicle.manage']::text[],
          'purpose -> permission map is the documented one (damage, incident, inspection, licence, odometer, service_record, vehicle_document)');

-- ---------------------------------------------------------------- 2. requesting a slot
select tests.act_as('drv_a1');
select ok((select object_path from public.request_evidence_upload_slot('odometer', tests.id('A1'), 'in_app_camera', 'image/png', 500, tests.id('req-1')))
          ~ ('^' || tests.id('coA') || '/' || tests.id('A1') || '/odometer/[0-9a-f-]{36}\.png$'),
          'driver gets a server-chosen path <company>/<branch>/<purpose>/<uuid>.<ext>');
select is((select (public.request_evidence_upload_slot('odometer', tests.id('A1'), 'in_app_camera', 'image/png', 500, tests.id('req-1'))).id),
          (select (public.request_evidence_upload_slot('odometer', tests.id('A1'), 'in_app_camera', 'image/png', 500, tests.id('req-1'))).id),
          'retry with the same client_submission_id returns the same slot');
select tests.reset();
select is((select count(*) from public.evidence_upload_slots where client_submission_id = tests.id('req-1')), 1::bigint,
          'retries do not create a second slot');
select tests.act_as('drv_a1');
select ok(tests.fails($$ select public.request_evidence_upload_slot('odometer', tests.id('A1'), 'in_app_camera', 'image/jpeg', 500, tests.id('req-1')) $$),
          'client_submission_id reused with different parameters is refused');
select ok(tests.fails($$ select public.request_evidence_upload_slot('odometer', tests.id('A2'), 'in_app_camera', 'image/jpeg', 500, tests.id('req-2')) $$),
          'driver cannot request a slot for another branch');
select ok(tests.fails($$ select public.request_evidence_upload_slot('odometer', tests.id('B1'), 'in_app_camera', 'image/jpeg', 500, tests.id('req-3')) $$),
          'driver cannot request a slot in another company');
select ok(tests.fails($$ select public.request_evidence_upload_slot('licence', tests.id('A1'), 'file_upload', 'image/jpeg', 500, tests.id('req-4')) $$),
          'driver lacks driver.manage: no licence evidence');
select ok(tests.fails($$ select public.request_evidence_upload_slot('nonsense', tests.id('A1'), 'file_upload', 'image/jpeg', 500, tests.id('req-5')) $$),
          'unknown purpose refused');
select ok(tests.fails($$ select public.request_evidence_upload_slot('odometer', tests.id('A1'), 'import', 'image/jpeg', 500, tests.id('req-6')) $$),
          'clients cannot claim the server-side "import" capture source');
select ok(tests.fails($$ select public.request_evidence_upload_slot('odometer', null, 'in_app_camera', 'image/jpeg', 500, tests.id('req-7')) $$),
          'branch-scoped driver cannot request a company-level slot');
select ok((select expires_at <= now() + interval '121 minutes' from public.request_evidence_upload_slot('odometer', tests.id('A1'), 'in_app_camera', 'image/jpeg', 500, tests.id('req-8'), null, 100000)),
          'slot expiry is capped (<= 120 minutes)');
select tests.act_as('sa');
select ok(tests.fails($$ select public.request_evidence_upload_slot('odometer', tests.id('A1'), 'in_app_camera', 'image/jpeg', 500, tests.id('req-9')) $$),
          'system admin has no evidence/inspection permission: refused');
select tests.act_as('expd');
select ok(tests.fails($$ select public.request_evidence_upload_slot('service_record', tests.id('A1'), 'file_upload', 'image/jpeg', 500, tests.id('req-10')) $$),
          'an expired grant gives no upload permission');
select tests.reset();
set local role anon;
select ok(tests.fails($$ select public.request_evidence_upload_slot('odometer', null, 'in_app_camera', 'image/jpeg', 500, tests.id('req-11')) $$),
          'anonymous callers cannot request slots');
select tests.reset();

-- ---------------------------------------------------------------- 3. register (service role only)
select tests.act_as('drv_a1');
select ok(tests.fails($$ select public.register_evidence_file(gen_random_uuid(), tests.id('drv_a1'), repeat('a', 64), 'image/jpeg', 10, 1, 1, true) $$),
          'registration is not callable by signed-in users');
select tests.reset();
create function tests.mk_slot(lbl text, usr text, br text, purp text) returns uuid language plpgsql as $$
declare s public.evidence_upload_slots;
begin
  perform tests.act_as(usr);
  s := public.request_evidence_upload_slot(purp, tests.id(br), 'gallery', 'image/jpeg', 1000, tests.id(lbl));
  perform tests.reset();
  return s.id;
end $$;
create function tests.slot(lbl text) returns uuid language sql stable as $$
  select id from public.evidence_upload_slots where client_submission_id = tests.id(lbl) $$;
select tests.mk_slot('reg-1', 'drv_a1', 'A1', 'odometer'), tests.mk_slot('reg-2', 'drv_a1', 'A1', 'odometer'),
       tests.mk_slot('reg-3', 'drv_a1', 'A1', 'odometer'), tests.mk_slot('reg-4', 'drv_a1', 'A1', 'odometer');

set local role service_role;
select ok(public.register_evidence_file(tests.slot('reg-1'), tests.id('drv_a1'), repeat('ab', 32), 'image/jpeg', 1234, 640, 480, true) is not null,
          'server registration (service role) creates the evidence row');
select is(public.register_evidence_file(tests.slot('reg-1'), tests.id('drv_a1'), repeat('cd', 32), 'image/jpeg', 1234, 640, 480, true),
          (select evidence_file_id from public.evidence_upload_slots where id = tests.slot('reg-1')),
          'registration retry is idempotent: returns the same evidence id (and ignores a different hash)');
select is(tests.sqlstate($$ select public.register_evidence_file(tests.slot('reg-2'), tests.id('drv_a1b'), repeat('ab', 32), 'image/jpeg', 10, 1, 1, true) $$),
          'EV001', 'a slot cannot be registered for someone else (tampered user/slot)');
select tests.reset();
update public.evidence_upload_slots set expires_at = now() - interval '1 minute' where id = tests.slot('reg-2');
update public.evidence_upload_slots set status = 'abandoned' where id = tests.slot('reg-3');
set local role service_role;
select is(tests.sqlstate($$ select public.register_evidence_file(tests.slot('reg-2'), tests.id('drv_a1'), repeat('ab', 32), 'image/jpeg', 10, 1, 1, true) $$),
          'EV002', 'an expired slot cannot be registered');
select is(tests.sqlstate($$ select public.register_evidence_file(tests.slot('reg-3'), tests.id('drv_a1'), repeat('ab', 32), 'image/jpeg', 10, 1, 1, true) $$),
          'EV003', 'an abandoned (cleaned-up) slot cannot be registered');
select ok(tests.fails($$ select public.register_evidence_file(tests.slot('reg-4'), tests.id('drv_a1'), 'not-a-sha', 'image/jpeg', 10, 1, 1, true) $$),
          'a malformed hash is refused by the table constraint');
select tests.reset();
select is((select count(*) from public.evidence_files f join public.evidence_upload_slots s on s.evidence_file_id = f.id where s.client_submission_id = tests.id('reg-1')), 1::bigint,
          'exactly one evidence row after retries');
select is((select f.sha256 || '|' || f.size_bytes || '|' || f.capture_source || '|' || f.purpose || '|' || f.exif_gps_stripped || '|' || f.uploaded_by
           from public.evidence_files f join public.evidence_upload_slots s on s.evidence_file_id = f.id where s.client_submission_id = tests.id('reg-1')),
          repeat('ab', 32) || '|1234|gallery|odometer|true|' || tests.id('drv_a1'),
          'row records the server-given hash, size, capture source (from the slot), purpose and uploader');
select ok((select f.server_received_at > now() - interval '1 minute' and f.device_capture_at is null
           from public.evidence_files f join public.evidence_upload_slots s on s.evidence_file_id = f.id where s.client_submission_id = tests.id('reg-1')),
          'server receipt time is recorded; device capture time stays NULL unless declared');
select is((select actor_id from public.audit_logs where entity_type = 'evidence_files' and action = 'insert'
           and entity_id = (select evidence_file_id from public.evidence_upload_slots where id = tests.slot('reg-1'))),
          tests.id('drv_a1'), 'registration is audited with the uploader as actor');

-- ---------------------------------------------------------------- 4. evidence rows are immutable
select ok(tests.fails($$ update public.evidence_files set sha256 = repeat('0', 64) $$), 'owner cannot UPDATE evidence_files (trigger)');
select ok(tests.fails($$ delete from public.evidence_files $$), 'owner cannot DELETE evidence_files (trigger)');
select ok(tests.fails($$ truncate public.evidence_files $$), 'owner cannot TRUNCATE evidence_files (trigger)');
select tests.act_as('fla');
select ok(tests.fails($$ update public.evidence_files set legal_hold = true $$), 'fleet admin cannot UPDATE evidence_files');
select ok(tests.fails($$ delete from public.evidence_files $$), 'fleet admin cannot DELETE evidence_files');
select ok(tests.fails($$ insert into public.evidence_files (company_id, bucket, object_path, sha256, mime_type, size_bytes, capture_source, exif_gps_stripped, uploaded_by, purpose)
                         values (tests.id('coA'), 'evidence', 'forged', repeat('a', 64), 'image/jpeg', 1, 'in_app_camera', true, tests.id('fla'), 'odometer') $$),
          'clients cannot insert evidence rows directly (only the server registration step can)');
select tests.reset();
set local role service_role;
select ok(tests.fails($$ update public.evidence_files set sha256 = repeat('0', 64) $$), 'service role cannot UPDATE evidence_files either');
select tests.reset();

-- Lookup tables the tests use under RLS (the slots table is only visible to its requester, so map as owner).
create temp table tests_map as
  select evidence_file_id as fid, client_submission_id as csid from public.evidence_upload_slots where evidence_file_id is not null;
grant select on tests_map to authenticated, service_role;
create function tests.fid(lbl text) returns uuid language plpgsql stable as $$
declare r uuid; begin select fid into r from tests_map where csid = tests.id('csid-' || lbl); return r; end $$;
create function tests.seen() returns text language plpgsql stable as $$
declare r text; begin
  select coalesce(string_agg(m.csid::text, ',' order by m.csid::text), '') into r
  from public.evidence_files f join tests_map m on m.fid = f.id; return r; end $$;
create function tests.ids(variadic labels text[]) returns text language sql immutable as $$
  select string_agg(tests.id(l)::text, ',' order by tests.id(l)::text) from unnest(labels) l $$;

-- ---------------------------------------------------------------- 5. who can see which evidence (DEC-23)
-- F1 drv_a1/A1 · F2 drv_a1b/A1 · F3 drv_a2/A2 · F4 mnt/A1 service_record · F5 drv_b1/B1 (other company)
select tests.act_as('drv_a1');
select is(tests.seen(), tests.ids('csid-F1', 'reg-1'), 'driver (Own): only their own evidence, not another driver''s in the same branch');
select tests.act_as('sup_a1');
select is((select count(*) from public.evidence_files where company_id = tests.id('coA') and branch_id = tests.id('A1')), 4::bigint,
          'supervisor (Branch): all evidence of own branch (F1, F2, F4, reg-1)');
select ok(not exists (select 1 from public.evidence_files where id = tests.fid('F3') or id = tests.fid('F5')), 'supervisor: nothing from another branch or company');
select tests.act_as('bm_a1');
select is((select count(*) from public.evidence_files), 4::bigint, 'branch manager (Branch): own branch only');
select tests.act_as('fla');
select is((select count(*) from public.evidence_files), 5::bigint, 'fleet admin (All): every branch of the company (F1-F4 + reg-1), not the other company');
select tests.act_as('sm');
select is((select count(*) from public.evidence_files), 5::bigint, 'senior management (All, view-only)');
select tests.act_as('mnt');
select is(tests.seen(), tests.ids('csid-F4'), 'maintenance admin: service evidence only');
select tests.act_as('sa');
select is((select count(*) from public.evidence_files), 0::bigint, 'system admin: no access to evidence (DEC-23)');
select tests.act_as('expd');
select is((select count(*) from public.evidence_files), 0::bigint, 'an ended grant sees nothing');
select tests.act_as('fla_b');
select is(tests.seen(), tests.ids('csid-F5'), 'other company: only their own evidence');
select tests.act_as('drv_a1b');
select is((select count(*) from public.evidence_upload_slots where requested_by = tests.id('drv_a1')), 0::bigint, 'upload slots are visible to their requester only');
select tests.reset();

-- ---------------------------------------------------------------- 6. signed read URLs: check + access log
select tests.act_as('drv_a1');
select is((select object_path from public.issue_evidence_access(tests.fid('F1'), 'inspection_review', 'inspection', tests.id('insp-1'))),
          (select object_path from public.evidence_files where id = tests.fid('F1')), 'owner gets the object reference for their evidence');
select is((select count(*) from public.issue_evidence_access(tests.fid('F1'))), 1::bigint, 'a second issue works too');
select ok(tests.fails($$ select * from public.issue_evidence_access(tests.fid('F2')) $$), 'driver cannot get another driver''s evidence (same branch)');
select tests.act_as('sup_a2');
select ok(tests.fails($$ select * from public.issue_evidence_access(tests.fid('F1')) $$), 'cross-branch: supervisor of A2 is refused for an A1 file');
select tests.act_as('fla_b');
select ok(tests.fails($$ select * from public.issue_evidence_access(tests.fid('F1')) $$), 'cross-company is refused');
select tests.act_as('sa');
select ok(tests.fails($$ select * from public.issue_evidence_access(tests.fid('F1')) $$), 'system admin is refused');
select tests.act_as('sup_a1');
select is((select count(*) from public.issue_evidence_access(tests.fid('F2'), 'review')), 1::bigint, 'supervisor of the branch may issue');
select tests.reset();
select is((select count(*) from public.evidence_access_log where evidence_file_id = tests.fid('F1')), 2::bigint,
          'every successful issue wrote an access-log row (2 issues for F1, none for the refused attempts)');
select is((select count(*) from public.evidence_access_log where evidence_file_id = tests.fid('F2') and accessed_by = tests.id('drv_a1')), 0::bigint,
          'a refused request writes no log row and returns no path');
select is((select accessed_by || '|' || branch_id || '|' || company_id || '|' || access_type || '|' || purpose || '|' || related_entity_type || '|' || related_entity_id
           from public.evidence_access_log where evidence_file_id = tests.fid('F1') and purpose = 'inspection_review'),
          tests.id('drv_a1') || '|' || tests.id('A1') || '|' || tests.id('coA') || '|signed_url_issued|inspection_review|inspection|' || tests.id('insp-1'),
          'log row records who, scope, type, purpose and related entity');
select tests.act_as('fla');
select ok(tests.fails($$ insert into public.evidence_access_log (company_id, evidence_file_id, accessed_by, access_type) values (tests.id('coA'), tests.fid('F1'), tests.id('fla'), 'signed_url_issued') $$),
          'clients cannot write the access log directly');
select ok(tests.fails($$ update public.evidence_access_log set purpose = 'x' $$), 'access log: no UPDATE');
select ok(tests.fails($$ delete from public.evidence_access_log $$), 'access log: no DELETE');
select tests.reset();
select ok(tests.fails($$ update public.evidence_access_log set purpose = 'x' $$), 'access log is append-only even for the owner');
select ok(tests.fails($$ truncate public.evidence_access_log $$), 'access log: no TRUNCATE');
select tests.act_as('sa');
select is((select count(*) from public.evidence_access_log), 3::bigint, 'audit.view (system admin, company-wide) can read the access log');
select tests.act_as('sup_a1');
select is((select count(*) from public.evidence_access_log), 0::bigint, 'no audit.view: access log not readable');
select tests.act_as('fla_b');
select is((select count(*) from public.evidence_access_log), 0::bigint, 'other company cannot read the access log');
select tests.reset();

-- ---------------------------------------------------------------- 7. cleanup of unregistered uploads
select tests.mk_slot('cl-old', 'drv_a1', 'A1', 'odometer'), tests.mk_slot('cl-recent', 'drv_a1', 'A1', 'odometer');
update public.evidence_upload_slots set expires_at = now() - interval '4 hours' where id = tests.slot('cl-old');
update public.evidence_upload_slots set expires_at = now() - interval '1 hour'  where id = tests.slot('cl-recent');
select tests.act_as('drv_a1');
select ok(tests.fails($$ select * from public.claim_abandoned_evidence_slots(180, 100) $$), 'clients cannot run the cleanup claim');
select tests.reset();
set local role service_role;
select is((select string_agg(object_path, ',') from public.claim_abandoned_evidence_slots(180, 100) where id = tests.slot('cl-old')),
          (select object_path from public.evidence_upload_slots where id = tests.slot('cl-old')), 'a slot past expiry + grace is claimed');
select ok(not exists (select 1 from public.claim_abandoned_evidence_slots(180, 100) c
                      where c.id in (tests.slot('cl-recent'), tests.slot('reg-1'), tests.slot('reg-4'))
                         or c.object_path in (select object_path from public.evidence_files)),
          'within-grace, still-open and registered slots are never claimed; registered evidence is never touched');
select is(public.mark_evidence_slots_object_removed(array[tests.slot('cl-old')]), 1, 'object removal is recorded');
select ok(not exists (select 1 from public.claim_abandoned_evidence_slots(180, 100) where id = tests.slot('cl-old')), 'a cleaned slot is not claimed again');
select tests.reset();
select is((select count(*) from public.evidence_files), 6::bigint, 'cleanup left every evidence row in place');
select tests.act_as('drv_a1');
select is((select status || '|' || (object_removed_at is null) from public.request_evidence_upload_slot('odometer', tests.id('A1'), 'gallery', 'image/jpeg', 1000, tests.id('cl-old'))),
          'issued|true', 'retrying a cleaned-up submission re-opens the same slot for a fresh upload');
select tests.reset();

-- ---------------------------------------------------------------- 8. storage: private bucket + policies
select is((select public::text || '|' || (file_size_limit is not null) || '|' || (allowed_mime_types is not null) from storage.buckets where id = 'evidence'),
          'false|true|true', 'evidence bucket is private with a size limit and a MIME allow-list');
create temp table tests_paths as
  select s.client_submission_id as csid, s.object_path from public.evidence_upload_slots s;
grant select on tests_paths to authenticated;
select tests.act_as('drv_a1');
select ok(tests.affected($$ insert into storage.objects (bucket_id, name) select 'evidence', object_path from tests_paths where csid = tests.id('req-1') $$) = 1,
          'client can upload only at the path of their own open slot');
select ok(tests.fails($$ insert into storage.objects (bucket_id, name) values ('evidence', 'anywhere/else.jpg') $$), 'tampered path: any other path is refused');
select ok(tests.fails($$ insert into storage.objects (bucket_id, name) select 'evidence', object_path from tests_paths where csid = tests.id('csid-F3') $$),
          'another user''s slot path (even a registered one) is refused');
select tests.act_as('drv_a1b');
select ok(tests.fails($$ insert into storage.objects (bucket_id, name) select 'evidence', object_path from tests_paths where csid = tests.id('req-8') $$),
          'a slot belongs to its requester: another driver cannot upload to it');
select tests.reset();
update public.evidence_upload_slots set expires_at = now() - interval '1 minute' where client_submission_id = tests.id('req-8');
select tests.act_as('drv_a1');
select ok(tests.fails($$ insert into storage.objects (bucket_id, name) select 'evidence', object_path from tests_paths where csid = tests.id('req-8') $$),
          'an expired slot cannot be uploaded to');
select tests.reset();
insert into storage.objects (bucket_id, name)
  select 'evidence', object_path from public.evidence_files;       -- registered evidence objects exist in storage
-- Storage reads need evidence.view AND a fresh access-log grant of the caller's own (migration 000012).
-- 1. Without a grant nobody can read, list or sign objects — even with evidence.view in scope.
select tests.act_as('drv_a1b');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 0::bigint,
          'no access-log grant: a driver cannot read even their own evidence object (F2) directly');
select tests.act_as('fla');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 0::bigint,
          'no access-log grant: fleet admin (evidence.view, all) cannot read objects directly either');
-- 2. After issue_evidence_access() the caller can read exactly the objects they were granted.
select tests.act_as('drv_a1');
select is((select count(*) from public.issue_evidence_access(tests.fid('F1'))), 1::bigint, 'drv_a1 is granted access to F1');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 1::bigint,
          'after issue_evidence_access: the granted object (and only it) is readable');
select is((select count(*) from storage.objects where bucket_id = 'evidence' and name in (select object_path from public.evidence_files where id = tests.fid('F1'))), 1::bigint,
          'the readable object is the granted one');
-- 3. Another user's grant does not help: sup_a1 was granted F2 earlier; bm_a1 (same branch) has none.
select tests.act_as('bm_a1');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 0::bigint,
          'another user''s log row does not grant access (bm_a1 can view F2 but has no grant)');
select tests.act_as('sup_a1');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 1::bigint,
          'sup_a1 holds a grant for F2 only: reads exactly that object');
-- 4. The window expires: an expired grant row gives nothing; a new issue (short ttl) re-opens it.
select tests.reset();
insert into public.evidence_access_log (company_id, branch_id, evidence_file_id, accessed_by, access_type, url_expires_at)
  values (tests.id('coA'), tests.id('A1'), tests.fid('F2'), tests.id('bm_a1'), 'signed_url_issued', now() - interval '1 second');
select tests.act_as('bm_a1');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 0::bigint, 'an expired grant (window closed) gives no access');
select is((select count(*) from public.issue_evidence_access(tests.fid('F2'), 'review', null, null, 60)), 1::bigint, 'bm_a1 is granted access to F2 for 60 s');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 1::bigint, 'a fresh issue re-opens access');
select tests.reset();
select is((select url_expires_at > now() + interval '50 seconds' and url_expires_at < now() + interval '70 seconds'
           from public.evidence_access_log where accessed_by = tests.id('bm_a1') and purpose = 'review'), true,
          'the grant window is the ttl the server passed (60 s)');
select tests.act_as('fla');
select is((select count(*) from public.issue_evidence_access(tests.fid('F1'), 'cap-test', null, null, 999999)), 1::bigint, 'fla issues with an absurd ttl');
select tests.reset();
select is((select url_expires_at <= now() + interval '3600 seconds' from public.evidence_access_log where purpose = 'cap-test'), true,
          'the window is capped at one hour');
-- 5. Scope still applies on top of the grant (can_view_evidence): other branch / company / system admin.
select tests.act_as('drv_a2');
select is((select count(*) from public.issue_evidence_access(tests.fid('F3'))), 1::bigint, 'drv_a2 is granted access to F3');
select tests.act_as('sup_a2');
select is((select count(*) from public.issue_evidence_access(tests.fid('F3'))), 1::bigint, 'sup_a2 is granted access to F3');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 1::bigint,
          'storage read: supervisor of A2 reads only the A2 object they were granted — no cross-branch');
select tests.act_as('fla_b');
select is((select count(*) from public.issue_evidence_access(tests.fid('F5'))), 1::bigint, 'fla_b is granted access to F5');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 1::bigint,
          'storage read: other company only reads its own granted object');
select tests.act_as('sa');
select is((select count(*) from storage.objects where bucket_id = 'evidence'), 0::bigint, 'storage read: system admin sees no evidence objects');
select tests.act_as('fla');
-- (deleting objects is blocked for everyone by storage.protect_delete(); the Storage API path is covered by the integration tests)
select is(tests.affected($$ update storage.objects set name = name || 'x' where bucket_id = 'evidence' $$), 0::bigint, 'clients cannot replace evidence objects');
select tests.reset();

select * from finish();
rollback;
