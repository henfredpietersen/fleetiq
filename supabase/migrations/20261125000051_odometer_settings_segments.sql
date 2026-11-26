-- 051 — Slice 5A (1/4): odometer validation settings and odometer segments
-- (PRD v1.20 §4.2, §5.8, §6; ARCH v1.19 §6.5, §7.1; DB v1.15 §8 odometer_validation_settings, odometer_segments, §20;
--  DEC-12 whole km, DEC-13 / DEC-15 NO default (null), DEC-14 tolerance 0, DEC-16 unaccounted 5 km, DEC-17 late 30 / 60, DEC-18 stale 7 days,
--  DEC-23 settings.validation.manage, DEC-24).
-- Added:    odometer_fail(), odometer_validation_settings (+ guard / audit / RLS), seed_company_validation_settings() and its trigger,
--           validation_settings_for(vehicle, at), company_validation_settings(company, at), set_validation_settings(...),
--           odometer_segments (+ guard / audit / RLS), seed_vehicle_odometer_segment() and its trigger, odometer_lifetime_km().
-- Replaced: allocation_settings(uuid) — SAME signature and columns (CREATE OR REPLACE); the two late-minute columns now come from the
--           company-default settings row in effect now, so the late window has ONE source. Still internal (no client grant).
-- Write model: no client INSERT/UPDATE/DELETE. Settings change only through set_validation_settings(); history is kept (a version is
-- closed, never edited or deleted). Segments are written by the vehicle trigger here and by 5B's approved adjustments.
--
-- Time source: "in effect" lookups use clock_timestamp(), not now(), so a version written inside a transaction is the one in effect for
-- the rest of that transaction (the seeded rows start at 1970-01-01, so nothing is ever "not yet in effect").

