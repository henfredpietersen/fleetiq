-- 019 — Slice 2B: licence evidence is sensitive (PRD §4.2 driver.licence.view_sensitive, §6 POPIA; DB §4, §7;
-- ARCH §6.6; DEC-23, DEC-24).
-- Before: any holder of evidence.view could open ANY evidence purpose in their scope, so senior management
-- (evidence.view = All) could see licence photos. Now purpose 'licence' ALSO needs driver.licence.view_sensitive
-- for the file's branch (matrix: Driver = Own, Supervisor = Branch, Fleet admin = All, Branch manager = Branch;
-- senior management, maintenance admin and system admin hold no such permission).
--
-- evidence_scope_allows() and can_view_evidence() are replaced with the SAME signatures. They only receive the
-- file's company, branch, uploader and purpose, never its id, so "Own" for a driver (whose licence photo was
-- uploaded by a manager) cannot be decided inside them. Two ways that stays fail-closed:
--   * inside the two functions, licence evidence is allowed only for supervisor / fleet administrator / branch
--     manager (with view_sensitive), never for a driver or a custom role;
--   * a driver's own licence photo is allowed by the new licence_evidence_owner_allows(file id), OR-ed in at the
--     three places that read evidence: the evidence_files_select policy, issue_evidence_access() and
--     evidence_object_readable(). Those two functions are replaced with their existing signatures and bodies
--     plus that one condition; nothing else about them changes.

create or replace function public.evidence_scope_allows(p_branch_id uuid, p_uploaded_by uuid, p_purpose text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select true
    from public.profiles p
    join public.user_roles ur on ur.user_id = p.id and ur.company_id = p.company_id
    join public.roles r on r.id = ur.role_id and (r.company_id is null or r.company_id = p.company_id)
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions pm on pm.id = rp.permission_id and pm.permission_key = 'evidence.view'
    where p.id = auth.uid()
      and public.access_cleared(p.id)
      and ur.effective_from <= now()
      and (ur.effective_to is null or ur.effective_to > now())
      and (ur.branch_id is null or ur.branch_id = p_branch_id)
      and case
            -- licence evidence: only the roles that carry driver.licence.view_sensitive beyond "own" (see header)
            when p_purpose = 'licence'
              then r.company_id is null and r.name in ('supervisor', 'fleet_admin', 'branch_manager')
            when r.company_id is null and r.name in ('supervisor', 'fleet_admin', 'branch_manager', 'senior_management')
              then true
            when r.company_id is null and r.name = 'maintenance_admin'
              then p_purpose = 'service_record'
            else p_uploaded_by = auth.uid()
          end
    limit 1
  ), false)
$$;

create or replace function public.can_view_evidence(p_company_id uuid, p_branch_id uuid, p_uploaded_by uuid, p_purpose text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select p_company_id is not distinct from public.current_company_id()
     and public.has_permission('evidence.view', p_branch_id)
     and (p_purpose <> 'licence' or public.has_permission('driver.licence.view_sensitive', p_branch_id))
     and public.evidence_scope_allows(p_branch_id, p_uploaded_by, p_purpose)
$$;

-- A driver's own licence photo ("Own"): the file is linked to a licence record of the caller's own driver record,
-- and the caller holds evidence.view and driver.licence.view_sensitive for that branch.
create function public.licence_evidence_owner_allows(p_file_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.evidence_files f
    join public.driver_licences dl on dl.evidence_file_id = f.id and dl.company_id = f.company_id
    join public.drivers d on d.id = dl.driver_id and d.company_id = dl.company_id
    where f.id = p_file_id
      and f.purpose = 'licence'
      and f.company_id = public.current_company_id()
      and d.profile_id = auth.uid()
      and public.has_permission('evidence.view', f.branch_id)
      and public.can_view_licence(d.branch_id, d.profile_id)
  )
$$;
revoke all on function public.licence_evidence_owner_allows(uuid) from public, anon;
grant execute on function public.licence_evidence_owner_allows(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- the three readers (signatures unchanged)
drop policy evidence_files_select on public.evidence_files;
create policy evidence_files_select on public.evidence_files for select to authenticated
  using (public.can_view_evidence(company_id, branch_id, uploaded_by, purpose)
         or public.licence_evidence_owner_allows(id));

create or replace function public.issue_evidence_access(
  p_evidence_file_id uuid, p_purpose text default 'view',
  p_related_entity_type text default null, p_related_entity_id uuid default null,
  p_ttl_seconds integer default 300
) returns table (bucket text, object_path text)
language plpgsql security definer set search_path = '' as $$
declare
  f public.evidence_files;
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 300), 1), 3600);
begin
  select * into f from public.evidence_files where id = p_evidence_file_id;
  if not found or auth.uid() is null
     or not (public.can_view_evidence(f.company_id, f.branch_id, f.uploaded_by, f.purpose)
             or public.licence_evidence_owner_allows(f.id)) then
    raise exception 'evidence not available' using errcode = '42501';
  end if;
  insert into public.evidence_access_log
    (company_id, branch_id, evidence_file_id, accessed_by, access_type, purpose, related_entity_type,
     related_entity_id, url_expires_at)
  values
    (f.company_id, f.branch_id, f.id, auth.uid(), 'signed_url_issued',
     left(coalesce(p_purpose, 'view'), 100), left(p_related_entity_type, 100), p_related_entity_id,
     now() + v_ttl * interval '1 second');
  return query select f.bucket, f.object_path;
end $$;

create or replace function public.evidence_object_readable(p_bucket text, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.evidence_files f
    where f.bucket = p_bucket and f.object_path = p_path
      and (public.can_view_evidence(f.company_id, f.branch_id, f.uploaded_by, f.purpose)
           or public.licence_evidence_owner_allows(f.id))
      and exists (
        select 1 from public.evidence_access_log l
        where l.evidence_file_id = f.id
          and l.accessed_by = auth.uid()
          and l.access_type = 'signed_url_issued'
          and l.url_expires_at > now()
      )
  )
$$;
