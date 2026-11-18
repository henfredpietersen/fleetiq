-- 028 — Slice 3B (1/3): licence codes (PRD v1.12 §5.4 "Eligibility at allocation"; DB v1.7 §4; DEC-22 class rule,
-- amended 2026-11-18; DEC-23). Class follows regulation 99 of the National Road Traffic Regulations, 2000.
--   * vehicles.required_licence_code      NULL = not configured. Written ONLY through
--                                         set_vehicle_required_licence_code() (vehicle.manage, company-wide, audited
--                                         with a reason). It is not in the 015 column grant and a trigger refuses it
--                                         for client roles as a second line.
--   * driver_licences.licence_code        now one of the eight codes. The migration FAILS (it never rewrites data) if a
--                                         row holds anything else.
--   * licence_code_coverage(held, req)    the one place the coverage table lives (IMMUTABLE SQL).

-- ---------------------------------------------------------------- driver_licences.licence_code: fail loudly, never rewrite
do $$
declare n integer;
begin
  select count(*) into n from public.driver_licences
   where licence_code is null or licence_code not in ('A1', 'A', 'B', 'C1', 'C', 'EB', 'EC1', 'EC');
  if n > 0 then
    raise exception 'migration 028 refused: % driver_licences row(s) hold a licence_code outside A1, A, B, C1, C, EB, EC1, EC; correct them deliberately (new verified record, old one rejected) before re-running', n
      using errcode = '23514';
  end if;
end $$;
alter table public.driver_licences
  add constraint driver_licences_code_valid check (licence_code in ('A1', 'A', 'B', 'C1', 'C', 'EB', 'EC1', 'EC'));

-- ---------------------------------------------------------------- the coverage table (one place)
-- A code always covers itself, plus:
--   required A1 <- A | A <- none | B <- C1, C, EB, EC1, EC | C1 <- C, EC1, EC | C <- EC | EB <- EC1, EC | EC1 <- EC | EC <- none
-- Unknown or null codes cover nothing (false, never an error): the caller decides what "no code" means.
create function public.licence_code_coverage(p_held text, p_required text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_held is null or p_required is null then false
    when p_required not in ('A1', 'A', 'B', 'C1', 'C', 'EB', 'EC1', 'EC') then false
    when p_held = p_required then true
    else case p_required
           when 'A1'  then p_held = 'A'
           when 'B'   then p_held in ('C1', 'C', 'EB', 'EC1', 'EC')
           when 'C1'  then p_held in ('C', 'EC1', 'EC')
           when 'C'   then p_held = 'EC'
           when 'EB'  then p_held in ('EC1', 'EC')
           when 'EC1' then p_held = 'EC'
           else false
         end
  end
$$;
revoke all on function public.licence_code_coverage(text, text) from public, anon;
grant execute on function public.licence_code_coverage(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------- vehicles.required_licence_code
alter table public.vehicles
  add column required_licence_code text
  constraint vehicles_required_licence_code_valid check (required_licence_code in ('A1', 'A', 'B', 'C1', 'C', 'EB', 'EC1', 'EC'));
-- Not added to the UPDATE column grant from 015: no client role can write it directly. Second line of defence:
create function public.vehicles_licence_code_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon')
     and new.required_licence_code is distinct from old.required_licence_code then
    raise exception 'required_licence_code can only be changed through set_vehicle_required_licence_code()' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger vehicles_licence_code_guard_t before update on public.vehicles for each row
  execute function public.vehicles_licence_code_guard();
revoke execute on function public.vehicles_licence_code_guard() from public, anon, authenticated;

-- Company-wide vehicle.manage (the code is a property of the vehicle, not of a branch). p_code NULL clears it
-- ("not configured"). A reason is always required; it lands in the audit row. Existing allocations keep the
-- licence_class_check they were created with.
create function public.set_vehicle_required_licence_code(p_vehicle_id uuid, p_code text, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
  v public.vehicles;
  v_reason text := btrim(p_reason);
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.has_permission('vehicle.manage', null) then
    raise exception 'missing company-wide permission vehicle.manage' using errcode = '42501';
  end if;
  if p_code is not null and p_code not in ('A1', 'A', 'B', 'C1', 'C', 'EB', 'EC1', 'EC') then
    raise exception 'the required licence code must be one of A1, A, B, C1, C, EB, EC1, EC' using errcode = '22023';
  end if;
  if v_reason is null or length(v_reason) not between 1 and 500 then
    raise exception 'a reason (1-500 characters) is required' using errcode = '22023';
  end if;
  select * into v from public.vehicles where id = p_vehicle_id and company_id = v_company for update;
  if not found then
    raise exception 'vehicle not found' using errcode = 'P0002';
  end if;
  if v.archived_at is not null then
    raise exception 'an archived vehicle cannot be edited; un-archive it first' using errcode = '55000';
  end if;
  perform set_config('app.audit_reason', 'required licence code: ' || v_reason, true);
  update public.vehicles set required_licence_code = p_code where id = v.id;
  perform set_config('app.audit_reason', '', true);
end $$;
revoke all on function public.set_vehicle_required_licence_code(uuid, text, text) from public, anon;
grant execute on function public.set_vehicle_required_licence_code(uuid, text, text) to authenticated;
