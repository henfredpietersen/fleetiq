-- 020 — Slice 2B: reviewed admin functions behind account administration (ARCH §5.1, §5.3; DEC-08, DEC-24,
-- DEC-34, DEC-23; AD-05, AD-08). All SERVICE ROLE ONLY: they are called by server-only modules after the
-- caller has been authorised, and they re-check the caller themselves (user_has_permission) so a bug in the app
-- layer cannot turn them into a privilege escalation. The Supabase Auth user is created by the server first
-- (Auth is a separate service, so it cannot be part of this transaction); if anything here fails the server
-- deletes that Auth user again, so no orphan accounts remain (compensation, tested).
-- Audit: every write below hits a table with an audit trigger; app.actor_id / app.audit_reason attribute the
-- rows to the human who asked, because a service-role call has no auth.uid().

-- ---------------------------------------------------------------- explicit-actor permission check
-- Same rule as has_permission(), for a named user instead of auth.uid(). The caller must be an active profile
-- with no pending forced credential change. (AAL2 is a property of the caller's JWT, which a service-role call
-- does not have; the server checks it before calling.)
create function public.user_has_permission(p_user uuid, p_permission_key text, p_branch_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.company_id = p.company_id
    join public.roles r on r.id = ur.role_id and (r.company_id is null or r.company_id = p.company_id)
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions pm on pm.id = rp.permission_id
    where p.id = p_user
      and p.status = 'active'
      and not p.must_change_pin
      and pm.permission_key = p_permission_key
      and ur.effective_from <= now()
      and (ur.effective_to is null or ur.effective_to > now())
      and (
        (p_branch_id is null and ur.branch_id is null)
        or (
          p_branch_id is not null
          and (ur.branch_id is null or ur.branch_id = p_branch_id)
          and exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = p.company_id)
        )
      )
    limit 1
  ), false)
$$;

-- ---------------------------------------------------------------- create a driver (profile + driver + role)
create function public.admin_create_driver(
  p_actor uuid, p_user_id uuid, p_branch_id uuid, p_employee_number text, p_login_identifier text,
  p_display_name text, p_phone text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.profiles;
  v_driver uuid;
begin
  select * into a from public.profiles where id = p_actor;
  if not found or a.status <> 'active' then
    raise exception 'unknown or inactive actor' using errcode = '42501';
  end if;
  if p_actor = p_user_id then
    raise exception 'nobody creates their own account (DEC-24)' using errcode = '42501';
  end if;
  if not public.user_has_permission(p_actor, 'driver.manage', p_branch_id) then
    raise exception 'missing permission driver.manage for this branch' using errcode = '42501';
  end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.company_id = a.company_id and b.status = 'active') then
    raise exception 'branch is not an active branch of your company' using errcode = '23514';
  end if;
  if p_login_identifier is null or p_login_identifier !~ '^[a-z0-9-]+@drivers\.fleetiq\.invalid$' then
    raise exception 'login identifier must be an internal, non-deliverable identifier (AD-08)' using errcode = '23514';
  end if;
  if p_display_name is null or btrim(p_display_name) = '' or length(btrim(p_display_name)) > 200 then
    raise exception 'a display name (1-200 characters) is required' using errcode = '22023';
  end if;

  perform set_config('app.actor_id', p_actor::text, true);
  perform set_config('app.audit_reason', 'driver account created by administrator', true);

  -- temporary PIN: the driver must change it before any access (access_cleared() is false until then)
  insert into public.profiles (id, company_id, display_name, phone, user_type, login_identifier, must_change_pin, pin_set_at)
  values (p_user_id, a.company_id, btrim(p_display_name), nullif(btrim(p_phone), ''), 'driver', p_login_identifier, true, now());

  insert into public.drivers (company_id, profile_id, employee_number, branch_id)
  values (a.company_id, p_user_id, p_employee_number, p_branch_id)
  returning id into v_driver;

  -- the driver role, scoped to the driver's branch (AD-05). Granted by the actor, never by the driver (DEC-24).
  insert into public.user_roles (user_id, role_id, company_id, branch_id, effective_from, granted_by)
  select p_user_id, r.id, a.company_id, p_branch_id, now(), p_actor
    from public.roles r where r.company_id is null and r.name = 'driver';
  if not found then
    raise exception 'system role driver is missing' using errcode = '55000';
  end if;

  -- Reuse the PIN-issue function (1B): marks the temporary PIN as issued by this actor and audits it, inside this
  -- same transaction, so there is never a committed driver whose issue was not recorded. It clears the
  -- audit settings itself, so it runs last.
  perform public.auth_issue_pin_flags(p_user_id, p_actor, 'issue');
  perform set_config('app.actor_id', '', true);
  perform set_config('app.audit_reason', '', true);
  return v_driver;
