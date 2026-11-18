-- 034 — Slice 3C (3/3): the driver's read path, my_allocations(p_from, p_to) (PRD v1.13 §4.2, §4.3, §5.5; DEC-08, DEC-40).
-- Drivers get no direct access to shifts, vehicles or branches (RLS). This SECURITY DEFINER rows function returns ONLY the
-- caller's own allocations (drivers.profile_id = auth.uid(), same company, access cleared) that overlap the range, joined with
-- exactly what the card needs. No licence numbers, nothing about other drivers. The range is at most 14 days.
-- can_open uses the SAME rule as the start transition: allocation_start_blockers() (033) with the same settings.

create function public.my_allocations(p_from timestamptz, p_to timestamptz)
returns table (
  allocation_id uuid, status text, planned_start_at timestamptz, planned_end_at timestamptz,
  shift_date date, shift_start_at timestamptz, shift_end_at timestamptz,
  vehicle_fleet_number text, vehicle_registration text, vehicle_make text, vehicle_model text,
  branch_name text, licence_class_check text, can_open boolean, opened_on_behalf boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.current_company_id();
begin
  if v_uid is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from then
    perform public.allocation_fail('22023', 'the end of the range must be after its start');
  end if;
  if p_to - p_from > interval '14 days' then
    perform public.allocation_fail('22023', 'the range can be at most 14 days');
  end if;
  if not public.access_cleared(v_uid) then
    return;
  end if;
  return query
  select a.id, a.status, a.planned_start_at, a.planned_end_at,
         s.shift_date, s.scheduled_start_at, s.scheduled_end_at,
         v.fleet_number::text, v.registration_number::text, v.make::text, v.model::text,
         b.name::text, a.licence_class_check,
         (a.status = 'planned' and cardinality(public.allocation_start_blockers(a.id, now())) = 0),
         a.opened_on_behalf
    from public.vehicle_allocations a
    join public.drivers d on d.id = a.driver_id and d.company_id = a.company_id
    join public.shifts s on s.id = a.shift_id and s.company_id = a.company_id
    join public.vehicles v on v.id = a.vehicle_id and v.company_id = a.company_id
    join public.branches b on b.id = a.branch_id and b.company_id = a.company_id
   where d.profile_id = v_uid and a.company_id = v_company
     and a.planned_start_at < p_to and a.planned_end_at > p_from
   order by a.planned_start_at, a.id;
end $$;

revoke all on function public.my_allocations(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.my_allocations(timestamptz, timestamptz) to authenticated;
