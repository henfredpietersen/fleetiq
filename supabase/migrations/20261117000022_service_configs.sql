-- 022 — Slice 2C: service interval configuration (DB §10 vehicle_service_configs; PRD §5.10.1, §5.10.5; DEC-19
-- precedence, DEC-24 segregation of duties, DEC-11 time tolerances (Proposed -> configurable values only);
-- ARCH §8.1, §8.2, §10; AD-06).
-- Conventions: FK covering indexes (same column order); (select ...) around argument-free calls in RLS; explicit
-- REVOKE on every function; trigger functions granted to nobody; no INSERT/UPDATE/DELETE grants (writes go through
-- the SECURITY DEFINER functions below); no hard deletes; audit trigger.
--
-- Write model
--   company_default  change_company_default_service_config()  service.config.manage (company-wide); effective-dated
--   vehicle / make_model / category overrides
--                    request_service_config_override()        service.config.manage + an `approvals` row with a reason
--                    decide_approval() -> apply_approved_effect() -> apply_service_config_override()
--                                                              only a DIFFERENT service.config.manage holder approves (DEC-24)
--   Until approved nothing exists in vehicle_service_configs: the proposed values live in approvals.payload, so an
--   unapproved override can never be resolved. Config is company-level, so the approval has no branch and both
--   requester and approver need a company-wide grant.
-- Changes are effective-dated: the open row is closed (effective_to) and a new one opened; rows are never edited.
-- Deviations from DB §10 (additive, listed in the PR): approval_id (+ trigger tying the row to its approved
-- approval), nullable created_by for the system-seeded company default, tolerance days required together with
-- interval days (DEC-11 gives no default: the values must be entered, never assumed).

-- ---------------------------------------------------------------- helper: signed-in, cleared staff member
create function public.is_staff_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select true from public.profiles p
                    where p.id = auth.uid() and p.user_type = 'staff' and public.access_cleared(p.id)), false)
$$;
revoke all on function public.is_staff_member() from public, anon;
grant execute on function public.is_staff_member() to authenticated, service_role;

