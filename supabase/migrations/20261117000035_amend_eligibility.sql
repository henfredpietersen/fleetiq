-- 035 — Slice 3C: amend_eligibility(): the dry run behind the "Amend times" dialog (shows problems BEFORE submitting).
-- Same rules, same helpers as amend_allocation_times (033): window/order (22023), then licence for the new period and the
-- vehicle/driver overlap check excluding this allocation. Read-only; allocation.manage for the allocation's branch.
create function public.amend_eligibility(p_allocation_id uuid, p_planned_start_at timestamptz, p_planned_end_at timestamptz)
returns table (ok boolean, block_reasons text[])
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company_id();
  a public.vehicle_allocations;
  c record;
  v text[];
begin
  if auth.uid() is null or v_company is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into a from public.vehicle_allocations x where x.id = p_allocation_id and x.company_id = v_company;
  if not found then
    perform public.allocation_fail('P0002', 'that allocation was not found, or it is not in a branch you can access');
  end if;
  if not public.has_permission('allocation.manage', a.branch_id) then
    perform public.allocation_fail('42501', 'only a manager of this branch can change the planned times of an allocation');
  end if;
  select * into c from public.allocation_eligibility_core(a.company_id, a.shift_id, a.vehicle_id, a.driver_id,
                                                          p_planned_start_at, p_planned_end_at, a.id);
  v := array(select r from unnest(c.r_reasons) as r
              where r in ('shift_not_scheduled', 'no_eligible_licence', 'vehicle_conflict', 'driver_conflict'));
  if a.status not in ('planned', 'pre_inspection_pending') then
    v := array_prepend('status_not_amendable', v);
  end if;
  ok := cardinality(v) = 0;
  block_reasons := v;
  return next;
end $$;
revoke all on function public.amend_eligibility(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.amend_eligibility(uuid, timestamptz, timestamptz) to authenticated;
