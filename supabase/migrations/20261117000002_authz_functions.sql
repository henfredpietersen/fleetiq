-- Phase 1A — authorisation helpers (DB §3 "Helper function", ARCH §5.2–5.4, DEC-23, AD-05).

-- Company of the current (active) user, or NULL.
create function public.current_company_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.company_id from public.profiles p
  where p.id = auth.uid() and p.status = 'active'
$$;

-- The single authorisation check used by RLS and server services.
--   target_branch_id NULL     -> user needs a company-wide grant (user_roles.branch_id IS NULL).
--   target_branch_id NOT NULL -> company-wide grant OR a grant for exactly that branch; the
--                                branch must belong to the user's company.
-- Honours effective_from/effective_to and the company boundary; inactive profiles get nothing.
create function public.has_permission(permission_key text, target_branch_id uuid)
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
      and p.status = 'active'
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

revoke all on function public.current_company_id() from public, anon;
revoke all on function public.has_permission(text, uuid) from public, anon;
grant execute on function public.current_company_id() to authenticated, service_role;
grant execute on function public.has_permission(text, uuid) to authenticated, service_role;