end $$;

-- ---------------------------------------------------------------- create a staff profile
create function public.admin_create_staff(p_actor uuid, p_user_id uuid, p_email text, p_display_name text)
returns void
language plpgsql security definer set search_path = '' as $$
declare a public.profiles;
begin
  select * into a from public.profiles where id = p_actor;
  if not found or a.status <> 'active' then
    raise exception 'unknown or inactive actor' using errcode = '42501';
  end if;
  if p_actor = p_user_id then
    raise exception 'nobody creates their own account (DEC-24)' using errcode = '42501';
  end if;
  if not public.user_has_permission(p_actor, 'users.roles.manage', null) then
    raise exception 'missing permission users.roles.manage' using errcode = '42501';
  end if;
  if p_email is null or p_email <> lower(btrim(p_email)) or p_email !~ '^[^@\s]+@[^@\s]+$'
     or p_email like '%@drivers.fleetiq.invalid' then
    raise exception 'a deliverable, lower-case email is required for staff (DEC-34)' using errcode = '22023';
  end if;
  if p_display_name is null or btrim(p_display_name) = '' or length(btrim(p_display_name)) > 200 then
    raise exception 'a display name (1-200 characters) is required' using errcode = '22023';
  end if;
  perform set_config('app.actor_id', p_actor::text, true);
  perform set_config('app.audit_reason', 'staff account created by administrator', true);
  -- temporary password: forced change before any access
  insert into public.profiles (id, company_id, display_name, email, user_type, login_identifier, must_change_pin, pin_set_at)
  values (p_user_id, a.company_id, btrim(p_display_name), p_email, 'staff', p_email, true, now());
  perform set_config('app.actor_id', '', true);
  perform set_config('app.audit_reason', '', true);
end $$;

-- ---------------------------------------------------------------- staff password flags (mirror the PIN ones)
-- After an administrator resets a staff password the person must choose their own.
create function public.auth_issue_staff_password_flags(p_target uuid, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.profiles; a public.profiles;
begin
  if p_target = p_actor then
    raise exception 'nobody may reset their own password through the administrator path (DEC-24)' using errcode = '42501';
  end if;
  select * into t from public.profiles where id = p_target;
  select * into a from public.profiles where id = p_actor;
  if t.id is null or a.id is null or a.status <> 'active' then
    raise exception 'unknown target or actor' using errcode = '42501';
  end if;
  if t.user_type <> 'staff' then
    raise exception 'staff passwords belong to staff profiles only' using errcode = '42501';
  end if;
  if t.company_id <> a.company_id then
    raise exception 'target is outside the actor''s company' using errcode = '42501';
  end if;
  perform set_config('app.actor_id', p_actor::text, true);
  perform set_config('app.audit_reason', 'staff password reset by administrator', true);
  update public.profiles set must_change_pin = true, pin_set_at = now() where id = p_target;
  perform set_config('app.actor_id', '', true);
  perform set_config('app.audit_reason', '', true);
end $$;

-- Called by the server only after Supabase Auth accepted the staff member's new password.
create function public.auth_complete_password_change(p_profile uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('app.actor_id', p_profile::text, true);
  perform set_config('app.audit_reason', 'staff member changed own password', true);
  update public.profiles set must_change_pin = false, pin_set_at = now()
   where id = p_profile and user_type = 'staff';
  perform set_config('app.actor_id', '', true);
  perform set_config('app.audit_reason', '', true);
end $$;

revoke all on function
  public.user_has_permission(uuid, text, uuid),
  public.admin_create_driver(uuid, uuid, uuid, text, text, text, text),
  public.admin_create_staff(uuid, uuid, text, text),
  public.auth_issue_staff_password_flags(uuid, uuid),
  public.auth_complete_password_change(uuid)
  from public, anon, authenticated;
grant execute on function
  public.user_has_permission(uuid, text, uuid),
  public.admin_create_driver(uuid, uuid, uuid, text, text, text, text),
  public.admin_create_staff(uuid, uuid, text, text),
  public.auth_issue_staff_password_flags(uuid, uuid),
  public.auth_complete_password_change(uuid)
  to service_role;
