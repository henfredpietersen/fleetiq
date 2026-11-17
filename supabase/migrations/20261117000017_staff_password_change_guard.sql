-- 017 — close the open risk left by carry-over C3 (slice 2B; DEC-34, AD-08).
--
-- Problem: Supabase Auth's global minimum password length stays 6 because driver PINs share it. A signed-in staff
-- user could therefore call Auth's updateUser({ password }) straight from their browser (or use a recovery link)
-- and set a short password, bypassing the 12-character staff policy enforced by StaffAccounts in the app.
--
-- Fix, enforced in the database so no client path can skip it: any change to auth.users.encrypted_password for a
-- STAFF profile is refused unless the server has just recorded a single-use, 10-second authorisation for that user.
-- The server (service role only) records it AFTER validating the password against the staff policy.
-- Drivers are untouched (their PIN rules are enforced by the PIN code paths). Creating a user is not a password
-- UPDATE and is not affected: signups are disabled (config.toml enable_signup = false), so accounts only come from
-- the admin API.
--
-- Residual limits, stated honestly: (1) the authorisation is per user, not bound to the exact password, so a user
-- who races their own direct call into the few milliseconds between the server's authorisation and its update could
-- spend it with a weaker password — it needs deliberate timing and only affects their own account;
-- (2) if GoTrue ever rehashes a staff password on sign-in (bcrypt cost change) this guard would refuse that write,
-- and sign-in would still succeed — retest after a GoTrue upgrade.

create table public.staff_password_authorisations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  user_id uuid not null,   -- the staff user whose password hash may change once
  actor_id uuid not null,  -- who asked (themselves for a change, a manager for a reset)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 seconds',
  consumed_at timestamptz,
  foreign key (user_id, company_id) references public.profiles (id, company_id),
  foreign key (actor_id, company_id) references public.profiles (id, company_id),
  check (expires_at > created_at)
);
create index staff_password_authorisations_company_id_idx on public.staff_password_authorisations (company_id);
create index staff_password_authorisations_user_id_company_id_idx on public.staff_password_authorisations (user_id, company_id);
create index staff_password_authorisations_actor_id_company_id_idx on public.staff_password_authorisations (actor_id, company_id);

alter table public.staff_password_authorisations enable row level security;
revoke all on public.staff_password_authorisations from public, anon, authenticated;
revoke all on public.staff_password_authorisations from service_role;
-- Written only through the SECURITY DEFINER functions below; nobody has DML. History is kept (no deletes).

create trigger staff_password_authorisations_audit
  after insert or update on public.staff_password_authorisations
  for each row execute function public.audit_row_change();

-- Server-side only: called by StaffAccounts after the password passed the staff policy.
create function public.authorise_staff_password_change(p_user uuid, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.profiles where id = p_user and user_type = 'staff';
  if v_company is null then
    raise exception 'not a staff user' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_actor and company_id = v_company) then
    raise exception 'actor is not in the same company' using errcode = '42501';
  end if;
  insert into public.staff_password_authorisations (company_id, user_id, actor_id)
  values (v_company, p_user, p_actor);
end $$;
revoke execute on function public.authorise_staff_password_change(uuid, uuid) from public, anon, authenticated;
grant execute on function public.authorise_staff_password_change(uuid, uuid) to service_role;

-- The guard. Trigger function: never granted to anyone.
create function public.staff_password_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_auth uuid;
begin
  if not exists (select 1 from public.profiles where id = new.id and user_type = 'staff') then
    return new; -- drivers (PIN rules) and users without a profile are out of scope
  end if;
  select id into v_auth
    from public.staff_password_authorisations
   where user_id = new.id and consumed_at is null and expires_at > now()
   order by created_at desc
   limit 1
   for update skip locked;
  if v_auth is null then
    raise exception 'a staff password can only be changed through the server password policy'
      using errcode = '42501';
  end if;
  update public.staff_password_authorisations set consumed_at = now() where id = v_auth;
  return new;
end $$;
revoke execute on function public.staff_password_guard() from public, anon, authenticated;

create trigger staff_password_guard
  before update of encrypted_password on auth.users
  for each row
  when (old.encrypted_password is distinct from new.encrypted_password)
  execute function public.staff_password_guard();
