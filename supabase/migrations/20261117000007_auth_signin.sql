-- Phase 1B — authentication (ARCH §5.1, DB §3; DEC-08, DEC-24, DEC-34 approved; AD-08 proposed).
-- profiles already carries user_type, login_identifier (UNIQUE), must_change_pin, locked_until and the
-- DEC-34 staff-email CHECK (slice 1A). This migration adds what 1B still needs:
--   * profiles.pin_set_at       — when the PIN was last issued/reset/changed (lockout counting floor)
--   * roles/permissions.requires_mfa — DEC-34 as configuration data (admins + approval permissions)
--   * auth_login_attempts       — append-only, hashed employee number and IP
--   * has_permission()/current_company_id() honour forced PIN change and the AAL2 requirement
--   * service-role-only functions for the reviewed sign-in / PIN admin paths

alter table public.profiles add column pin_set_at timestamptz;

-- ---------------------------------------------------------------- MFA requirement as data (DEC-34)
alter table public.roles       add column requires_mfa boolean not null default false;
alter table public.permissions add column requires_mfa boolean not null default false;

-- "Administrators" = fleet, maintenance and system administrators; "approval permissions" =
-- every *.approve key plus service-record verification. Both are plain data, adjustable by migration.
update public.roles set requires_mfa = true
  where company_id is null and name in ('fleet_admin', 'maintenance_admin', 'system_admin');
update public.permissions set requires_mfa = true
  where permission_key like '%.approve' or permission_key = 'service.record.verify';

-- True when the user currently holds any effective grant that requires MFA (person-level rule).
create function public.user_requires_mfa(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.company_id = p.company_id
    join public.roles r on r.id = ur.role_id and (r.company_id is null or r.company_id = p.company_id)
    where p.id = p_user
      and ur.effective_from <= now()
      and (ur.effective_to is null or ur.effective_to > now())
      and (r.requires_mfa
           or exists (select 1 from public.role_permissions rp
                      join public.permissions pm on pm.id = rp.permission_id
                      where rp.role_id = r.id and pm.requires_mfa))
  )
$$;

-- Active profile that has completed any forced PIN change and, where MFA is required, is at AAL2.
-- Used by has_permission() and current_company_id() so RLS enforces both rules, not just the app.
create function public.access_cleared(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user
      and p.status = 'active'
      and not p.must_change_pin
      and (coalesce(auth.jwt() ->> 'aal', '') = 'aal2' or not public.user_requires_mfa(p.id))
  )
$$;

-- For the app: does the signed-in user need MFA? (does not itself require AAL2)
create function public.current_user_requires_mfa() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.user_requires_mfa(auth.uid()), false)
$$;

create or replace function public.current_company_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.company_id from public.profiles p
  where p.id = auth.uid() and public.access_cleared(p.id)
$$;

create or replace function public.has_permission(permission_key text, target_branch_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.company_id = p.company_id
    join public.roles r on r.id = ur.role_id and (r.company_id is null or r.company_id = p.company_id)
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions pm on pm.id = rp.permission_id
    where p.id = auth.uid()
      and public.access_cleared(p.id)
      and pm.permission_key = has_permission.permission_key
      and ur.effective_from <= now()
      and (ur.effective_to is null or ur.effective_to > now())
      and (
        (has_permission.target_branch_id is null and ur.branch_id is null)
        or (
          has_permission.target_branch_id is not null
          and (ur.branch_id is null or ur.branch_id = has_permission.target_branch_id)
          and exists (
            select 1 from public.branches b
            where b.id = has_permission.target_branch_id and b.company_id = p.company_id
          )
        )
      )
    limit 1
  ), false)
$$;

revoke all on function public.user_requires_mfa(uuid), public.access_cleared(uuid) from public, anon, authenticated;
revoke all on function public.current_user_requires_mfa() from public, anon;
grant execute on function public.current_user_requires_mfa() to authenticated, service_role;

-- ---------------------------------------------------------------- auth_login_attempts (DB §3)
-- Append-only. Employee number and IP are stored only as keyed hashes computed by the server.
create table public.auth_login_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies (id),
  employee_number_attempted text not null check (employee_number_attempted ~ '^[0-9a-f]{64}$'),
  profile_id uuid references public.profiles (id),
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  succeeded boolean not null,
  occurred_at timestamptz not null default now()
);
create index auth_login_attempts_emp_idx on public.auth_login_attempts (employee_number_attempted, occurred_at desc);
create index auth_login_attempts_ip_idx  on public.auth_login_attempts (ip_hash, occurred_at desc);

create function public.append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
create trigger auth_login_attempts_no_change before update or delete on public.auth_login_attempts
  for each row execute function public.append_only();
create trigger auth_login_attempts_no_truncate before truncate on public.auth_login_attempts
  for each statement execute function public.append_only();

-- Deny by default: no client policies at all. Only the reviewed server path (service role) reads/writes.
alter table public.auth_login_attempts enable row level security;
revoke all on public.auth_login_attempts from public, anon, authenticated;
revoke all on public.auth_login_attempts from service_role;
grant select, insert on public.auth_login_attempts to service_role;

