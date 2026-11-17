-- 018 — Slice 2B: driver register and licences (DB §4 drivers, driver_licences; PRD §4.2 driver.manage,
-- driver.licence.view_sensitive, §5.4, §6 POPIA; ARCH §5.4, §10; DEC-08, DEC-23, DEC-24; AD-05, AD-08).
-- Conventions from 013: FK covering indexes (same column order); (select ...) around argument-free calls in
-- RLS; statuses are text + CHECK. Every function created here gets an explicit REVOKE; trigger functions are
-- never granted to anyone.
--
-- Write model (nothing here is writable by a client directly: no INSERT/UPDATE/DELETE grants):
--   admin_create_driver()      (020, service role)   profile + drivers row + driver role, one transaction
--   update_driver_details()    driver.manage on the driver's branch  -> name / phone
--   set_driver_status()        driver.manage on the driver's branch  -> deactivate / reactivate, never delete
--   record_driver_licence()    driver.manage + driver.licence.view_sensitive on the branch
--   verify_driver_licence()    same permissions; verifier <> creator (DEC-24) in CHECK + function
--
-- Deviations from DB §4 (additive, listed in the PR):
--   * driver_licences.created_by / verified_by / verified_at / client_submission_id, and
--     verification_status values (recorded, verified, rejected) mirror vehicle_documents (015).
--   * Licence content is immutable after capture; a mistake is corrected by recording a new licence and
--     rejecting the old one (no hard deletes of history).
--   * employee_number and branch_id are immutable on drivers: the employee number is the driver's sign-in
--     identifier (AD-08), and a branch transfer for drivers is not part of this slice.
--   * audit_row_change() now also strips licence_number from audited values (DB §17: no full licence numbers
--     in before/after values).
--   * Register visibility has no DEC-23 key of its own: see driver_register_visible() (Proposed, configurable).

-- ---------------------------------------------------------------- audit: never store licence numbers
create or replace function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pk text := coalesce(tg_argv[0], 'id');
  -- never store secrets
  strip text[] := array['pin', 'pin_hash', 'password', 'encrypted_password', 'secret', 'token', 'licence_number'];
  o jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) - strip end;
  n jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) - strip end;
  j jsonb := coalesce(n, o);
  v_company uuid;
  v_branch uuid;
begin
  if tg_table_name = 'companies' then
    v_company := (j ->> 'id')::uuid;
  elsif tg_table_name = 'role_permissions' then
    -- no company_id column: resolve through the role (NULL for system roles)
    select r.company_id into v_company from public.roles r where r.id = (j ->> 'role_id')::uuid;
  else
    v_company := (j ->> 'company_id')::uuid;
  end if;
  if tg_table_name = 'branches' then
    v_branch := (j ->> 'id')::uuid;
  else
    v_branch := (j ->> 'branch_id')::uuid;
  end if;

  insert into public.audit_logs
    (company_id, branch_id, actor_id, action, entity_type, entity_id,
     before_values, after_values, reason, request_reference, metadata)
  values
    (v_company, v_branch,
     -- app.actor_id is honoured only when there is no authenticated user (service-role admin functions)
     coalesce(auth.uid(), nullif(current_setting('app.actor_id', true), '')::uuid),
     lower(tg_op), tg_table_name, (j ->> pk)::uuid,
     o, n,
     nullif(current_setting('app.audit_reason', true), ''),
     nullif(current_setting('app.request_reference', true), ''),
     jsonb_build_object('session_user', session_user)
       || case when tg_table_name = 'role_permissions'
               then jsonb_build_object('permission_id', j ->> 'permission_id') else '{}'::jsonb end);
  return null;
end $$;

revoke all on function public.audit_row_change() from public, anon, authenticated;

-- ---------------------------------------------------------------- access helpers (SECURITY DEFINER, stable)
-- Who may see the driver register at all. DEC-23 has no key for this, so it is role-based and narrowed by the
-- grant's branch (AD-05): the driver sees their own row; supervisor, fleet administrator, branch manager and
-- senior management see their branch / all. Maintenance administrator and system administrator do not (data
-- minimisation, POPIA). Custom roles fail closed to "own row only". Proposed, not an approved decision.
create function public.driver_register_visible(p_branch_id uuid, p_profile_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true
    from public.profiles p
    where p.id = auth.uid()
      and public.access_cleared(p.id)
      and (
        p_profile_id = p.id
        or exists (
          select 1
          from public.user_roles ur
          join public.roles r on r.id = ur.role_id and r.company_id is null
          where ur.user_id = p.id and ur.company_id = p.company_id
            and r.name in ('supervisor', 'fleet_admin', 'branch_manager', 'senior_management')
            and ur.effective_from <= now()
            and (ur.effective_to is null or ur.effective_to > now())
            and (ur.branch_id is null or ur.branch_id = p_branch_id)
            and exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = p.company_id)
        )
      )
    limit 1
  ), false)
