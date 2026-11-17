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

-- T0001 valid + verified, T0002 expiring in 15 days, T0003 expired 10 days ago, T0004 valid but unverified,
-- T0005 valid + PrDP, T0006 has no licence record.
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
  (1, 'EB', 1000, 400, false, true),
  (2, 'EB', 1500, 15, false, true),
  (3, 'C1', 1800, -10, false, true),
  (4, 'EB', 300, 200, false, false),
  (5, 'EC', 500, 365, true, true)
) as l(n, code, issued_days_ago, expires_in_days, prdp, verified)
on conflict (id) do nothing;
