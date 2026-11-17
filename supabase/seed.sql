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
