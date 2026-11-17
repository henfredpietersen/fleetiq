-- Phase 1C review fix: direct Storage reads must go through a LOGGED grant (ARCH §6.6, "every issue is
-- written to evidence_access_log").
-- Before: storage SELECT only required evidence.view, so a user could read/sign an object directly with
-- their own session and skip issue_evidence_access() — no access-log row.
-- Now: storage SELECT additionally requires an access-log row written by THIS user for THIS file whose
-- window (url_expires_at) is still open. The window length comes from the app's signed-URL lifetime,
-- passed in by the server when it calls issue_evidence_access(). No service-role key is involved.

alter table public.evidence_access_log add column url_expires_at timestamptz;  -- end of the grant window

-- New signature (adds p_ttl_seconds): drop the old one so there is exactly one way in.
drop function public.issue_evidence_access(uuid, text, text, uuid);

create function public.issue_evidence_access(
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
     or not public.can_view_evidence(f.company_id, f.branch_id, f.uploaded_by, f.purpose) then
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

revoke all on function public.issue_evidence_access(uuid, text, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.issue_evidence_access(uuid, text, text, uuid, integer) to authenticated, service_role;

-- Storage SELECT (read, list, sign): can_view_evidence() AND a fresh grant of the caller's own.
create or replace function public.evidence_object_readable(p_bucket text, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.evidence_files f
    where f.bucket = p_bucket and f.object_path = p_path
      and public.can_view_evidence(f.company_id, f.branch_id, f.uploaded_by, f.purpose)
      and exists (
        select 1 from public.evidence_access_log l
        where l.evidence_file_id = f.id
          and l.accessed_by = auth.uid()
          and l.access_type = 'signed_url_issued'
          and l.url_expires_at > now()
      )
  )
$$;
