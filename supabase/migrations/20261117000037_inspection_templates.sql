-- 037 — Slice 4A (1/3): inspection settings, templates and items, the starter checklist v1, template selection
-- (PRD v1.15 §5.5–§5.7; ARCH v1.14 §6.1; DB v1.10 §6, §20; DEC-17 late windows, DEC-21 starter checklist v1, DEC-24, DEC-27).
-- Added:    allocation_settings (replaced, see below), inspection_templates, inspection_template_items, their guard/audit
--           triggers, inspection_template_for(vehicle), seed_starter_inspection_template(company), and the seed itself.
-- Write model: no INSERT/UPDATE/DELETE grants for clients. A template and its items change only while unused; nothing is
-- ever deleted. Reads: any signed-in user of the company (RLS), because the driver's form is rendered from the template.

-- ---------------------------------------------------------------- settings: ONE place (DEC-17, DEC-40)
-- 032's allocation_settings() returned two columns. Postgres cannot change the row type of an existing function with
-- CREATE OR REPLACE, so it is dropped and created again with the same name and the same meaning for the old columns
-- (nothing depends on it: its callers are plpgsql bodies resolved at run time). Still internal: no client grant.
-- TypeScript mirror: src/modules/shifts-allocations/domain/allocation-settings.ts (kept identical, tested).
drop function public.allocation_settings(uuid);
create function public.allocation_settings(p_company_id uuid)
returns table (open_before_start_minutes integer, no_show_grace_minutes integer,
               pre_shift_late_minutes integer, post_shift_late_minutes integer)
language sql stable set search_path = '' as $$
  select 60, 30, 30, 60
$$;
revoke all on function public.allocation_settings(uuid) from public, anon, authenticated;
comment on function public.allocation_settings(uuid) is
  'DEC-40 start window (60) and no-show grace (30); DEC-17 late windows: pre-shift +30 min after the shift start, post-shift +60 min after the planned end. Configurable defaults; the one place.';

-- ---------------------------------------------------------------- inspection_templates (DB §6)
create table public.inspection_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  name text not null check (name = btrim(name) and length(name) between 1 and 100),
  vehicle_category text check (vehicle_category is null or (vehicle_category = btrim(vehicle_category) and length(vehicle_category) between 1 and 100)),
  version integer not null check (version >= 1),
  active_status text not null default 'active' check (active_status in ('active', 'retired')),
  first_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, company_id)
);
comment on column public.inspection_templates.vehicle_category is 'NULL = the template for all categories (used when a vehicle''s own category has no active template).';
comment on column public.inspection_templates.first_used_at is 'Set by begin_inspection() the first time an inspection uses the template. From then on the template and its items are immutable (only active_status may change).';
create unique index inspection_templates_version_uq on public.inspection_templates (company_id, coalesce(vehicle_category, ''), name, version);
create unique index inspection_templates_one_active_uq on public.inspection_templates (company_id, coalesce(vehicle_category, '')) where active_status = 'active';

create function public.inspection_templates_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.first_used_at is not null then
    if (to_jsonb(new) - 'active_status') is distinct from (to_jsonb(old) - 'active_status') then
      raise exception 'an inspection template that has been used cannot be changed (only retired); create a new version instead'
        using errcode = '23514';
    end if;
  elsif new.id is distinct from old.id or new.company_id is distinct from old.company_id then
    raise exception 'column inspection_templates.% is immutable', case when new.id is distinct from old.id then 'id' else 'company_id' end
      using errcode = '23514';
  end if;
  return new;
end $$;
create trigger inspection_templates_guard_t before update on public.inspection_templates
  for each row execute function public.inspection_templates_guard();
