-- Phase 1A — RLS, deny by default (DB §2 rule 13; DEC-24). UI is never the boundary.
-- Client writes exist only for user_roles. Companies, branches, departments, profiles and
-- role/permission config are written by migrations or reviewed admin functions (service role).

alter table public.companies        enable row level security;
alter table public.branches         enable row level security;
alter table public.departments      enable row level security;
alter table public.profiles         enable row level security;
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles       enable row level security;
alter table public.audit_logs       enable row level security;

-- Table privileges: nothing for anon/public; read-only for authenticated, except user_roles.
revoke all on public.companies, public.branches, public.departments, public.profiles,
  public.roles, public.permissions, public.role_permissions, public.user_roles,
  public.audit_logs from public, anon, authenticated;
grant select on public.companies, public.branches, public.departments, public.profiles,
  public.roles, public.permissions, public.role_permissions, public.user_roles,
  public.audit_logs to authenticated;
grant insert on public.user_roles to authenticated;
grant update (effective_to) on public.user_roles to authenticated; -- revoke = end-date, never delete
-- service_role keeps its default grants but cannot bypass the audit_logs triggers.

-- Company boundary (reference data readable inside the company).
create policy companies_select on public.companies for select to authenticated
  using (id = public.current_company_id());
create policy branches_select on public.branches for select to authenticated
  using (company_id = public.current_company_id());
create policy departments_select on public.departments for select to authenticated
  using (company_id = public.current_company_id());

-- Own profile, or company profiles for user managers (users.roles.manage, company-wide).
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid()
         or (company_id = public.current_company_id()
             and public.has_permission('users.roles.manage', null)));

-- Role/permission config: system roles + own company's roles.
create policy roles_select on public.roles for select to authenticated
  using (public.current_company_id() is not null
         and (company_id is null or company_id = public.current_company_id()));
create policy permissions_select on public.permissions for select to authenticated
  using (public.current_company_id() is not null);
create policy role_permissions_select on public.role_permissions for select to authenticated
  using (public.current_company_id() is not null
         and exists (select 1 from public.roles r where r.id = role_id
                     and (r.company_id is null or r.company_id = public.current_company_id())));

-- user_roles: own grants are readable; users.roles.manage holders read/grant/end-date in
-- their company, never for themselves (DEC-24). No DELETE policy.
create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = auth.uid()
         or (company_id = public.current_company_id()
             and public.has_permission('users.roles.manage', null)));
create policy user_roles_insert on public.user_roles for insert to authenticated
  with check (company_id = public.current_company_id()
              and public.has_permission('users.roles.manage', null)
              and user_id <> auth.uid()
              and granted_by = auth.uid());
create policy user_roles_update on public.user_roles for update to authenticated
  using (company_id = public.current_company_id()
         and public.has_permission('users.roles.manage', null)
         and user_id <> auth.uid())
  with check (company_id = public.current_company_id()
              and user_id <> auth.uid());

-- Audit log: readable with audit.view for the row's branch (NULL branch = company-wide
-- grant needed). System-level rows (company_id NULL) are not visible to clients.
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (company_id = public.current_company_id()
         and public.has_permission('audit.view', branch_id));
-- No insert/update/delete policies: only the SECURITY DEFINER audit trigger writes.
