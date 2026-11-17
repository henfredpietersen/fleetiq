-- 025 — Slice 2C: vehicle_service_status (DB §10, AD-04 view; PRD §5.10.2, §5.10.4, §5.10.7; DEC-19, DEC-20; ARCH §8.1, §8.2).
-- Phase 2 exposes ONLY: the last verified service (date, odometer), the resolved config, the next / early-warning /
-- late-tolerance odometers, the due dates where a time interval is configured, and the baseline_required and
-- awaiting_verification flags. NO km / time status bands (DEC-10, Phase 8), NO distance since service and no current
-- mileage: accepted readings arrive in Phase 5-7. Later phases add columns; nothing here pre-empts them.
--
--   next_service_odometer_km   = last verified service odometer + service_interval_km          (never rounded)
--   early_warning_odometer_km  = next - early_tolerance_km
--   late_tolerance_odometer_km = next + late_tolerance_km
--   service_due_date           = last verified service date + service_interval_days             (only if configured)
--   early_warning_date         = due - early_tolerance_days;  late_tolerance_date = due + late_tolerance_days
--   Example: verified at 82,400 km -> 95,900 / 97,400 / 98,900; a late service at 99,500 km -> next target 114,500.
-- Only a VERIFIED record is a baseline (DEC-20, DEC-24): recorded and rejected rows never are. A vehicle without one is
-- baseline_required; awaiting_verification = a `recorded` record exists that is not older than the baseline.
-- The configuration in effect today applies to the current service cycle (PRD §5.10.5), resolved with DEC-19 precedence.
--
-- Security: the view is security_invoker over a SECURITY DEFINER set-returning function with its own row predicate
-- (company + branch access, the same rule as vehicles_select), because the caller's RLS hides raw service_records
-- from most staff (costs, references). No owner-rights view.

create function public.vehicle_service_status_rows()
returns table (
  vehicle_id uuid,
  service_config_id uuid,
  service_config_scope text,
  service_interval_km integer,
  early_tolerance_km integer,
  late_tolerance_km integer,
  service_interval_days integer,
  early_tolerance_days integer,
  late_tolerance_days integer,
  last_verified_service_record_id uuid,
  last_verified_service_date date,
  last_verified_service_odometer_km integer,
  next_service_odometer_km integer,
  early_warning_odometer_km integer,
  late_tolerance_odometer_km integer,
  service_due_date date,
  early_warning_date date,
  late_tolerance_date date,
  baseline_required boolean,
  awaiting_verification boolean)
language sql stable security definer set search_path = '' as $$
  select v.id,
         cfg.id, cfg.scope,
         cfg.service_interval_km, cfg.early_tolerance_km, cfg.late_tolerance_km,
         cfg.service_interval_days, cfg.early_tolerance_days, cfg.late_tolerance_days,
         b.id, b.service_date, b.actual_service_odometer_km,
         b.actual_service_odometer_km + cfg.service_interval_km,
         b.actual_service_odometer_km + cfg.service_interval_km - cfg.early_tolerance_km,
         b.actual_service_odometer_km + cfg.service_interval_km + cfg.late_tolerance_km,
         case when b.id is not null and cfg.service_interval_days is not null then b.service_date + cfg.service_interval_days end,
         case when b.id is not null and cfg.service_interval_days is not null
              then b.service_date + cfg.service_interval_days - cfg.early_tolerance_days end,
         case when b.id is not null and cfg.service_interval_days is not null
              then b.service_date + cfg.service_interval_days + cfg.late_tolerance_days end,
         (b.id is null),
         exists (select 1 from public.service_records r
                  where r.vehicle_id = v.id and r.company_id = v.company_id and r.verification_status = 'recorded'
                    and (b.id is null or r.service_date >= b.service_date))
    from public.vehicles v
    left join lateral public.service_config_lookup(v.id, now()) cfg on true
    left join lateral (
      select r.id, r.service_date, r.actual_service_odometer_km
        from public.service_records r
       where r.vehicle_id = v.id and r.company_id = v.company_id and r.verification_status = 'verified'
       order by r.service_date desc, r.actual_service_odometer_km desc, r.created_at desc
       limit 1) b on true
   where v.company_id = (select public.current_company_id())
     and public.has_branch_access(v.current_branch_id)
$$;
revoke all on function public.vehicle_service_status_rows() from public, anon;
grant execute on function public.vehicle_service_status_rows() to authenticated;

create view public.vehicle_service_status with (security_invoker = true, security_barrier = true) as
  select * from public.vehicle_service_status_rows();
revoke all on public.vehicle_service_status from public, anon, authenticated;
grant select on public.vehicle_service_status to authenticated;
