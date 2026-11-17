-- Phase 1C — private evidence bucket and storage policies (ARCH §6.6; DB §7).
-- Private only: no public URL. The bucket limits are a hard backstop; the app enforces configurable,
-- equal-or-stricter limits (EVIDENCE_MAX_BYTES / EVIDENCE_ALLOWED_MIME).
-- Clients get exactly two storage permissions, both tied to the evidence tables:
--   INSERT  only at a path of their own open upload slot  (this is what lets the server mint a signed upload URL)
--   SELECT  only on registered evidence they may view     (this is what lets the server mint a signed read URL)
-- No UPDATE/DELETE for clients: evidence objects are immutable. Verification, the EXIF rewrite and
-- cleanup run in reviewed service-role server code.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 15728640, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy evidence_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'evidence' and public.evidence_slot_open_for_upload(bucket_id, name));

create policy evidence_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and public.evidence_object_readable(bucket_id, name));
