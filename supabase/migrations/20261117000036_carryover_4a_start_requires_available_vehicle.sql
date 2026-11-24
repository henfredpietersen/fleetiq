-- 036 — Slice 4A carry-over C1 (DEC-40 amended 2026-11-18): starting an allocation is also refused when the vehicle is no
-- longer available (administrative_status <> 'available', or archived) — the vehicle may have gone into maintenance after the
-- allocation was created. The 3B/3C refusal message for 'vehicle_not_available' already exists (allocation_refusal, 033).
-- One rule, one place: allocation_start_blockers() is used by transition_allocation (the refusal) AND by my_allocations
-- (can_open = no blockers), so my_allocations.can_open follows automatically. Only the filter changes: it now also keeps
-- 'vehicle_not_available' from allocation_eligibility_core(). Same signature, ACL unchanged (CREATE OR REPLACE).
create or replace function public.allocation_start_blockers(p_allocation_id uuid, p_now timestamptz) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  a public.vehicle_allocations;
  st record;
  c record;
  v text[] := '{}';
begin
  select * into a from public.vehicle_allocations x where x.id = p_allocation_id;
  if not found then
    return array['not_found'];
  end if;
  select * into st from public.allocation_settings(a.company_id);
  if a.status <> 'planned' then
    v := array_append(v, 'not_planned');
  end if;
  if not public.allocation_start_window_open(a.planned_start_at, a.planned_end_at, p_now, st.open_before_start_minutes) then
    v := array_append(v, case when p_now >= a.planned_end_at then 'window_closed' else 'too_early' end);
  end if;
  select * into c from public.allocation_eligibility_core(a.company_id, a.shift_id, a.vehicle_id, a.driver_id,
                                                          a.planned_start_at, a.planned_end_at, a.id);
  v := v || array(select r from unnest(c.r_reasons) as r
                   where r in ('shift_not_scheduled', 'vehicle_not_available', 'driver_inactive', 'no_eligible_licence'));
  return v;
end $$;
comment on function public.allocation_start_blockers(uuid, timestamptz) is
  'DEC-40 (amended 2026-11-18): the one start rule. Blockers: not planned; outside the start window; shift not scheduled; vehicle not available (administrative_status <> available, or archived); driver inactive; no eligible licence for the planned period.';
