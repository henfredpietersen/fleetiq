-- 013 — performance tidy-up (ARCH v1.8 §10, §5.4; DB Design v1.5).
-- Source: Supabase advisor 2026-11-17 (0001 unindexed_foreign_keys, 0003 auth_rls_initplan).
-- NO BEHAVIOUR CHANGE: no change to tables, columns, grants, permissions or policy logic.
-- Every recreated policy allows and denies exactly the same rows as before; only argument-free
-- helper calls are wrapped in a scalar subquery so Postgres evaluates them once per statement.
-- Not touched: public.rls_auto_enable() (project setting). "Unused index" findings ignored (empty DB).

-- ================================================================ Part A: FK covering indexes
-- Full (non-partial) indexes, FK column order, named <table>_<cols>_idx. Partial
-- "where col is not null" indexes were considered and not used: the tables are tiny, the
-- saving is negligible, and plain indexes match the advisor's check and every lookup shape.
create index auth_login_attempts_company_id_idx           on public.auth_login_attempts (company_id);
create index auth_login_attempts_profile_id_idx           on public.auth_login_attempts (profile_id);
create index background_jobs_company_id_idx               on public.background_jobs (company_id);
create index departments_branch_id_company_id_idx         on public.departments (branch_id, company_id);
create index departments_company_id_idx                   on public.departments (company_id);
create index evidence_access_log_accessed_by_company_id_idx on public.evidence_access_log (accessed_by, company_id);
create index evidence_access_log_company_id_idx           on public.evidence_access_log (company_id);
create index evidence_files_branch_id_company_id_idx      on public.evidence_files (branch_id, company_id);
create index evidence_files_uploaded_by_company_id_idx    on public.evidence_files (uploaded_by, company_id);
create index evidence_upload_slots_evidence_file_id_idx   on public.evidence_upload_slots (evidence_file_id);
create index evidence_upload_slots_branch_id_company_id_idx on public.evidence_upload_slots (branch_id, company_id);
create index evidence_upload_slots_requested_by_company_id_idx on public.evidence_upload_slots (requested_by, company_id);
create index profiles_company_id_idx                      on public.profiles (company_id);
create index role_permissions_permission_id_idx           on public.role_permissions (permission_id);
create index roles_company_id_idx                         on public.roles (company_id);
create index user_roles_branch_id_company_id_idx          on public.user_roles (branch_id, company_id);
create index user_roles_company_id_idx                    on public.user_roles (company_id);
create index user_roles_granted_by_company_id_idx         on public.user_roles (granted_by, company_id);
create index user_roles_role_id_idx                       on public.user_roles (role_id);
create index user_roles_user_id_company_id_idx            on public.user_roles (user_id, company_id);

-- (user_id, company_id) covers every lookup by user_id alone, so the old single-column index is redundant.
drop index public.user_roles_user_idx;

-- ================================================================ Part B: RLS initplan (lint 0003)
-- Calls that take a row column (has_permission('audit.view', branch_id), can_view_evidence(...))
-- are intentionally left as they are in audit_logs_select / evidence_*_select.

-- Company boundary (004)
drop policy companies_select on public.companies;
create policy companies_select on public.companies for select to authenticated
  using (id = (select public.current_company_id()));

drop policy branches_select on public.branches;
create policy branches_select on public.branches for select to authenticated
  using (company_id = (select public.current_company_id()));

drop policy departments_select on public.departments;
create policy departments_select on public.departments for select to authenticated
  using (company_id = (select public.current_company_id()));

-- profiles (004)
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid())
         or (company_id = (select public.current_company_id())
             and (select public.has_permission('users.roles.manage', null))));

-- roles / permissions config (004)
drop policy roles_select on public.roles;
create policy roles_select on public.roles for select to authenticated
  using ((select public.current_company_id()) is not null
         and (company_id is null or company_id = (select public.current_company_id())));

drop policy permissions_select on public.permissions;
create policy permissions_select on public.permissions for select to authenticated
  using ((select public.current_company_id()) is not null);

drop policy role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions for select to authenticated
  using ((select public.current_company_id()) is not null
         and exists (select 1 from public.roles r where r.id = role_id
                     and (r.company_id is null or r.company_id = (select public.current_company_id()))));

-- user_roles (004 select/insert; 008 update, the latest version)
drop policy user_roles_select on public.user_roles;
create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.uid())
         or (company_id = (select public.current_company_id())
             and (select public.has_permission('users.roles.manage', null))));

drop policy user_roles_insert on public.user_roles;
create policy user_roles_insert on public.user_roles for insert to authenticated
  with check (company_id = (select public.current_company_id())
              and (select public.has_permission('users.roles.manage', null))
              and user_id <> (select auth.uid())
              and granted_by = (select auth.uid()));

drop policy user_roles_update on public.user_roles;
create policy user_roles_update on public.user_roles for update to authenticated
  using (company_id = (select public.current_company_id())
         and (select public.has_permission('users.roles.manage', null))
         and user_id <> (select auth.uid()))
  with check (company_id = (select public.current_company_id())
              and user_id <> (select auth.uid())
              and effective_to is not null
              and (effective_to <= now() or effective_to = effective_from));

-- evidence_upload_slots (010)
drop policy evidence_slots_select on public.evidence_upload_slots;
create policy evidence_slots_select on public.evidence_upload_slots for select to authenticated
  using (requested_by = (select auth.uid()) and company_id = (select public.current_company_id()));