-- ---------------------------------------------------------------- table
create table public.vehicle_service_configs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  scope text not null check (scope in ('vehicle', 'make_model', 'category', 'company_default')),
  vehicle_id uuid,
  make text check (make = btrim(make) and length(make) between 1 and 100),
  model text check (model = btrim(model) and length(model) between 1 and 100),
  vehicle_category text check (vehicle_category = btrim(vehicle_category) and length(vehicle_category) between 1 and 100),
  manufacturer_reference text check (length(manufacturer_reference) between 1 and 200),
  service_interval_km integer not null,
  early_tolerance_km integer not null,
  late_tolerance_km integer not null,
  service_interval_days integer,
  early_tolerance_days integer,                    -- DEC-11 (Proposed 30): configurable, no default
  late_tolerance_days integer,                     -- DEC-11 (Proposed 30): configurable, no default
  effective_from timestamptz not null,
  effective_to timestamptz,
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  created_by uuid,                                 -- NULL only for the system-seeded company default
  approved_by uuid,
  approval_id uuid,
  created_at timestamptz not null default now(),
  foreign key (vehicle_id, company_id) references public.vehicles (id, company_id),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  foreign key (approved_by, company_id) references public.profiles (id, company_id),
  foreign key (approval_id, company_id) references public.approvals (id, company_id),
  unique (id, company_id),
  constraint vsc_scope_consistent check (
    (scope = 'vehicle'         and vehicle_id is not null and make is null     and model is null     and vehicle_category is null)
    or (scope = 'make_model'   and vehicle_id is null     and make is not null and model is not null and vehicle_category is null)
    or (scope = 'category'     and vehicle_id is null     and make is null     and model is null     and vehicle_category is not null)
    or (scope = 'company_default' and vehicle_id is null  and make is null     and model is null     and vehicle_category is null)),
  constraint vsc_km check (
    service_interval_km > 0 and early_tolerance_km >= 0 and late_tolerance_km >= 0
    and early_tolerance_km < service_interval_km and late_tolerance_km < service_interval_km),
  constraint vsc_days check (
    (service_interval_days is null and early_tolerance_days is null and late_tolerance_days is null)
    or (service_interval_days > 0 and early_tolerance_days is not null and late_tolerance_days is not null
        and early_tolerance_days >= 0 and late_tolerance_days >= 0)),
  constraint vsc_dates check (effective_to is null or effective_to > effective_from),
  -- an override carries its approval, and the approver is not the requester (DEC-24)
  constraint vsc_override_approved check (
    scope = 'company_default'
    or (created_by is not null and approved_by is not null and approval_id is not null and approved_by <> created_by)),
  -- no overlapping effective ranges for the same scope target (case-insensitive make / model / category)
  constraint vsc_no_overlap exclude using gist (
    company_id with =,
    scope with =,
    (coalesce(vehicle_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    (coalesce(lower(make), '')) with =,
    (coalesce(lower(model), '')) with =,
    (coalesce(lower(vehicle_category), '')) with =,
    tstzrange(effective_from, effective_to, '[)') with &&)
);
create index vsc_company_id_scope_idx            on public.vehicle_service_configs (company_id, scope, effective_from desc);
create index vsc_vehicle_id_company_id_idx       on public.vehicle_service_configs (vehicle_id, company_id);
create index vsc_created_by_company_id_idx       on public.vehicle_service_configs (created_by, company_id);
create index vsc_approved_by_company_id_idx      on public.vehicle_service_configs (approved_by, company_id);
create index vsc_approval_id_company_id_idx      on public.vehicle_service_configs (approval_id, company_id);
-- one approval produces at most one config row
create unique index vsc_approval_id_uq on public.vehicle_service_configs (approval_id) where approval_id is not null;

-- History is never edited: only an open row's effective_to may be set, once (close the row, open a new one).
create trigger vsc_immutable before update on public.vehicle_service_configs for each row
  execute function public.prevent_column_change('id', 'company_id', 'scope', 'vehicle_id', 'make', 'model', 'vehicle_category',
    'manufacturer_reference', 'service_interval_km', 'early_tolerance_km', 'late_tolerance_km', 'service_interval_days',
    'early_tolerance_days', 'late_tolerance_days', 'effective_from', 'reason', 'created_by', 'approved_by', 'approval_id', 'created_at');

create function public.vsc_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ap public.approvals;
begin
  if tg_op = 'UPDATE' then
    if old.effective_to is not null then
      raise exception 'closed service configuration history is immutable' using errcode = '55000';
    end if;
    return new;
  end if;
  -- INSERT: an override must be exactly what its approved approval says (DEC-19, DEC-24)
  if new.scope <> 'company_default' then
    select * into ap from public.approvals where id = new.approval_id and company_id = new.company_id;
    if not found or ap.approval_type <> 'service_config_override' or ap.status <> 'approved'
       or ap.entity_id <> new.id or ap.requested_by is distinct from new.created_by
       or ap.decided_by is distinct from new.approved_by then
      raise exception 'a service configuration override needs its own approved service_config_override approval (DEC-19, DEC-24)'
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger vsc_guard_t before insert or update on public.vehicle_service_configs for each row execute function public.vsc_guard();
create trigger vsc_no_delete   before delete   on public.vehicle_service_configs for each row       execute function public.forbid_delete();
create trigger vsc_no_truncate before truncate on public.vehicle_service_configs for each statement execute function public.forbid_delete();
create trigger vsc_audit after insert or update or delete on public.vehicle_service_configs
  for each row execute function public.audit_row_change();
revoke execute on function public.vsc_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- the company default (PRD §5.10.1: 15,000 / 1,500 / 1,500 km)
-- Every company always has one, seeded here for existing companies and by trigger for new ones, so resolution can
-- always fall through to it. interval_days stays NULL: a time basis is opt-in and its tolerances are DEC-11 (Proposed).
create function public.seed_company_service_config() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.vehicle_service_configs
    (company_id, scope, service_interval_km, early_tolerance_km, late_tolerance_km, effective_from, reason)
  values (new.id, 'company_default', 15000, 1500, 1500, '1970-01-01T00:00:00Z',
          'Company default seeded from PRD 5.10.1 (15,000 km interval, 1,500 km early and late tolerance)');
  return null;
end $$;
create trigger companies_seed_service_config after insert on public.companies for each row execute function public.seed_company_service_config();
revoke execute on function public.seed_company_service_config() from public, anon, authenticated;

insert into public.vehicle_service_configs
  (company_id, scope, service_interval_km, early_tolerance_km, late_tolerance_km, effective_from, reason)
select c.id, 'company_default', 15000, 1500, 1500, '1970-01-01T00:00:00Z',
       'Company default seeded from PRD 5.10.1 (15,000 km interval, 1,500 km early and late tolerance)'
  from public.companies c
 where not exists (select 1 from public.vehicle_service_configs x where x.company_id = c.id and x.scope = 'company_default');

-- ---------------------------------------------------------------- precedence (DEC-19) — one place
-- vehicle -> make_model -> category -> company_default, the row effective at p_at. 0 or 1 row. Internal: callers
-- do their own access check (resolve_service_config, vehicle_service_status_rows).
create function public.service_config_lookup(p_vehicle_id uuid, p_at timestamptz)
returns setof public.vehicle_service_configs
language sql stable security definer set search_path = '' as $$
  select c.*
    from public.vehicles v
    join public.vehicle_service_configs c on c.company_id = v.company_id
   where v.id = p_vehicle_id
     and tstzrange(c.effective_from, c.effective_to, '[)') @> p_at
     and (   (c.scope = 'vehicle'         and c.vehicle_id = v.id)
          or (c.scope = 'make_model'      and lower(c.make) = lower(v.make) and lower(c.model) = lower(v.model))
          or (c.scope = 'category'        and lower(c.vehicle_category) = lower(v.vehicle_category))
          or  c.scope = 'company_default')
   order by case c.scope when 'vehicle' then 1 when 'make_model' then 2 when 'category' then 3 else 4 end
   limit 1
$$;

-- Exactly one row or a clear error. A signed-in caller must be able to see the vehicle (company + branch access);
-- a server-side caller with no end user (jobs, tests as the database owner) is not narrowed.
create function public.resolve_service_config(p_vehicle_id uuid, p_at timestamptz default now())
returns public.vehicle_service_configs
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.vehicles;
  c public.vehicle_service_configs;
begin
  select * into v from public.vehicles where id = p_vehicle_id;
  if not found
     or (auth.uid() is null and current_user in ('authenticated', 'anon'))
     or (auth.uid() is not null
         and (v.company_id is distinct from public.current_company_id() or not public.has_branch_access(v.current_branch_id))) then
    raise exception 'vehicle not found' using errcode = 'P0002';
  end if;
  if p_at is null then
    raise exception 'a point in time is required' using errcode = '22023';
  end if;
  select * into c from public.service_config_lookup(p_vehicle_id, p_at);
  if not found then
    raise exception 'no service configuration applies to vehicle % at % (not even a company default)', p_vehicle_id, p_at
      using errcode = 'P0002';
  end if;
  return c;
end $$;

-- ---------------------------------------------------------------- shared validation (friendly errors; CHECKs are the backstop)
create function public.service_config_validate(
  p_scope text, p_vehicle_id uuid, p_make text, p_model text, p_category text,
  p_interval_km integer, p_early_km integer, p_late_km integer,
  p_interval_days integer, p_early_days integer, p_late_days integer)
returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_scope is null or p_scope not in ('vehicle', 'make_model', 'category', 'company_default') then
    raise exception 'unknown scope' using errcode = '22023';
  end if;
  if (p_scope = 'vehicle'         and (p_vehicle_id is null or p_make is not null or p_model is not null or p_category is not null))
  or (p_scope = 'make_model'      and (p_vehicle_id is not null or p_make is null or p_model is null or p_category is not null))
  or (p_scope = 'category'        and (p_vehicle_id is not null or p_make is not null or p_model is not null or p_category is null))
  or (p_scope = 'company_default' and (p_vehicle_id is not null or p_make is not null or p_model is not null or p_category is not null)) then
    raise exception 'the target fields do not match the scope % (vehicle: vehicle; make_model: make and model; category: category)', p_scope
      using errcode = '22023';
  end if;
  if p_interval_km is null or p_early_km is null or p_late_km is null
     or p_interval_km <= 0 or p_early_km < 0 or p_late_km < 0 or p_early_km >= p_interval_km or p_late_km >= p_interval_km then
    raise exception 'interval km must be > 0; early and late tolerance km must be >= 0 and below the interval' using errcode = '22023';
  end if;
  if not ((p_interval_days is null and p_early_days is null and p_late_days is null)
          or (p_interval_days > 0 and p_early_days is not null and p_late_days is not null
              and p_early_days >= 0 and p_late_days >= 0)) then
    raise exception 'a time interval needs interval days > 0 and both tolerance days >= 0 (DEC-11: values must be entered); without one, leave all three empty'
      using errcode = '22023';
  end if;
end $$;
revoke all on function public.service_config_lookup(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.service_config_validate(text, uuid, text, text, text, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------- company default: effective-dated change
create function public.change_company_default_service_config(
  p_interval_km integer, p_early_km integer, p_late_km integer,
  p_interval_days integer, p_early_days integer, p_late_days integer,
  p_manufacturer_reference text, p_reason text)
returns public.vehicle_service_configs
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  v_now timestamptz := clock_timestamp();
  o public.vehicle_service_configs;
  n public.vehicle_service_configs;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.has_permission('service.config.manage', null) then
    raise exception 'missing company-wide permission service.config.manage' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 1000 then
    raise exception 'a reason (1-1000 characters) is required' using errcode = '22023';
  end if;
  perform public.service_config_validate('company_default', null, null, null, null,
    p_interval_km, p_early_km, p_late_km, p_interval_days, p_early_days, p_late_days);

  select * into o from public.vehicle_service_configs
   where company_id = v_company and scope = 'company_default' and effective_to is null for update;
  if found and (o.service_interval_km, o.early_tolerance_km, o.late_tolerance_km, o.service_interval_days,
                o.early_tolerance_days, o.late_tolerance_days)
        is not distinct from (p_interval_km, p_early_km, p_late_km, p_interval_days, p_early_days, p_late_days) then
    raise exception 'these are already the current company default values' using errcode = '55000';
  end if;
  if found then
    update public.vehicle_service_configs set effective_to = v_now where id = o.id;
  end if;
  insert into public.vehicle_service_configs
    (company_id, scope, manufacturer_reference, service_interval_km, early_tolerance_km, late_tolerance_km,
     service_interval_days, early_tolerance_days, late_tolerance_days, effective_from, reason, created_by)
  values (v_company, 'company_default', nullif(btrim(p_manufacturer_reference), ''), p_interval_km, p_early_km, p_late_km,
          p_interval_days, p_early_days, p_late_days, v_now, btrim(p_reason), v_uid)
  returning * into n;
  return n;
end $$;

-- ---------------------------------------------------------------- override: request (an approvals row, nothing takes effect)
create function public.request_service_config_override(
  p_scope text, p_vehicle_id uuid, p_make text, p_model text, p_vehicle_category text,
  p_manufacturer_reference text,
  p_interval_km integer, p_early_km integer, p_late_km integer,
  p_interval_days integer, p_early_days integer, p_late_days integer,
  p_reason text, p_client_submission_id uuid)
returns public.approvals
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  a public.approvals;
  v_make text := nullif(btrim(p_make), '');
  v_model text := nullif(btrim(p_model), '');
  v_cat text := nullif(btrim(p_vehicle_category), '');
  v_key text;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;
  select * into a from public.approvals
   where company_id = v_company and requested_by = v_uid and client_submission_id = p_client_submission_id;
  if found then
    return a;                                      -- idempotent retry
  end if;
  if p_scope not in ('vehicle', 'make_model', 'category') then
    raise exception 'only vehicle, make_model and category overrides need approval; the company default is changed directly' using errcode = '22023';
  end if;
  if not public.has_permission('service.config.manage', null) then
    raise exception 'missing company-wide permission service.config.manage' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 1000 then
    raise exception 'a reason (1-1000 characters) is required' using errcode = '22023';
  end if;
  perform public.service_config_validate(p_scope, p_vehicle_id, v_make, v_model, v_cat,
    p_interval_km, p_early_km, p_late_km, p_interval_days, p_early_days, p_late_days);
  if p_scope = 'vehicle' and not exists (select 1 from public.vehicles where id = p_vehicle_id and company_id = v_company) then
    raise exception 'vehicle not found' using errcode = 'P0002';
  end if;
  v_key := p_scope || ':' || coalesce(p_vehicle_id::text, lower(v_make) || '/' || lower(v_model), lower(v_cat));

  begin
    insert into public.approvals (company_id, branch_id, entity_type, entity_id, approval_type, requested_by, reason, payload, client_submission_id)
    values (v_company, null, 'service_config', gen_random_uuid(), 'service_config_override', v_uid, btrim(p_reason),
            jsonb_build_object('target_key', v_key, 'scope', p_scope, 'vehicle_id', p_vehicle_id, 'make', v_make, 'model', v_model,
              'vehicle_category', v_cat, 'manufacturer_reference', nullif(btrim(p_manufacturer_reference), ''),
              'service_interval_km', p_interval_km, 'early_tolerance_km', p_early_km, 'late_tolerance_km', p_late_km,
              'service_interval_days', p_interval_days, 'early_tolerance_days', p_early_days, 'late_tolerance_days', p_late_days),
            p_client_submission_id)
    returning * into a;
  exception when unique_violation then
    raise exception 'an override request for this target is already waiting for approval' using errcode = '55000';
  end;
  return a;
end $$;

-- One open request per target.
create unique index approvals_one_pending_service_config on public.approvals (company_id, (payload ->> 'target_key'))
  where approval_type = 'service_config_override' and status = 'pending';

-- ---------------------------------------------------------------- override: the effect (reachable only through decide_approval)
create function public.apply_service_config_override(p_approval_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ap public.approvals;
  pl jsonb;
  v_now timestamptz := clock_timestamp();
begin
  select * into ap from public.approvals where id = p_approval_id;
  if not found or ap.status <> 'approved' or ap.approval_type <> 'service_config_override' then
    raise exception 'not an approved service configuration override' using errcode = '55000';
  end if;
  pl := ap.payload;
  perform public.service_config_validate(pl ->> 'scope', (pl ->> 'vehicle_id')::uuid, pl ->> 'make', pl ->> 'model', pl ->> 'vehicle_category',
    (pl ->> 'service_interval_km')::integer, (pl ->> 'early_tolerance_km')::integer, (pl ->> 'late_tolerance_km')::integer,
    (pl ->> 'service_interval_days')::integer, (pl ->> 'early_tolerance_days')::integer, (pl ->> 'late_tolerance_days')::integer);

  -- close the open row for the same target, then open the new one
  update public.vehicle_service_configs c set effective_to = v_now
   where c.company_id = ap.company_id and c.scope = pl ->> 'scope' and c.effective_to is null
     and c.vehicle_id is not distinct from (pl ->> 'vehicle_id')::uuid
     and lower(c.make) is not distinct from lower(pl ->> 'make')
     and lower(c.model) is not distinct from lower(pl ->> 'model')
     and lower(c.vehicle_category) is not distinct from lower(pl ->> 'vehicle_category');

  insert into public.vehicle_service_configs
    (id, company_id, scope, vehicle_id, make, model, vehicle_category, manufacturer_reference,
     service_interval_km, early_tolerance_km, late_tolerance_km, service_interval_days, early_tolerance_days, late_tolerance_days,
     effective_from, reason, created_by, approved_by, approval_id)
  values (ap.entity_id, ap.company_id, pl ->> 'scope', (pl ->> 'vehicle_id')::uuid, pl ->> 'make', pl ->> 'model', pl ->> 'vehicle_category',
     pl ->> 'manufacturer_reference',
     (pl ->> 'service_interval_km')::integer, (pl ->> 'early_tolerance_km')::integer, (pl ->> 'late_tolerance_km')::integer,
     (pl ->> 'service_interval_days')::integer, (pl ->> 'early_tolerance_days')::integer, (pl ->> 'late_tolerance_days')::integer,
     v_now, ap.reason, ap.requested_by, ap.decided_by, ap.id);
end $$;

-- ---------------------------------------------------------------- approvals: the new type (CREATE OR REPLACE; branch_transfer unchanged)
create or replace function public.approval_decide_permission(p_type text) returns text
language sql immutable set search_path = '' as $$
  select case p_type
    when 'branch_transfer'         then 'vehicle.transfer.approve'
    when 'service_config_override' then 'service.config.manage'
  end
$$;

create or replace function public.apply_approved_effect(p_approval_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_type text;
begin
  select approval_type into v_type from public.approvals where id = p_approval_id and status = 'approved';
  if v_type is null then
    raise exception 'not an approved approval' using errcode = '55000';
  elsif v_type = 'branch_transfer' then
    perform public.apply_branch_transfer(p_approval_id);
  elsif v_type = 'service_config_override' then
    perform public.apply_service_config_override(p_approval_id);
  else
    raise exception 'approval type % has no effect handler yet', v_type using errcode = '0A000';
  end if;
end $$;

-- ---------------------------------------------------------------- privileges
revoke all on function
  public.resolve_service_config(uuid, timestamptz),
  public.change_company_default_service_config(integer, integer, integer, integer, integer, integer, text, text),
  public.request_service_config_override(text, uuid, text, text, text, text, integer, integer, integer, integer, integer, integer, text, uuid),
  public.apply_service_config_override(uuid)
  from public, anon;
revoke execute on function public.apply_service_config_override(uuid) from authenticated;
grant execute on function
  public.resolve_service_config(uuid, timestamptz),
  public.change_company_default_service_config(integer, integer, integer, integer, integer, integer, text, text),
  public.request_service_config_override(text, uuid, text, text, text, text, integer, integer, integer, integer, integer, integer, text, uuid)
  to authenticated;
grant execute on function public.resolve_service_config(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------- RLS + grants (deny by default)
alter table public.vehicle_service_configs enable row level security;
revoke all on public.vehicle_service_configs from public, anon, authenticated;
grant select on public.vehicle_service_configs to authenticated;
-- Company-level settings with no personal data: every cleared staff member of the company may read them (drivers do not).
create policy vsc_select on public.vehicle_service_configs for select to authenticated
  using (company_id = (select public.current_company_id()) and (select public.is_staff_member()));
