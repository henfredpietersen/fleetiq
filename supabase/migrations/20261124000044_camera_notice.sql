-- 044 — Slice 4B (4/4): the first-use camera notice (PRD §6, DEC-29, DEC-27).
-- Added: camera_notice_acknowledgements (append-only: who, when, which notice version), acknowledge_camera_notice(version),
--        camera_notice_acknowledged(version).
-- The notice tells the person that inspection photos, the odometer reading, the time and, where the phone allows, the location
-- are recorded for vehicle accountability and kept for 5 years (DEC-27). Declining never blocks the camera; the app asks again
-- next time. The text and its version live in the app (src/modules/evidence-storage/domain/camera-notice.ts); this table
-- only proves who acknowledged which version and when. One row per person and version.

create table public.camera_notice_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  profile_id uuid not null,
  notice_version text not null check (notice_version = btrim(notice_version) and length(notice_version) between 1 and 40),
  acknowledged_at timestamptz not null default now(),
  foreign key (profile_id, company_id) references public.profiles (id, company_id),
  constraint camera_notice_ack_uq unique (company_id, profile_id, notice_version)     -- also covers the company_id FK
);
create index camera_notice_ack_profile_company_idx on public.camera_notice_acknowledgements (profile_id, company_id);

create trigger camera_notice_ack_no_change before update or delete on public.camera_notice_acknowledgements
  for each row execute function public.append_only();
create trigger camera_notice_ack_no_truncate before truncate on public.camera_notice_acknowledgements
  for each statement execute function public.append_only();
create trigger camera_notice_ack_audit after insert on public.camera_notice_acknowledgements
  for each row execute function public.audit_row_change();

alter table public.camera_notice_acknowledgements enable row level security;
revoke all on public.camera_notice_acknowledgements from public, anon, authenticated, service_role;
grant select on public.camera_notice_acknowledgements to authenticated;
create policy camera_notice_ack_select on public.camera_notice_acknowledgements for select to authenticated
  using (company_id = (select public.current_company_id()) and profile_id = auth.uid());

create function public.acknowledge_camera_notice(p_notice_version text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_notice_version is null or btrim(p_notice_version) = '' or length(btrim(p_notice_version)) > 40 then
    raise exception 'a notice version is required' using errcode = '22023';
  end if;
  insert into public.camera_notice_acknowledgements (company_id, profile_id, notice_version)
  values (v_company, auth.uid(), btrim(p_notice_version))
  on conflict (company_id, profile_id, notice_version) do nothing;
end $$;

create function public.camera_notice_acknowledged(p_notice_version text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.camera_notice_acknowledgements a
                  where a.company_id = public.current_company_id() and a.profile_id = auth.uid()
                    and a.notice_version = btrim(p_notice_version))
$$;

revoke all on function public.acknowledge_camera_notice(text), public.camera_notice_acknowledged(text) from public, anon, authenticated;
grant execute on function public.acknowledge_camera_notice(text), public.camera_notice_acknowledged(text) to authenticated;