create trigger inspection_templates_no_delete   before delete   on public.inspection_templates for each row       execute function public.forbid_delete();
create trigger inspection_templates_no_truncate before truncate on public.inspection_templates for each statement execute function public.forbid_delete();
create trigger inspection_templates_audit after insert or update or delete on public.inspection_templates
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- inspection_template_items (DB §6)
create table public.inspection_template_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  template_id uuid not null,
  item_key text not null check (item_key ~ '^[a-z][a-z0-9_]{0,59}$'),
  question text not null check (question = btrim(question) and length(question) between 1 and 300),
  response_type text not null check (response_type in ('ok_defect', 'fuel_quarter', 'yes_no_detail')),
  required boolean not null default true,
  applies_to_stage text not null check (applies_to_stage in ('pre_shift', 'post_shift', 'both')),
  sequence integer not null check (sequence >= 1),
  severity_rule text not null default 'standard' check (severity_rule in ('safety_critical', 'standard')),
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (template_id, company_id) references public.inspection_templates (id, company_id),
  unique (id, company_id),
  unique (template_id, item_key),
  unique (template_id, applies_to_stage, sequence),
  -- allow_na is a boolean, and only an ok/defect item can be "not applicable"
  constraint inspection_items_allow_na_boolean check (not (configuration ? 'allow_na') or configuration -> 'allow_na' in ('true'::jsonb, 'false'::jsonb)),
  constraint inspection_items_na_only_ok_defect check (configuration -> 'allow_na' is distinct from 'true'::jsonb or response_type = 'ok_defect')
);
comment on column public.inspection_template_items.configuration is 'allow_na (boolean): whether "N/A" is an accepted answer. Only for ok_defect items.';
-- FK covers, in FK column order. (company_id) covers the companies FK.
create index inspection_template_items_template_company_idx on public.inspection_template_items (template_id, company_id);
create index inspection_template_items_company_idx          on public.inspection_template_items (company_id);

create function public.inspection_template_items_guard() returns trigger
language plpgsql set search_path = '' as $$
declare v_used timestamptz;
begin
  select t.first_used_at into v_used from public.inspection_templates t
   where t.id = case when tg_op = 'INSERT' then new.template_id else old.template_id end;
  if v_used is not null then
    raise exception 'an inspection template that has been used cannot be changed; create a new version instead' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.template_id is distinct from old.template_id) then
    raise exception 'inspection template item identity is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger inspection_template_items_guard_t before insert or update on public.inspection_template_items
  for each row execute function public.inspection_template_items_guard();
create trigger inspection_template_items_no_delete   before delete   on public.inspection_template_items for each row       execute function public.forbid_delete();
create trigger inspection_template_items_no_truncate before truncate on public.inspection_template_items for each statement execute function public.forbid_delete();
create trigger inspection_template_items_audit after insert or update or delete on public.inspection_template_items
  for each row execute function public.audit_row_change();
revoke execute on function public.inspection_templates_guard(), public.inspection_template_items_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- RLS: readable by the company's signed-in users; no client writes
alter table public.inspection_templates      enable row level security;
alter table public.inspection_template_items enable row level security;
revoke all on public.inspection_templates, public.inspection_template_items from public, anon, authenticated;
grant select on public.inspection_templates, public.inspection_template_items to authenticated;
create policy inspection_templates_select on public.inspection_templates for select to authenticated
  using (company_id = (select public.current_company_id()));
create policy inspection_template_items_select on public.inspection_template_items for select to authenticated
  using (company_id = (select public.current_company_id()));

