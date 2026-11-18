-- 031 — Slice 3C carry-over C1 (from the 3B review): the real read rule for allocations, written into the database.
-- Migration 029 carries a comment saying maintenance administrators cannot see allocations. That is wrong. They can, through
-- reports.view, exactly as the approved permission matrix says (DEC-23; PRD §4.2: reports.view = All for the maintenance
-- administrator and senior management). 029 is merged and is NOT edited; the policies' behaviour was always correct
-- (va_select already tests reports.view). This migration only records the real rule with COMMENT ON, where a reviewer
-- of the database will look for it. No behaviour changes.

comment on table public.vehicle_allocations is
  'One row per vehicle-to-driver-to-shift allocation. READ (RLS, va_select): a holder of allocation.manage OR reports.view for the '
  'allocation''s branch (a company-wide grant covers every branch), and the allocation''s own driver. Per the approved permission '
  'matrix (DEC-23) that means: supervisor and branch manager (own branch), fleet administrator, maintenance administrator and senior '
  'management (company-wide, through reports.view). The system administrator has no allocation access. WRITE: nobody directly: '
  'no INSERT/UPDATE/DELETE grant exists for any client role; rows change only through the SECURITY DEFINER functions '
  '(request_allocation, transition_allocation, amend_allocation_times, ...), which check allocation.manage (or the driver''s own '
  'identity for starting) themselves. A maintenance administrator or senior manager reading through reports.view can never write.';

comment on policy va_select on public.vehicle_allocations is
  'Read = allocation.manage OR reports.view for the allocation''s branch, OR the allocation''s own driver (driver_is_self). '
  'Maintenance administrators and senior management therefore CAN read allocations (reports.view, DEC-23), in their branch scope; '
  'they cannot write. System administrators and other companies see nothing. (Corrects the comment in migration 029.)';

comment on policy allocation_events_select on public.allocation_events is
  'An event is readable exactly when its allocation is readable under va_select: allocation.manage or reports.view for the '
  'allocation''s branch (so maintenance administrators and senior management read history through reports.view, DEC-23), or the '
  'allocation''s own driver. No client can write events; they are appended by the SECURITY DEFINER functions only.';
