-- Local/CI development seed — SYNTHETIC DATA ONLY (PRD §10 exception, Phases 1–2).
-- No real names, plates, VINs or people. Plates are TESTnnn-GP, VINs are TESTVINnnnnnnnnnn.
-- Loaded by `supabase db reset`. The pgTAP tests run in their own rolled-back transaction with their
-- own companies and do not depend on, or collide with, these rows.
-- No credentials are created here: the seed profile has no password and cannot sign in. Grant roles
-- to your own local users through the normal admin path.

insert into public.companies (id, name) values
  ('5eed0000-0000-4000-8000-000000000001', 'Synthetic Fleet Co (seed)')
on conflict (id) do nothing;

insert into public.branches (id, company_id, name, branch_code) values
  ('5eed0000-0000-4000-8000-0000000000b1', '5eed0000-0000-4000-8000-000000000001', 'Synthetic Branch One', 'SEED-B1'),
  ('5eed0000-0000-4000-8000-0000000000b2', '5eed0000-0000-4000-8000-000000000001', 'Synthetic Branch Two', 'SEED-B2')
on conflict (id) do nothing;

insert into auth.users (id, email)
values ('5eed0000-0000-4000-8000-0000000000a1', 'seed-admin@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier)
values ('5eed0000-0000-4000-8000-0000000000a1', '5eed0000-0000-4000-8000-000000000001',
        'Synthetic Seed Admin', 'seed-admin@example.test', 'staff', 'seed-admin')
on conflict (id) do nothing;

-- 10 vehicles: 6 at branch one, 4 at branch two. Each gets its first assignment (no approval needed);
-- the assignment trigger keeps vehicles.current_branch_id in step.
with v as (
  insert into public.vehicles (id, company_id, current_branch_id, fleet_number, registration_number, make, model,
                               model_year, vehicle_category, vin, fuel_type, transmission, administrative_status)
  select ('5eed0000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
         '5eed0000-0000-4000-8000-000000000001',
         case when n <= 6 then '5eed0000-0000-4000-8000-0000000000b1'::uuid else '5eed0000-0000-4000-8000-0000000000b2'::uuid end,
         'FL-' || lpad(n::text, 3, '0'),
         'TEST' || lpad(n::text, 3, '0') || '-GP',
         (array['Toyota', 'Ford', 'Isuzu', 'Nissan', 'Volkswagen'])[1 + n % 5],
         (array['Hilux', 'Ranger', 'D-Max', 'NP200', 'Amarok'])[1 + n % 5],
         2018 + n % 6,
         (array['bakkie', 'panel van', 'sedan'])[1 + n % 3],
         'TESTVIN' || lpad(n::text, 10, '0'),
         case when n % 2 = 0 then 'diesel' else 'petrol' end,
         case when n % 4 = 0 then 'automatic' else 'manual' end,
         case when n = 10 then 'in_maintenance' else 'available' end
  from generate_series(1, 10) n
  on conflict (id) do nothing
  returning id, company_id, current_branch_id
)
insert into public.vehicle_branch_assignments (company_id, vehicle_id, branch_id, effective_from, created_by)
select company_id, id, current_branch_id, now() - interval '30 days', '5eed0000-0000-4000-8000-0000000000a1'
from v;

-- ---------------------------------------------------------------- Slice 2B: drivers and licences (SYNTHETIC)
-- Fake employee numbers T0001..T0006, fake names and fake licence numbers (SYN-LIC-nnnn). No real people.
-- Like the seed admin these profiles have NO password: they cannot sign in. Create real local drivers through
-- the Add driver screen (it issues a temporary PIN). Licence expiry dates are relative to the day of the reset so
-- the register shows every badge: expired, expiring, valid, unverified, none.
insert into auth.users (id, email)
values ('5eed0000-0000-4000-8000-0000000000a2', 'seed-verifier@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier)
values ('5eed0000-0000-4000-8000-0000000000a2', '5eed0000-0000-4000-8000-000000000001',
        'Synthetic Seed Verifier', 'seed-verifier@example.test', 'staff', 'seed-verifier')
on conflict (id) do nothing;

with d as (
  select n,
         ('5eed0000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid as user_id,
         'T' || lpad(n::text, 4, '0') as emp,
         case when n <= 4 then '5eed0000-0000-4000-8000-0000000000b1'::uuid else '5eed0000-0000-4000-8000-0000000000b2'::uuid end as branch_id
  from generate_series(1, 6) n
), u as (
  insert into auth.users (id, email)
  select user_id, 'seed-driver-' || lower(emp) || '@example.test' from d
  on conflict (id) do nothing
  returning id
), p as (
  insert into public.profiles (id, company_id, display_name, user_type, login_identifier)
  select d.user_id, '5eed0000-0000-4000-8000-000000000001', 'Synthetic Driver ' || d.n, 'driver', 'seed-driver-' || lower(d.emp)
  from d
  on conflict (id) do nothing
  returning id
)
insert into public.drivers (id, company_id, profile_id, employee_number, branch_id)
select ('5eed0000-0000-4000-8000-0000000003' || lpad(d.n::text, 2, '0'))::uuid,
       '5eed0000-0000-4000-8000-000000000001', d.user_id, d.emp, d.branch_id
from d
on conflict (id) do nothing;

insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, granted_by)
select dr.profile_id, r.id, dr.company_id, dr.branch_id, now() - interval '30 days', '5eed0000-0000-4000-8000-0000000000a1'
from public.drivers dr
join public.roles r on r.company_id is null and r.name = 'driver'
where dr.company_id = '5eed0000-0000-4000-8000-000000000001'
  and not exists (select 1 from public.user_roles ur where ur.user_id = dr.profile_id and ur.role_id = r.id);

-- T0001 valid + verified (B), T0002 expiring in 15 days (B), T0003 expired 10 days ago (B), T0004 valid but unverified (B),
-- T0005 valid C1 + PrDP (verified; C1 covers a B vehicle), T0006 has no licence record. Codes are the legal set only
-- (A1, A, B, C1, C, EB, EC1, EC; DEC-22).
insert into public.driver_licences (id, company_id, driver_id, licence_number, licence_code, issue_date, expiry_date,
                                    prdp_required, prdp_expiry_date, verification_status, client_submission_id,
                                    created_by, verified_by, verified_at)
select ('5eed0000-0000-4000-8000-0000000004' || lpad(l.n::text, 2, '0'))::uuid,
       '5eed0000-0000-4000-8000-000000000001',
       ('5eed0000-0000-4000-8000-0000000003' || lpad(l.n::text, 2, '0'))::uuid,
       'SYN-LIC-' || lpad(l.n::text, 4, '0'), l.code,
       current_date - l.issued_days_ago, current_date + l.expires_in_days,
       l.prdp, case when l.prdp then current_date + 365 end,
       case when l.verified then 'verified' else 'recorded' end,
       ('5eed0000-0000-4000-8000-0000000005' || lpad(l.n::text, 2, '0'))::uuid,
       '5eed0000-0000-4000-8000-0000000000a1',
       case when l.verified then '5eed0000-0000-4000-8000-0000000000a2'::uuid end,
       case when l.verified then now() end
from (values
  (1, 'B', 1000, 400, false, true),
  (2, 'B', 1500, 15, false, true),
  (3, 'B', 1800, -10, false, true),
  (4, 'B', 300, 200, false, false),
  (5, 'C1', 500, 365, true, true)
) as l(n, code, issued_days_ago, expires_in_days, prdp, verified)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- Slice 2C: service records (SYNTHETIC)
-- Baseline mix for the 10 seed vehicles: 1-4 verified (different odometers; vehicle 1 is the PRD 82,400 example),
-- 5 recorded only (awaiting verification), 6-10 no record => Baseline required (vehicle 5 also awaiting verification).
-- Created by the seed admin, verified by the seed verifier (verifier <> creator, DEC-24). Source workshop/manual: no
-- historical_import rows, because those need real evidence photos (DEC-20). The company default config is seeded
-- by migration 022's companies trigger. Rows are inserted as `recorded` and then verified, like the real flow.
insert into public.service_records (id, company_id, branch_id, vehicle_id, service_date, actual_service_odometer_km,
                                    service_type, source, supplier_name, job_reference, client_submission_id, created_by)
select ('5eed0000-0000-4000-8000-0000000006' || lpad(s.n::text, 2, '0'))::uuid,
       '5eed0000-0000-4000-8000-000000000001',
       case when s.n <= 6 then '5eed0000-0000-4000-8000-0000000000b1'::uuid else '5eed0000-0000-4000-8000-0000000000b2'::uuid end,
       ('5eed0000-0000-4000-8000-0000000001' || lpad(s.n::text, 2, '0'))::uuid,
       current_date - s.days_ago, s.odo, 'Scheduled service', s.src, 'Synthetic Workshop', 'SYN-JC-' || lpad(s.n::text, 3, '0'),
       ('5eed0000-0000-4000-8000-0000000007' || lpad(s.n::text, 2, '0'))::uuid,
       '5eed0000-0000-4000-8000-0000000000a1'
from (values
  (1, 45, 82400, 'workshop'),
  (2, 120, 41250, 'workshop'),
  (3, 200, 118900, 'manual'),
  (4, 15, 9800, 'workshop'),
  (5, 10, 64000, 'workshop')
) as s(n, days_ago, odo, src)
on conflict (id) do nothing;

update public.service_records
   set verification_status = 'verified', verified_by = '5eed0000-0000-4000-8000-0000000000a2', verified_at = now()
 where id in (select ('5eed0000-0000-4000-8000-0000000006' || lpad(n::text, 2, '0'))::uuid from generate_series(1, 4) n)
   and verification_status = 'recorded';

-- ---------------------------------------------------------------- Slice 3A: shift templates and shifts (SYNTHETIC)
-- For each synthetic branch a "Day" 06:00-18:00 and a "Night" 18:00-06:00 template, and one generated week of shifts
-- (today + 6 days, Africa/Johannesburg). Times come from the same shift_times() the application uses.
insert into public.shift_templates (id, company_id, branch_id, name, start_time, end_time, crosses_midnight, created_by)
select ('5eed0000-0000-4000-8000-0000000008' || lpad((b.n * 10 + t.n)::text, 2, '0'))::uuid,
       '5eed0000-0000-4000-8000-000000000001', b.id, t.name, t.start_time, t.end_time, t.end_time < t.start_time,
       '5eed0000-0000-4000-8000-0000000000a1'
from (values (1, '5eed0000-0000-4000-8000-0000000000b1'::uuid), (2, '5eed0000-0000-4000-8000-0000000000b2'::uuid)) as b(n, id)
cross join (values (1, 'Day', time '06:00', time '18:00'), (2, 'Night', time '18:00', time '06:00')) as t(n, name, start_time, end_time)
on conflict (id) do nothing;

insert into public.shifts (company_id, branch_id, shift_template_id, shift_date, scheduled_start_at, scheduled_end_at,
                           client_submission_id, created_by)
select st.company_id, st.branch_id, st.id, d::date, tm.scheduled_start_at, tm.scheduled_end_at,
       gen_random_uuid(), '5eed0000-0000-4000-8000-0000000000a1'
from public.shift_templates st
cross join generate_series((now() at time zone 'Africa/Johannesburg')::date::timestamp,
                           (now() at time zone 'Africa/Johannesburg')::date::timestamp + interval '6 days', interval '1 day') d
cross join lateral public.shift_times(d::date, st.start_time, st.end_time) tm
where st.company_id = '5eed0000-0000-4000-8000-000000000001'
on conflict do nothing;

-- ---------------------------------------------------------------- Slice 3B: required licence codes and planned allocations (SYNTHETIC)
-- Vehicles: mostly B, FL-004 needs C1, FL-009 has no required code (licence class not checked). The column is written
-- here as the owner; the app writes it only through set_vehicle_required_licence_code().
update public.vehicles
   set required_licence_code = case
         when fleet_number = 'FL-004' then 'C1'
         when fleet_number = 'FL-009' then null
         else 'B' end
 where company_id = '5eed0000-0000-4000-8000-000000000001';

-- A few planned allocations on today's seed shifts (local date), like the application would create them:
--   branch one Day today: FL-001 + T0001, FL-002 + T0002 (class matched); branch two Day today: FL-007 + T0005 (C1 covers B: matched);
--   branch two Night today: FL-009 + T0005 (vehicle has no required code: not_configured; no overlap with the Day shift).
-- Slice 3C: the same drivers get allocations TOMORROW too (labels 5-7), so the driver "My allocations" screen is not empty.
with plan(label, branch_id, template_name, fleet_number, emp, check_, day_offset) as (values
  ('1', '5eed0000-0000-4000-8000-0000000000b1'::uuid, 'Day',   'FL-001', 'T0001', 'matched', 0),
  ('2', '5eed0000-0000-4000-8000-0000000000b1'::uuid, 'Day',   'FL-002', 'T0002', 'matched', 0),
  ('3', '5eed0000-0000-4000-8000-0000000000b2'::uuid, 'Day',   'FL-007', 'T0005', 'matched', 0),
  ('4', '5eed0000-0000-4000-8000-0000000000b2'::uuid, 'Night', 'FL-009', 'T0005', 'not_configured', 0),
  ('5', '5eed0000-0000-4000-8000-0000000000b1'::uuid, 'Day',   'FL-001', 'T0001', 'matched', 1),
  ('6', '5eed0000-0000-4000-8000-0000000000b1'::uuid, 'Day',   'FL-002', 'T0002', 'matched', 1),
  ('7', '5eed0000-0000-4000-8000-0000000000b2'::uuid, 'Day',   'FL-007', 'T0005', 'matched', 1)
), ins as (
  insert into public.vehicle_allocations (id, company_id, branch_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at,
                                          licence_class_check, client_submission_id, created_by)
  select ('5eed0000-0000-4000-8000-0000000009' || lpad(p.label, 2, '0'))::uuid, sh.company_id, sh.branch_id, v.id, d.id, sh.id,
         sh.scheduled_start_at, sh.scheduled_end_at, p.check_, gen_random_uuid(), '5eed0000-0000-4000-8000-0000000000a1'
    from plan p
    join public.shift_templates st on st.branch_id = p.branch_id and st.name = p.template_name
    join public.shifts sh on sh.shift_template_id = st.id and sh.shift_date = (now() at time zone 'Africa/Johannesburg')::date + p.day_offset
    join public.vehicles v on v.fleet_number = p.fleet_number and v.company_id = sh.company_id
    join public.drivers d on d.employee_number = p.emp and d.company_id = sh.company_id
  on conflict (id) do nothing
  returning id, company_id, vehicle_id, driver_id, shift_id, planned_start_at, planned_end_at, licence_class_check
)
insert into public.allocation_events (company_id, allocation_id, event_type, new_value, actor_id)
select company_id, id, 'created',
       jsonb_build_object('status', 'planned', 'vehicle_id', vehicle_id, 'driver_id', driver_id, 'shift_id', shift_id,
                          'planned_start_at', planned_start_at, 'planned_end_at', planned_end_at, 'licence_class_check', licence_class_check),
       '5eed0000-0000-4000-8000-0000000000a1'
  from ins;

-- ---------------------------------------------------------------- Slice 4A: starter checklist and one draft pre-shift inspection (SYNTHETIC)
-- The starter checklist v1 (DEC-21) for the synthetic company (the migration seeded the companies that existed when it ran).
-- Seeded allocation 1 (FL-001 + T0001, branch one, Day today) is shown as already started by its driver, so the driver's
-- "Pre-shift inspection" opens at once, with one DRAFT pre-shift inspection begun by T0001 (no answers, no photos: the camera
-- arrives in 4B and nothing is faked). The status change uses the same transaction-local flag as transition_allocation() (hence the DO block: one transaction).
select public.seed_starter_inspection_template('5eed0000-0000-4000-8000-000000000001');

do $$
begin
  perform set_config('app.allocation_transition', 'on', true);
  update public.vehicle_allocations
     set status = 'pre_inspection_pending', opened_at = now(), opened_by = (select profile_id from public.drivers where id = vehicle_allocations.driver_id)
   where id = '5eed0000-0000-4000-8000-000000000901' and status = 'planned';
  perform set_config('app.allocation_transition', 'off', true);
end $$;

insert into public.inspections (id, company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, template_id, inspection_stage,
                                submitted_by, client_submission_id)
select '5eed0000-0000-4000-8000-000000000a01', a.company_id, a.branch_id, a.vehicle_id, a.driver_id, a.shift_id, a.id,
       public.inspection_template_for(a.vehicle_id), 'pre_shift', d.profile_id, gen_random_uuid()
  from public.vehicle_allocations a
  join public.drivers d on d.id = a.driver_id
 where a.id = '5eed0000-0000-4000-8000-000000000901' and a.status = 'pre_inspection_pending'
on conflict (id) do nothing;
update public.inspection_templates set first_used_at = now()
 where company_id = '5eed0000-0000-4000-8000-000000000001' and first_used_at is null
   and exists (select 1 from public.inspections i where i.template_id = inspection_templates.id);

-- ---------------------------------------------------------------- Slice 4B: one company device (SYNTHETIC)
-- A made-up device key (no phone has it) assigned to the seeded driver T0001 so the register screen is not empty.
-- No photos or evidence are seeded: nothing here pretends to be a real capture.
insert into public.company_devices (id, company_id, branch_id, device_key, asset_tag, label, assigned_driver_id, assigned_from, created_by)
values ('5eed0000-0000-4000-8000-000000000d01', '5eed0000-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-0000000000b1',
        '5eed0000-0000-4000-8000-00000000d0d1', 'SYN-PHONE-001', 'Synthetic company phone 1',
        '5eed0000-0000-4000-8000-000000000301', now(), '5eed0000-0000-4000-8000-0000000000a1')
on conflict (id) do nothing;
