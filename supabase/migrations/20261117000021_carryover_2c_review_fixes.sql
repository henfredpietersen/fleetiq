-- 021 — Slice 2C carry-over (from the PR #7 review and the Supabase security advisor). Own migration; 001–020 are not edited.
--   C1  Clear the advisor ERROR "security_definer_view" on driver_register and driver_licences_safe WITHOUT changing
--       what anyone can see: the row logic moves into SECURITY DEFINER set-returning functions with the SAME
--       predicates; the views become security_invoker over those functions (same names, columns, order).
--   C2  Defence in depth on the admin flag functions (service role only): they now re-check the actor's
--       permission themselves, like admin_create_driver / admin_create_staff already do.
--   C3  Record DEC-37 (Approved 2026-11-17) in the database as a function comment.
-- Conventions: explicit REVOKE on every new function; (select ...) around argument-free calls.

-- ---------------------------------------------------------------- C1: driver_licences_safe
-- Same columns, same order, same predicate as 018: company boundary + driver_register_visible().
create function public.driver_licences_safe_rows()
returns table (
  id uuid, company_id uuid, driver_id uuid, branch_id uuid, licence_code text, issue_date date, expiry_date date,
  prdp_required boolean, prdp_expiry_date date, verification_status text, has_evidence boolean, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select dl.id, dl.company_id, dl.driver_id, d.branch_id, dl.licence_code, dl.issue_date, dl.expiry_date,
         dl.prdp_required, dl.prdp_expiry_date, dl.verification_status,
         (dl.evidence_file_id is not null) as has_evidence, dl.created_at
    from public.driver_licences dl
    join public.drivers d on d.id = dl.driver_id and d.company_id = dl.company_id
   where dl.company_id = (select public.current_company_id())
     and public.driver_register_visible(d.branch_id, d.profile_id)
$$;

-- ---------------------------------------------------------------- C1: driver_register
-- Same columns, same order, same predicates as 018: company boundary, driver_register_visible(), and the
-- driver.manage gating of phone and pin_change_pending.
create function public.driver_register_rows()
returns table (
  id uuid, company_id uuid, branch_id uuid, employee_number text, active_status text, display_name text,
  phone text, pin_change_pending boolean,
  licence_expiry_date date, prdp_expiry_date date, licence_verification_status text)
language sql stable security definer set search_path = '' as $$
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
     and public.driver_register_visible(d.branch_id, d.profile_id)
$$;

revoke all on function public.driver_licences_safe_rows(), public.driver_register_rows() from public, anon;
grant execute on function public.driver_licences_safe_rows(), public.driver_register_rows() to authenticated;

-- Nothing depends on these views (no other view, no function body that resolves them at create time).
drop view public.driver_licences_safe;
drop view public.driver_register;

create view public.driver_licences_safe with (security_invoker = true, security_barrier = true) as
  select * from public.driver_licences_safe_rows();
create view public.driver_register with (security_invoker = true, security_barrier = true) as
  select * from public.driver_register_rows();

revoke all on public.driver_licences_safe, public.driver_register from public, anon, authenticated;
grant select on public.driver_licences_safe, public.driver_register to authenticated;

-- ---------------------------------------------------------------- C2: admin flag functions (service role only)
-- Same signatures (CREATE OR REPLACE), same grants (service_role only; 007 / 020 revoked and granted already).
create or replace function public.auth_issue_staff_password_flags(p_target uuid, p_actor uuid) returns void
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
  -- C2: defence in depth. The server authorises first; the database no longer trusts it blindly.
  if not public.user_has_permission(p_actor, 'users.roles.manage', null) then
    raise exception 'missing permission users.roles.manage' using errcode = '42501';
  end if;
  perform set_config('app.actor_id', p_actor::text, true);
  perform set_config('app.audit_reason', 'staff password reset by administrator', true);
  update public.profiles set must_change_pin = true, pin_set_at = now() where id = p_target;
  perform set_config('app.actor_id', '', true);
  perform set_config('app.audit_reason', '', true);
end $$;

-- The target driver's branch: the drivers row (2B) or, for a driver profile that has none yet, the branch of its
-- current driver-role grant (AD-05: user_roles is the only branch-scope source). No branch -> refused.
create or replace function public.auth_issue_pin_flags(p_target uuid, p_actor uuid, p_mode text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.profiles; a public.profiles; v_branch uuid;
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
  -- C2: defence in depth — driver.manage in the target driver's branch.
  select coalesce(
           (select d.branch_id from public.drivers d where d.profile_id = p_target and d.company_id = t.company_id),
           (select ur.branch_id from public.user_roles ur
              join public.roles r on r.id = ur.role_id and r.company_id is null and r.name = 'driver'
             where ur.user_id = p_target and ur.company_id = t.company_id and ur.branch_id is not null
               and ur.effective_from <= now() and (ur.effective_to is null or ur.effective_to > now())
             order by ur.effective_from desc limit 1))
    into v_branch;
  if v_branch is null or not public.user_has_permission(p_actor, 'driver.manage', v_branch) then
    raise exception 'missing permission driver.manage for the driver''s branch' using errcode = '42501';
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

-- ---------------------------------------------------------------- C3: DEC-37 recorded in the database
comment on function public.driver_register_visible(uuid, uuid) is
  'DEC-37 Approved 2026-11-17: supervisor, fleet admin, branch manager, senior management within scope; driver own record; maintenance and system admin none.';