-- ---------------------------------------------------------------- one way to refuse with a user-facing message (odometer area)
create function public.odometer_fail(p_sqlstate text, p_message text, p_detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%', p_message using errcode = p_sqlstate, hint = 'user_message', detail = coalesce(p_detail, '');
end $$;
revoke all on function public.odometer_fail(text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- odometer_validation_settings (DB §8)
create table public.odometer_validation_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  vehicle_category text check (vehicle_category is null or (vehicle_category = btrim(vehicle_category) and length(vehicle_category) between 1 and 100)),
  max_km_per_allocation integer check (max_km_per_allocation is null or max_km_per_allocation between 0 and 9999999),     -- DEC-15: no default
  ocr_min_confidence numeric(4, 3) check (ocr_min_confidence is null or ocr_min_confidence between 0 and 1),               -- DEC-13: no default
  ocr_driver_tolerance_km integer not null default 0 check (ocr_driver_tolerance_km between 0 and 9999999),               -- DEC-14
  unaccounted_tolerance_km integer not null default 5 check (unaccounted_tolerance_km between 0 and 9999999),             -- DEC-16
  pre_shift_late_minutes integer not null default 30 check (pre_shift_late_minutes between 0 and 10080),                  -- DEC-17
  post_shift_late_minutes integer not null default 60 check (post_shift_late_minutes between 0 and 10080),                -- DEC-17
  stale_reading_days integer not null default 7 check (stale_reading_days between 0 and 3650),                            -- DEC-18
  version integer not null check (version >= 1),
  effective_from timestamptz not null,
  effective_to timestamptz,
  reason text check (length(reason) between 1 and 500),
  created_by uuid,                                             -- null for the seeded version 1
  client_submission_id uuid,
  created_at timestamptz not null default now(),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  unique (id, company_id),
  constraint ovs_range check (effective_to is null or effective_to > effective_from),
  constraint ovs_idempotent unique (company_id, created_by, client_submission_id),
  -- no overlapping effective ranges per (company, category); NULL category = the company default
  constraint ovs_no_overlap exclude using gist (
    company_id with =, (coalesce(vehicle_category, '')) with =, tstzrange(effective_from, effective_to) with &&)
);
create unique index ovs_version_uq on public.odometer_validation_settings (company_id, (coalesce(vehicle_category, '')), version);
-- FK covers (company_id is the leading column of ovs_version_uq / ovs_idempotent)
create index ovs_created_by_company_idx on public.odometer_validation_settings (created_by, company_id);
comment on table public.odometer_validation_settings is
  'DEC-12..18 effective-dated thresholds. NULL vehicle_category = the company default; a category row replaces the default as a WHOLE row for vehicles of that category. max_km_per_allocation (DEC-15) and ocr_min_confidence (DEC-13) have NO default: while null the implausible-distance check reports not_configured and nothing is auto-accepted.';
comment on column public.odometer_validation_settings.reason is 'Why this version was created (set_validation_settings requires one). The seeded version 1 carries the source of its defaults.';

-- identity and values never change; the only change a row ever gets is effective_to: null -> a time (a newer version replaced it)
create function public.ovs_guard() returns trigger
language plpgsql set search_path = '' as $$
declare col text; o jsonb := to_jsonb(old); n jsonb := to_jsonb(new);
begin
  for col in select jsonb_object_keys(o) loop
    if col <> 'effective_to' and o -> col is distinct from n -> col then
      raise exception 'a validation settings version cannot be edited; create a new version instead' using errcode = '23514';
    end if;
  end loop;
  if old.effective_to is not null then
    raise exception 'a closed validation settings version cannot change' using errcode = '55000';
  end if;
  if new.effective_to is null then
    raise exception 'effective_to can only be set once' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.ovs_guard() from public, anon, authenticated;
create trigger ovs_guard_t before update on public.odometer_validation_settings for each row execute function public.ovs_guard();
create trigger ovs_no_delete   before delete   on public.odometer_validation_settings for each row       execute function public.forbid_delete();
create trigger ovs_no_truncate before truncate on public.odometer_validation_settings for each statement execute function public.forbid_delete();
create trigger ovs_audit after insert or update or delete on public.odometer_validation_settings for each row execute function public.audit_row_change();

-- the DEC defaults, seeded for every existing company and (trigger) every new one
create function public.seed_company_validation_settings() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.odometer_validation_settings
    (company_id, vehicle_category, max_km_per_allocation, ocr_min_confidence, ocr_driver_tolerance_km, unaccounted_tolerance_km,
     pre_shift_late_minutes, post_shift_late_minutes, stale_reading_days, version, effective_from, reason)
  values (new.id, null, null, null, 0, 5, 30, 60, 7, 1, '1970-01-01T00:00:00Z',
          'Company default seeded from DB v1.15 §8 (DEC-14 0 km, DEC-16 5 km, DEC-17 30 / 60 min, DEC-18 7 days; DEC-13 and DEC-15 have no default)');
  return null;
end $$;
revoke all on function public.seed_company_validation_settings() from public, anon, authenticated;
create trigger companies_seed_validation_settings after insert on public.companies for each row execute function public.seed_company_validation_settings();

insert into public.odometer_validation_settings
  (company_id, vehicle_category, max_km_per_allocation, ocr_min_confidence, ocr_driver_tolerance_km, unaccounted_tolerance_km,
   pre_shift_late_minutes, post_shift_late_minutes, stale_reading_days, version, effective_from, reason)
select c.id, null, null, null, 0, 5, 30, 60, 7, 1, '1970-01-01T00:00:00Z',
       'Company default seeded from DB v1.15 §8 (DEC-14 0 km, DEC-16 5 km, DEC-17 30 / 60 min, DEC-18 7 days; DEC-13 and DEC-15 have no default)'
  from public.companies c;

-- ---------------------------------------------------------------- the lookups: ONE place
-- The row in effect for a vehicle: its category's row first, else the company default. Internal (no client grant).
create function public.validation_settings_for(p_vehicle_id uuid, p_at timestamptz default clock_timestamp())
returns public.odometer_validation_settings
language sql stable security definer set search_path = '' as $$
  select s.*
    from public.vehicles v
    join public.odometer_validation_settings s
      on s.company_id = v.company_id and (s.vehicle_category = v.vehicle_category or s.vehicle_category is null)
   where v.id = p_vehicle_id
     and s.effective_from <= p_at and (s.effective_to is null or s.effective_to > p_at)
   order by (s.vehicle_category is not null) desc
   limit 1
$$;
create function public.company_validation_settings(p_company_id uuid, p_at timestamptz default clock_timestamp())
returns public.odometer_validation_settings
language sql stable security definer set search_path = '' as $$
  select s.* from public.odometer_validation_settings s
   where s.company_id = p_company_id and s.vehicle_category is null
     and s.effective_from <= p_at and (s.effective_to is null or s.effective_to > p_at)
   limit 1
$$;
revoke all on function public.validation_settings_for(uuid, timestamptz), public.company_validation_settings(uuid, timestamptz)
  from public, anon, authenticated;

-- allocation_settings(): same signature and columns as 037; the late minutes now come from the table (DEC-17). 60 / 30 (DEC-40) stay here.
-- security definer: it reads an RLS-protected table and is called from definer functions only (no client grant, as before).
create or replace function public.allocation_settings(p_company_id uuid)
returns table (open_before_start_minutes integer, no_show_grace_minutes integer,
               pre_shift_late_minutes integer, post_shift_late_minutes integer)
language sql stable security definer set search_path = '' as $$
  select 60, 30,
         coalesce(s.pre_shift_late_minutes, 30), coalesce(s.post_shift_late_minutes, 60)
    from (select 1) d
    left join lateral public.company_validation_settings(p_company_id) s on true
$$;
revoke all on function public.allocation_settings(uuid) from public, anon, authenticated;
comment on function public.allocation_settings(uuid) is
  'DEC-40 start window (60) and no-show grace (30); DEC-17 late windows come from the company-default row of odometer_validation_settings in effect now (30 / 60 until changed). Configurable defaults; the one place.';

-- ---------------------------------------------------------------- set_validation_settings (settings.validation.manage, company-wide grant only)
create function public.set_validation_settings(
  p_vehicle_category text, p_max_km_per_allocation integer, p_ocr_min_confidence numeric,
  p_ocr_driver_tolerance_km integer, p_unaccounted_tolerance_km integer,
  p_pre_shift_late_minutes integer, p_post_shift_late_minutes integer, p_stale_reading_days integer,
  p_reason text, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_cat text := nullif(btrim(p_vehicle_category), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_now timestamptz := clock_timestamp();
  cur public.odometer_validation_settings;
  r public.odometer_validation_settings;
  v_id uuid;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    perform public.odometer_fail('22023', 'client_submission_id is required');
  end if;
  -- a company-wide grant only: the settings apply to every branch
  if not public.has_permission('settings.validation.manage', null) then
    perform public.odometer_fail('42501', 'Only someone who manages validation settings for the whole company can change them.');
  end if;
  select * into r from public.odometer_validation_settings
   where company_id = v_company and created_by = v_uid and client_submission_id = p_client_submission_id;
  if found then
    if r.vehicle_category is not distinct from v_cat and r.max_km_per_allocation is not distinct from p_max_km_per_allocation
       and r.ocr_min_confidence is not distinct from p_ocr_min_confidence
       and r.ocr_driver_tolerance_km = p_ocr_driver_tolerance_km and r.unaccounted_tolerance_km = p_unaccounted_tolerance_km
       and r.pre_shift_late_minutes = p_pre_shift_late_minutes and r.post_shift_late_minutes = p_post_shift_late_minutes
       and r.stale_reading_days = p_stale_reading_days and r.reason is not distinct from v_reason then
      return r.id;
    end if;
    perform public.odometer_fail('22023', 'client_submission_id was already used for a different request');
  end if;
  if v_reason is null or length(v_reason) > 500 then
    perform public.odometer_fail('22023', 'A reason (1-500 characters) is required to change the validation settings.');
  end if;
  if p_ocr_driver_tolerance_km is null or p_unaccounted_tolerance_km is null or p_pre_shift_late_minutes is null
     or p_post_shift_late_minutes is null or p_stale_reading_days is null
     or p_ocr_driver_tolerance_km not between 0 and 9999999 or p_unaccounted_tolerance_km not between 0 and 9999999
     or p_pre_shift_late_minutes not between 0 and 10080 or p_post_shift_late_minutes not between 0 and 10080
     or p_stale_reading_days not between 0 and 3650
     or (p_max_km_per_allocation is not null and p_max_km_per_allocation not between 0 and 9999999)
     or (p_ocr_min_confidence is not null and p_ocr_min_confidence not between 0 and 1) then
    perform public.odometer_fail('22023', 'Some of those values are not valid. Distances and times must be whole numbers of zero or more, and the confidence a number from 0 to 1.');
  end if;

  select * into cur from public.odometer_validation_settings s
   where s.company_id = v_company and coalesce(s.vehicle_category, '') = coalesce(v_cat, '') and s.effective_to is null
   for update;
  perform set_config('app.audit_reason', v_reason, true);
  if found then
    update public.odometer_validation_settings set effective_to = v_now where id = cur.id;
  end if;
  insert into public.odometer_validation_settings
    (company_id, vehicle_category, max_km_per_allocation, ocr_min_confidence, ocr_driver_tolerance_km, unaccounted_tolerance_km,
     pre_shift_late_minutes, post_shift_late_minutes, stale_reading_days, version, effective_from, reason, created_by, client_submission_id)
  values (v_company, v_cat, p_max_km_per_allocation, p_ocr_min_confidence, p_ocr_driver_tolerance_km, p_unaccounted_tolerance_km,
          p_pre_shift_late_minutes, p_post_shift_late_minutes, p_stale_reading_days, coalesce(cur.version, 0) + 1, v_now, v_reason, v_uid,
          p_client_submission_id)
  returning id into v_id;
  perform set_config('app.audit_reason', '', true);
  return v_id;
end $$;
revoke all on function public.set_validation_settings(text, integer, numeric, integer, integer, integer, integer, integer, text, uuid) from public, anon;
grant execute on function public.set_validation_settings(text, integer, numeric, integer, integer, integer, integer, integer, text, uuid) to authenticated;

-- ---------------------------------------------------------------- RLS: settings are read by the people who manage them (company-wide)
alter table public.odometer_validation_settings enable row level security;
revoke all on public.odometer_validation_settings from public, anon, authenticated;
grant select on public.odometer_validation_settings to authenticated;
create policy ovs_select on public.odometer_validation_settings for select to authenticated
  using (company_id = (select public.current_company_id()) and (select public.has_permission('settings.validation.manage', null)));

-- ---------------------------------------------------------------- odometer_segments (DB §8)
create table public.odometer_segments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  vehicle_id uuid not null,
  segment_number integer not null check (segment_number >= 1),
  starts_at timestamptz not null,
  ends_at timestamptz,
  offset_km integer not null default 0 check (offset_km >= 0),
  created_by_adjustment_id uuid,                               -- odometer_adjustments is 5B: no FK yet
  created_at timestamptz not null default now(),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  unique (id, company_id),
  unique (id, vehicle_id),                                     -- target for odometer_readings
  constraint odometer_segments_number_uq unique (vehicle_id, segment_number),
  constraint odometer_segments_range check (ends_at is null or ends_at > starts_at)
);
-- exactly one open segment per vehicle
create unique index odometer_segments_one_open_uq on public.odometer_segments (vehicle_id) where ends_at is null;
create index odometer_segments_vehicle_company_idx on public.odometer_segments (vehicle_id, company_id);
create index odometer_segments_company_idx on public.odometer_segments (company_id);
comment on table public.odometer_segments is
  'Continuous lifetime kilometres across replacements and rollovers: lifetime_km = displayed_km + offset_km (odometer_lifetime_km()). Exactly one open segment per vehicle. 5A creates segment 1 (offset 0) for every vehicle; adjustments that close and open segments are 5B.';
comment on column public.odometer_segments.created_by_adjustment_id is 'Set by 5B (odometer_adjustments); no foreign key until that table exists.';

-- only ends_at may change (open -> closed, by an approved adjustment in 5B); nothing is deleted
create trigger odometer_segments_immutable before update on public.odometer_segments for each row
  execute function public.prevent_column_change('id', 'company_id', 'vehicle_id', 'segment_number', 'starts_at', 'offset_km', 'created_by_adjustment_id', 'created_at');
create trigger odometer_segments_no_delete   before delete   on public.odometer_segments for each row       execute function public.forbid_delete();
create trigger odometer_segments_no_truncate before truncate on public.odometer_segments for each statement execute function public.forbid_delete();
create trigger odometer_segments_audit after insert or update or delete on public.odometer_segments for each row execute function public.audit_row_change();

-- every vehicle has one: backfilled now, created for each new vehicle
insert into public.odometer_segments (company_id, vehicle_id, segment_number, starts_at, offset_km)
select v.company_id, v.id, 1, v.created_at, 0 from public.vehicles v;

create function public.seed_vehicle_odometer_segment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.odometer_segments (company_id, vehicle_id, segment_number, starts_at, offset_km)
  values (new.company_id, new.id, 1, new.created_at, 0);
  return null;
end $$;
revoke all on function public.seed_vehicle_odometer_segment() from public, anon, authenticated;
create trigger vehicles_seed_odometer_segment after insert on public.vehicles for each row execute function public.seed_vehicle_odometer_segment();

-- lifetime_km = displayed_km + offset_km: the ONE place (TypeScript mirror: odometer-mileage/domain/lifetime.ts)
create function public.odometer_lifetime_km(p_segment_id uuid, p_displayed_km integer) returns integer
language sql stable security definer set search_path = '' as $$
  select p_displayed_km + s.offset_km from public.odometer_segments s where s.id = p_segment_id
$$;
revoke all on function public.odometer_lifetime_km(uuid, integer) from public, anon, authenticated;

-- RLS: read by people who may read readings of the vehicle's branch (reviewers, and register-visible report viewers)
alter table public.odometer_segments enable row level security;
revoke all on public.odometer_segments from public, anon, authenticated;
grant select on public.odometer_segments to authenticated;
create policy odometer_segments_select on public.odometer_segments for select to authenticated
  using (company_id = (select public.current_company_id())
         and exists (select 1 from public.vehicles v
                      where v.id = vehicle_id and v.company_id = odometer_segments.company_id
                        and (public.has_permission('odometer.exception.review', v.current_branch_id)
                             or (public.has_permission('reports.view', v.current_branch_id)
                                 and public.driver_register_visible(v.current_branch_id, null)))));