$$;

-- Who may see licence numbers (DEC-23: driver.licence.view_sensitive = Own / Branch / All). The grant must carry
-- the permission; its branch comes from user_roles (AD-05). "Own" is the row-level narrowing: a driver (or any
-- custom role) sees only the licence of their own driver record; supervisor, fleet administrator and branch
-- manager see their branch / all. Senior management and the maintenance and system administrators do not hold
-- the permission, so they never pass.
create function public.can_view_licence(p_branch_id uuid, p_driver_profile_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.company_id = p.company_id
    join public.roles r on r.id = ur.role_id and (r.company_id is null or r.company_id = p.company_id)
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions pm on pm.id = rp.permission_id and pm.permission_key = 'driver.licence.view_sensitive'
    where p.id = auth.uid()
      and public.access_cleared(p.id)
      and ur.effective_from <= now()
      and (ur.effective_to is null or ur.effective_to > now())
      and (ur.branch_id is null or ur.branch_id = p_branch_id)
      and exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = p.company_id)
      and case
            when r.company_id is null and r.name in ('supervisor', 'fleet_admin', 'branch_manager') then true
            else p_driver_profile_id = p.id
          end
    limit 1
  ), false)
$$;
revoke all on function public.driver_register_visible(uuid, uuid), public.can_view_licence(uuid, uuid) from public, anon;
grant execute on function public.driver_register_visible(uuid, uuid), public.can_view_licence(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- drivers
create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  profile_id uuid not null,                        -- DEC-08: every driver signs in
  employee_number text not null check (employee_number ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'), -- canonical form, see identifiers.ts
  branch_id uuid not null,
  active_status text not null default 'active' check (active_status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (profile_id, company_id) references public.profiles (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  constraint drivers_profile_uq unique (profile_id),
  constraint drivers_employee_number_uq unique (company_id, employee_number),   -- also covers the company_id FK
  unique (id, company_id)                          -- target for composite FKs (DB §2.1)
);
create index drivers_profile_id_company_id_idx on public.drivers (profile_id, company_id);
create index drivers_branch_id_company_id_idx  on public.drivers (branch_id, company_id);

create trigger drivers_updated   before update on public.drivers for each row execute function public.set_updated_at();
create trigger drivers_immutable before update on public.drivers for each row
  execute function public.prevent_column_change('id', 'company_id', 'profile_id', 'employee_number', 'branch_id', 'created_at');
create trigger drivers_no_delete   before delete   on public.drivers for each row       execute function public.forbid_delete();
create trigger drivers_no_truncate before truncate on public.drivers for each statement execute function public.forbid_delete();
create trigger drivers_audit after insert or update or delete on public.drivers
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------- driver_licences (the only home of licence data)
create table public.driver_licences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  driver_id uuid not null,
  licence_number text not null check (licence_number = btrim(licence_number) and length(licence_number) between 1 and 50),
  licence_code text not null check (licence_code = upper(btrim(licence_code)) and length(licence_code) between 1 and 20),
  issue_date date not null,
  expiry_date date not null,
  prdp_required boolean not null default false,
  prdp_expiry_date date,
  verification_status text not null default 'recorded' check (verification_status in ('recorded', 'verified', 'rejected')),
  evidence_file_id uuid references public.evidence_files (id),   -- purpose must be licence, same company, driver's branch (trigger)
  client_submission_id uuid not null,                            -- idempotency (CLAUDE.md)
  created_by uuid not null,
  verified_by uuid,                                              -- the decider, for verified and rejected alike
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (driver_id, company_id) references public.drivers (id, company_id),
  foreign key (created_by, company_id) references public.profiles (id, company_id),
  foreign key (verified_by, company_id) references public.profiles (id, company_id),
  constraint driver_licences_dates check (expiry_date > issue_date),
  constraint driver_licences_prdp check (not prdp_required or prdp_expiry_date is not null),
  constraint driver_licences_decided check (
    (verification_status = 'recorded' and verified_by is null and verified_at is null)
    or (verification_status <> 'recorded' and verified_by is not null and verified_at is not null)),
  constraint driver_licences_no_self_verify check (verified_by is null or verified_by <> created_by), -- DEC-24
  constraint driver_licences_idempotent unique (company_id, created_by, client_submission_id),
  constraint driver_licences_no_duplicate unique (company_id, driver_id, licence_number, issue_date)
);
create index driver_licences_driver_id_company_id_idx      on public.driver_licences (driver_id, company_id);
create index driver_licences_created_by_company_id_idx     on public.driver_licences (created_by, company_id);
create index driver_licences_verified_by_company_id_idx    on public.driver_licences (verified_by, company_id);
-- one licence photo belongs to exactly one licence record (it also covers the evidence_file_id FK)
create unique index driver_licences_evidence_file_id_uq    on public.driver_licences (evidence_file_id) where evidence_file_id is not null;

-- Content is history: only the decision columns may change, and only once (recorded -> verified | rejected).
create trigger driver_licences_immutable before update on public.driver_licences for each row
  execute function public.prevent_column_change('id', 'company_id', 'driver_id', 'licence_number', 'licence_code', 'issue_date',
    'expiry_date', 'prdp_required', 'prdp_expiry_date', 'evidence_file_id', 'client_submission_id', 'created_by', 'created_at');

create function public.driver_licences_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.verification_status <> 'recorded' then
    raise exception 'a decided licence record cannot change; record a new licence instead' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger driver_licences_guard_t before update on public.driver_licences for each row execute function public.driver_licences_guard();

-- The driver must be active, and the linked file must be licence evidence of the same company, stored against
-- the driver's own branch (so branch-scoped evidence access follows the driver).
create function public.driver_licences_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d public.drivers;
begin
  select * into d from public.drivers where id = new.driver_id and company_id = new.company_id;
  if not found or d.active_status <> 'active' then
    raise exception 'licences can only be recorded for an active driver' using errcode = '23514';
  end if;
  if new.evidence_file_id is not null and not exists (
       select 1 from public.evidence_files f
       where f.id = new.evidence_file_id and f.company_id = new.company_id and f.purpose = 'licence'
         and f.branch_id is not distinct from d.branch_id) then
    raise exception 'evidence file must be licence evidence of the same company and the driver''s branch' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger driver_licences_validate_t before insert on public.driver_licences for each row execute function public.driver_licences_validate();
create trigger driver_licences_no_delete   before delete   on public.driver_licences for each row       execute function public.forbid_delete();
create trigger driver_licences_no_truncate before truncate on public.driver_licences for each statement execute function public.forbid_delete();
create trigger driver_licences_audit after insert or update or delete on public.driver_licences
  for each row execute function public.audit_row_change();

revoke execute on function public.driver_licences_guard(), public.driver_licences_validate() from public, anon, authenticated;

-- ---------------------------------------------------------------- safe view: no licence_number, no evidence id
-- Owner-rights view with an explicit row predicate, so everyone who may see the driver (not the licence number)
-- can still see expiry, class, PrDP and verification status for the licence badge. security_barrier stops a
-- caller's own filter functions from seeing rows the predicate would hide.
create view public.driver_licences_safe with (security_barrier = true) as
select dl.id, dl.company_id, dl.driver_id, d.branch_id, dl.licence_code, dl.issue_date, dl.expiry_date,
       dl.prdp_required, dl.prdp_expiry_date, dl.verification_status,
       (dl.evidence_file_id is not null) as has_evidence, dl.created_at
  from public.driver_licences dl
  join public.drivers d on d.id = dl.driver_id and d.company_id = dl.company_id
 where dl.company_id = (select public.current_company_id())
   and public.driver_register_visible(d.branch_id, d.profile_id);
revoke all on public.driver_licences_safe from public, anon, authenticated;
grant select on public.driver_licences_safe to authenticated;

-- ---------------------------------------------------------------- register view: names + licence summary
-- The driver's name lives on profiles, which RLS hides from most staff. This owner-rights view gives the register
-- screens exactly what they need and no more: no licence_number, no evidence id; the phone number only to people
-- who manage drivers in that branch; "PIN change pending" likewise. The licence summary is the newest
-- non-rejected licence record (expiry badge, DEC-22 inputs later).
create view public.driver_register with (security_barrier = true) as
select d.id, d.company_id, d.branch_id, d.employee_number, d.active_status, p.display_name,
       case when public.has_permission('driver.manage', d.branch_id) then p.phone end as phone,
       case when public.has_permission('driver.manage', d.branch_id) then p.must_change_pin end as pin_change_pending,
       lic.expiry_date as licence_expiry_date, lic.prdp_expiry_date, lic.verification_status as licence_verification_status
  from public.drivers d
  join public.profiles p on p.id = d.profile_id and p.company_id = d.company_id
  left join lateral (
    select l.expiry_date, l.prdp_expiry_date, l.verification_status
      from public.driver_licences l
     where l.driver_id = d.id and l.company_id = d.company_id and l.verification_status <> 'rejected'
     order by l.expiry_date desc
     limit 1) lic on true
 where d.company_id = (select public.current_company_id())
   and public.driver_register_visible(d.branch_id, d.profile_id);
revoke all on public.driver_register from public, anon, authenticated;
grant select on public.driver_register to authenticated;

-- ---------------------------------------------------------------- write functions (authenticated callers)
create function public.update_driver_details(p_driver_id uuid, p_display_name text, p_phone text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
  d public.drivers;
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into d from public.drivers where id = p_driver_id and company_id = v_company;
  if not found then
    raise exception 'driver not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('driver.manage', d.branch_id) then
    raise exception 'missing permission driver.manage for this branch' using errcode = '42501';
  end if;
  if p_display_name is null or btrim(p_display_name) = '' or length(btrim(p_display_name)) > 200 then
    raise exception 'a display name (1-200 characters) is required' using errcode = '22023';
  end if;
  if p_phone is not null and (btrim(p_phone) = '' or length(p_phone) > 40) then
    raise exception 'phone must be 1-40 characters or empty' using errcode = '22023';
  end if;
  perform set_config('app.audit_reason', 'driver details updated', true);
  update public.profiles set display_name = btrim(p_display_name), phone = nullif(btrim(p_phone), '')
   where id = d.profile_id and company_id = v_company;
  perform set_config('app.audit_reason', '', true);
end $$;

-- Deactivate / reactivate. Never a delete. A deactivated driver cannot sign in: access_cleared() requires an
-- active profile, so RLS stops them at once; their history stays.
create function public.set_driver_status(p_driver_id uuid, p_status text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
  d public.drivers;
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_status not in ('active', 'inactive') then
    raise exception 'unknown status %', p_status using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500 then
    raise exception 'a reason (1-500 characters) is required' using errcode = '22023';
  end if;
  select * into d from public.drivers where id = p_driver_id and company_id = v_company for update;
  if not found then
    raise exception 'driver not found' using errcode = 'P0002';
  end if;
  if not public.has_permission('driver.manage', d.branch_id) then
    raise exception 'missing permission driver.manage for this branch' using errcode = '42501';
  end if;
  if d.profile_id = auth.uid() then
    raise exception 'nobody may change the status of their own driver record (DEC-24)' using errcode = '42501';
  end if;
  perform set_config('app.audit_reason', btrim(p_reason), true);
  update public.drivers set active_status = p_status where id = d.id;
  update public.profiles
     set status = case when p_status = 'inactive' then 'disabled' else 'active' end,
         locked_until = case when p_status = 'active' then null else locked_until end
   where id = d.profile_id and company_id = v_company
     and (p_status = 'inactive' and status <> 'disabled' or p_status = 'active' and status = 'disabled');
  perform set_config('app.audit_reason', '', true);
end $$;

create function public.record_driver_licence(
  p_driver_id uuid, p_licence_number text, p_licence_code text, p_issue_date date, p_expiry_date date,
  p_prdp_required boolean, p_prdp_expiry_date date, p_evidence_file_id uuid, p_client_submission_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  d public.drivers;
  v_id uuid;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'client_submission_id is required' using errcode = '22023';
  end if;
  -- idempotent retry: the same submission returns the same record
  select id into v_id from public.driver_licences
   where company_id = v_company and created_by = v_uid and client_submission_id = p_client_submission_id;
  if found then
    return v_id;
  end if;
  select * into d from public.drivers where id = p_driver_id and company_id = v_company;
  if not found then
    raise exception 'driver not found' using errcode = 'P0002';
  end if;
  -- entering licence data needs both: manage the driver, and be allowed to handle sensitive licence data
  if not public.has_permission('driver.manage', d.branch_id) or not public.can_view_licence(d.branch_id, d.profile_id) then
    raise exception 'missing permission driver.manage and driver.licence.view_sensitive for this branch' using errcode = '42501';
  end if;
  insert into public.driver_licences (company_id, driver_id, licence_number, licence_code, issue_date, expiry_date,
    prdp_required, prdp_expiry_date, evidence_file_id, client_submission_id, created_by)
  values (v_company, d.id, btrim(p_licence_number), upper(btrim(p_licence_code)), p_issue_date, p_expiry_date,
    coalesce(p_prdp_required, false), p_prdp_expiry_date, p_evidence_file_id, p_client_submission_id, v_uid)
  returning id into v_id;
  return v_id;
end $$;

-- Verification: a different person from the creator (DEC-24), not the licence holder, and able to see the
-- licence (so they can compare it with the evidence). The decision is final; a mistake is a new record.
create function public.verify_driver_licence(p_licence_id uuid, p_decision text, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
  l public.driver_licences;
  d public.drivers;
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_decision not in ('verified', 'rejected') then
    raise exception 'decision must be verified or rejected' using errcode = '22023';
  end if;
  if p_decision = 'rejected' and (p_reason is null or btrim(p_reason) = '' or length(p_reason) > 500) then
    raise exception 'a reason (1-500 characters) is required to reject a licence record' using errcode = '22023';
  end if;
  select * into l from public.driver_licences where id = p_licence_id and company_id = v_company for update;
  if not found then
    raise exception 'licence record not found' using errcode = 'P0002';
  end if;
  select * into d from public.drivers where id = l.driver_id and company_id = v_company;
  if not public.has_permission('driver.manage', d.branch_id) or not public.can_view_licence(d.branch_id, d.profile_id) then
    raise exception 'missing permission driver.manage and driver.licence.view_sensitive for this branch' using errcode = '42501';
  end if;
  if l.created_by = v_uid then
    raise exception 'nobody verifies a record they created (DEC-24)' using errcode = '42501';
  end if;
  if d.profile_id = v_uid then
    raise exception 'nobody verifies their own licence (DEC-24)' using errcode = '42501';
  end if;
  if l.verification_status <> 'recorded' then
    raise exception 'this licence record has already been decided' using errcode = '55000';
  end if;
  perform set_config('app.audit_reason',
    case p_decision when 'verified' then 'licence record verified' else 'licence record rejected: ' || btrim(p_reason) end, true);
  update public.driver_licences
     set verification_status = p_decision, verified_by = v_uid, verified_at = now()
   where id = l.id;
  perform set_config('app.audit_reason', '', true);
end $$;

revoke all on function
  public.update_driver_details(uuid, text, text),
  public.set_driver_status(uuid, text, text),
  public.record_driver_licence(uuid, text, text, date, date, boolean, date, uuid, uuid),
  public.verify_driver_licence(uuid, text, text)
  from public, anon;
grant execute on function
  public.update_driver_details(uuid, text, text),
  public.set_driver_status(uuid, text, text),
  public.record_driver_licence(uuid, text, text, date, date, boolean, date, uuid, uuid),
  public.verify_driver_licence(uuid, text, text)
  to authenticated;

-- ---------------------------------------------------------------- RLS + grants (deny by default)
alter table public.drivers          enable row level security;
alter table public.driver_licences  enable row level security;
revoke all on public.drivers, public.driver_licences from public, anon, authenticated;
grant select on public.drivers, public.driver_licences to authenticated;
-- No INSERT / UPDATE / DELETE for any client role: writes go through the functions above and admin_create_driver (020).

create policy drivers_select on public.drivers for select to authenticated
  using (company_id = (select public.current_company_id()) and public.driver_register_visible(branch_id, profile_id));

-- licence_number lives only here: rows are visible only to driver.licence.view_sensitive holders in scope.
create policy driver_licences_select on public.driver_licences for select to authenticated
  using (company_id = (select public.current_company_id())
         and exists (select 1 from public.drivers d
                     where d.id = driver_licences.driver_id and d.company_id = driver_licences.company_id
                       and public.can_view_licence(d.branch_id, d.profile_id)));