-- ---------------------------------------------------------------- which template does a vehicle use? ONE place
-- The active template of the vehicle's own category if there is one, otherwise the active all-categories template.
-- Returns NULL when the company has neither. Internal: begin_inspection (039) and the tests call it.
create function public.inspection_template_for(p_vehicle_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select t.id
    from public.vehicles v
    join public.inspection_templates t
      on t.company_id = v.company_id and t.active_status = 'active'
     and (t.vehicle_category = v.vehicle_category or t.vehicle_category is null)
   where v.id = p_vehicle_id
   order by (t.vehicle_category is null), t.version desc
   limit 1
$$;
revoke all on function public.inspection_template_for(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- starter checklist v1 (DEC-21)
-- Configuration, not test data: the exact items approved on 2026-11-18. All items required; SC = safety_critical.
-- One row per line in a fixed format: src/modules/inspections-damage/domain/starter-checklist.fixture.json is compared with
-- these lines (Vitest) and with the seeded rows (pgTAP). Questions are in the driver's own words and are never reworded.
create function public.seed_starter_inspection_template(p_company_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_template uuid;
begin
  select id into v_template from public.inspection_templates
   where company_id = p_company_id and vehicle_category is null and name = 'Starter checklist' and version = 1;
  if found then
    return v_template;
  end if;
  insert into public.inspection_templates (company_id, name, vehicle_category, version, active_status)
  values (p_company_id, 'Starter checklist', null, 1, 'active')
  returning id into v_template;

  insert into public.inspection_template_items
    (company_id, template_id, item_key, question, response_type, required, applies_to_stage, sequence, severity_rule, configuration)
  select p_company_id, v_template, s.item_key, s.question, s.response_type, true, s.stage, s.seq,
         case when s.safety_critical then 'safety_critical' else 'standard' end,
         jsonb_build_object('allow_na', s.allow_na)
    from (values
      ('pre_shift', 1, 'tyres', 'Tyres: tread, pressure, cuts or bulges (including the spare)', 'ok_defect', true, false),
      ('pre_shift', 2, 'wheel_nuts', 'Wheel nuts present and tight', 'ok_defect', true, false),
      ('pre_shift', 3, 'lights', 'Lights: headlights, indicators, brake lights, hazards', 'ok_defect', true, false),
      ('pre_shift', 4, 'windscreen_wipers', 'Windscreen: no cracks in the driver''s view; wipers work', 'ok_defect', true, false),
      ('pre_shift', 5, 'mirrors', 'Mirrors present and undamaged', 'ok_defect', false, false),
      ('pre_shift', 6, 'plates_disc', 'Number plates and licence disc present and current', 'ok_defect', false, false),
      ('pre_shift', 7, 'engine_oil', 'Engine oil level', 'ok_defect', false, false),
      ('pre_shift', 8, 'coolant', 'Coolant level', 'ok_defect', false, false),
      ('pre_shift', 9, 'brake_washer_fluid', 'Brake and washer fluid levels', 'ok_defect', false, false),
      ('pre_shift', 10, 'no_leaks', 'No leaks under the vehicle', 'ok_defect', true, false),
      ('pre_shift', 11, 'seatbelts', 'Seatbelts work', 'ok_defect', true, false),
      ('pre_shift', 12, 'brakes', 'Brakes: foot brake and handbrake feel normal', 'ok_defect', true, false),
      ('pre_shift', 13, 'warning_lights', 'No red warning lights on the dashboard', 'ok_defect', true, false),
      ('pre_shift', 14, 'hooter', 'Hooter works', 'ok_defect', false, false),
      ('pre_shift', 15, 'fuel_level', 'Fuel level', 'fuel_quarter', false, false),
      ('pre_shift', 16, 'cabin_clean', 'Cabin clean and free of loose items', 'ok_defect', false, false),
      ('pre_shift', 17, 'warning_triangle', 'Warning triangle', 'ok_defect', false, true),
      ('pre_shift', 18, 'fire_extinguisher', 'Fire extinguisher (if fitted)', 'ok_defect', false, true),
      ('pre_shift', 19, 'first_aid_kit', 'First-aid kit', 'ok_defect', false, true),
      ('pre_shift', 20, 'jack_spanner', 'Jack and wheel spanner', 'ok_defect', false, true),
      ('post_shift', 1, 'post_tyres', 'Tyres: no new damage', 'ok_defect', true, false),
      ('post_shift', 2, 'post_lights', 'Lights working', 'ok_defect', true, false),
      ('post_shift', 3, 'post_warning_lights', 'No red warning lights on the dashboard', 'ok_defect', true, false),
      ('post_shift', 4, 'post_fuel_level', 'Fuel level', 'fuel_quarter', false, false),
      ('post_shift', 5, 'post_cabin_clean', 'Cabin clean, nothing left behind', 'ok_defect', false, false),
      ('post_shift', 6, 'post_incident', 'Any incident, accident or traffic fine during the shift?', 'yes_no_detail', false, false),
      ('post_shift', 7, 'post_locked_keys', 'Vehicle locked and keys returned', 'ok_defect', false, false)
    ) as s(stage, seq, item_key, question, response_type, safety_critical, allow_na);
  return v_template;
end $$;
revoke all on function public.seed_starter_inspection_template(uuid) from public, anon, authenticated;

-- every existing company gets the starter checklist (configuration, not test data)
select public.seed_starter_inspection_template(c.id) from public.companies c;