-- ---------------------------------------------------------------- service-role-only functions
-- Failure counts for the lockout decision. The account count is keyed by the HASH (so unknown
-- employee numbers behave exactly like known ones) and restarts after the last success or the last
-- PIN issue/reset; the IP count ignores successes so one good login cannot reset an attack.
create function public.auth_login_counts(p_emp_hash text, p_ip_hash text, p_window interval, p_profile_id uuid default null)
returns table (account_failures integer, account_last_failure timestamptz, ip_failures integer, ip_last_failure timestamptz)
language sql stable security definer set search_path = '' as $$
  with floor_t as (
    select greatest(
      now() - p_window,
      coalesce((select max(a.occurred_at) from public.auth_login_attempts a
                where a.employee_number_attempted = p_emp_hash and a.succeeded), '-infinity'::timestamptz),
      coalesce((select p.pin_set_at from public.profiles p where p.id = p_profile_id), '-infinity'::timestamptz)
    ) as t
  )
  select
    (select count(*)::integer from public.auth_login_attempts a, floor_t
       where a.employee_number_attempted = p_emp_hash and not a.succeeded and a.occurred_at > floor_t.t),
    (select max(a.occurred_at) from public.auth_login_attempts a, floor_t
       where a.employee_number_attempted = p_emp_hash and not a.succeeded and a.occurred_at > floor_t.t),
    (select count(*)::integer from public.auth_login_attempts a
       where a.ip_hash = p_ip_hash and not a.succeeded and a.occurred_at > now() - p_window),
    (select max(a.occurred_at) from public.auth_login_attempts a
       where a.ip_hash = p_ip_hash and not a.succeeded and a.occurred_at > now() - p_window)
$$;

create function public.auth_login_record(p_company uuid, p_emp_hash text, p_profile uuid, p_ip_hash text, p_succeeded boolean)
returns void language sql security definer set search_path = '' as $$
  insert into public.auth_login_attempts (company_id, employee_number_attempted, profile_id, ip_hash, succeeded)
  values (p_company, p_emp_hash, p_profile, p_ip_hash, p_succeeded)
$$;

-- Temporary sign-in lockout of a driver profile; audited through the profiles audit trigger.
create function public.auth_lock_profile(p_profile uuid, p_until timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('app.audit_reason', 'sign-in lockout: repeated failed PIN attempts', true);
  update public.profiles set locked_until = p_until
  where id = p_profile and user_type = 'driver'
    and (locked_until is null or locked_until < p_until);
  perform set_config('app.audit_reason', '', true);
end $$;

-- PIN issue / reset (the PIN itself is set in Supabase Auth by the server; it never reaches these tables).
-- Structural DEC-24 guards live here as defence in depth; the permission check (driver.manage in
-- the driver's branch scope, at AAL2) is done by the server through has_permission().
create function public.auth_issue_pin_flags(p_target uuid, p_actor uuid, p_mode text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.profiles; a public.profiles;
begin
  if p_mode not in ('issue', 'reset') then
    raise exception 'unknown PIN mode %', p_mode using errcode = '22023';
  end if;
  if p_target = p_actor then
    raise exception 'nobody may issue or reset their own PIN (DEC-24)' using errcode = '42501';
  end if;
  select * into t from public.profiles where id = p_target;
  select * into a from public.profiles where id = p_actor;
  if t.id is null or a.id is null or a.status <> 'active' then
    raise exception 'unknown target or actor' using errcode = '42501';
  end if;
  if t.user_type <> 'driver' then
    raise exception 'PINs belong to driver profiles only' using errcode = '42501';
  end if;
  if t.company_id <> a.company_id then
    raise exception 'target is outside the actor''s company' using errcode = '42501';
  end if;
  perform set_config('app.actor_id', p_actor::text, true);
  perform set_config('app.audit_reason', case p_mode when 'issue' then 'driver PIN issued by administrator'
                                                       else 'driver PIN reset by administrator' end, true);
  update public.profiles
     set must_change_pin = true, pin_set_at = now(), locked_until = null
   where id = p_target;
  perform set_config('app.actor_id', '', true);
  perform set_config('app.audit_reason', '', true);
end $$;

-- Called by the server only after Supabase Auth accepted the driver's new PIN.
create function public.auth_complete_pin_change(p_profile uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('app.actor_id', p_profile::text, true);
  perform set_config('app.audit_reason', 'driver changed own PIN', true);
  update public.profiles set must_change_pin = false, pin_set_at = now()
   where id = p_profile and user_type = 'driver';
  perform set_config('app.actor_id', '', true);
  perform set_config('app.audit_reason', '', true);
end $$;

revoke all on function
  public.auth_login_counts(text, text, interval, uuid),
  public.auth_login_record(uuid, text, uuid, text, boolean),
  public.auth_lock_profile(uuid, timestamptz),
  public.auth_issue_pin_flags(uuid, uuid, text),
  public.auth_complete_pin_change(uuid)
  from public, anon, authenticated;
grant execute on function
  public.auth_login_counts(text, text, interval, uuid),
  public.auth_login_record(uuid, text, uuid, text, boolean),
  public.auth_lock_profile(uuid, timestamptz),
  public.auth_issue_pin_flags(uuid, uuid, text),
  public.auth_complete_pin_change(uuid)
  to service_role;
