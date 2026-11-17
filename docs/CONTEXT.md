# FleetIQ — Working Context (digest)

Read this first. Open the full docs only for the section you need (cite § numbers):
PRD = docs/01-FleetIQ-PRD-v1.4.md · ARCH = docs/02-FleetIQ-Technical-Architecture-v1.4.md · DB = docs/03-FleetIQ-Database-Design-v1.4.md.
All three: v1.4, Approved 2026-11-17. If this digest and a full doc disagree, the full doc wins.

## Product
Internal (not SaaS) fleet platform, one SA company, 50–200 vehicles, multi-branch, multi-shift (incl. across midnight), TZ Africa/Johannesburg. Mobile-first driver portal (mid-range phones, weak signal), desktop management app.

## Stack
Next.js App Router · React · TypeScript strict · Tailwind · shadcn/ui · Supabase Postgres/Auth/private Storage · Vitest · Playwright · GitHub Actions · Vercel (pending DEC-25). Modular monolith: `src/modules/<module>/{domain,services,data,ui}`, `src/lib`, `src/jobs`, `supabase/migrations`, `supabase/tests` (ARCH §3).

## Approved decisions (only these are fixed rules)
- DEC-08: drivers sign in with employee number + PIN; one company phone per driver.
- DEC-24: segregation of duties, no override — nobody approves/verifies/corrects their own record; supervisor can't approve on an allocation where they are the driver; service record verifier ≠ creator; no self-granted roles.
- DEC-32: "Operations manager" = Branch manager.
- DEC-34: office/management users sign in with email + password; MFA required for administrators and anyone with approval permissions.
- AD-01: background jobs = Postgres `background_jobs` table + scheduled worker (scheduler chosen to fit hosting, DEC-25).
- AD-05: `user_roles` (branch_id nullable = company-wide) is the only branch-scope source.
- DEC-12/14/16/17/18 (configurable defaults in `odometer_validation_settings`): whole km; OCR–driver tolerance 0 km; unaccounted tolerance 5 km; late pre-shift +30 min, post-shift +60 min; stale after 7 days. DEC-13 (OCR confidence) and DEC-15 (max km/allocation) have no default: while unset, no auto-acceptance and the implausible check reports `not_configured`.
Everything else in PRD §12 / ARCH §17 is Proposed/Open → configurable, cite the ID.

## Phase 1 blockers (pending)
DEC-23 permission matrix (PRD §4.2) · DEC-25 hosting/Supabase/data region (company IT). Also open before go-live: POPIA position, business inputs (PRD §10).

## Roadmap (PRD §9)
0 Setup → 1 Foundation (auth, org/branches, roles/permissions, RLS, audit triggers, private evidence storage) → 2 Registers → 3 Shifts & allocations → 4 Inspections (mobile) → 5 Odometer manual path → 6 OCR → 7 Mileage → 8 Service monitoring & alerts → 9 Incidents, dashboard, reports → 10 Pilot. Never build ahead of the current phase.

## Non-negotiable rules
- Authorisation on the server AND in RLS; UI is never the security boundary. One helper `has_permission(key, branch_id)` for RLS and services.
- Service-role key: background jobs and reviewed admin functions only; never in user requests or the browser.
- Every schema change is a migration. text + CHECK statuses (catalogue DB §20). UUID PKs, timestamptz, integer km.
- No hard deletes of evidence/history; void or supersede. Accepted readings, evidence files, used template versions and audit rows are immutable. Audit via DB triggers.
- Idempotent submissions (`client_submission_id`) and jobs (`idempotency_key`).
- Loading/empty/error/success states; negative + permission tests; never claim untested work is done; no fake data.

## Odometer (PRD §5.8–5.9, ARCH §6.5, §7)
- Pre- and post-shift inspection per allocation, each with a mandatory odometer photo (in-app camera preferred; gallery/file flagged per DEC-04). No-photo path only via approved, permanently labelled exception (DEC-03).
- Three separate values, never one editable field: OCR reading · driver reading · accepted reading.
- Upload → server verify (type, size, SHA-256, strip EXIF GPS) → register `evidence_files`.
- Auto-accept only if: in-app capture AND OCR ≥ threshold AND driver = OCR within tolerance AND all checks pass. Else exception → review.
- Checks: decreasing, implausible distance, unaccounted distance vs previous allocation, OCR low/failed/mismatch, duplicate hash, gallery source, late, rollover/replacement, missing.
- Corrections create a superseding reading (approved by someone else) and trigger recalculation. Odometer replacement/rollover → approved adjustment → new segment; lifetime_km = displayed + offset.
- Distance = accepted post − accepted pre. Unaccounted = this pre − previous allocation's post. Missing/non-accepted → provisional/incomplete, never estimated. Never auto-attributed to a driver.
- "Latest accepted reading" = by allocation chronology (start time, then post after pre), not highest value or device time.
- OCR/AI is assistive only; manual path must work without it; AI never decides liability.

## Service monitoring (PRD §5.10, ARCH §8)
Default 15,000 km interval, ±1,500 km tolerance. next = last VERIFIED service odometer + interval (never rounded). Bands: <13,500 normal · 13,500–14,999 approaching · 15,000–16,500 due · >16,500 overdue · no verified record = baseline_required. Optional time basis; effective status = more severe of km and time. Only a verified service record (verifier ≠ creator) sets the baseline; never invent one. Config precedence (proposed DEC-19): vehicle → make/model → category → company default.

## Allocation lifecycle (PRD §5.5)
planned → pre_inspection_pending → in_use → post_inspection_pending → closed | closed_with_exceptions; plus cancelled, no_show. No overlapping active allocations per vehicle (DB exclusion constraint). One non-void inspection per allocation + stage.

## Privacy (POPIA)
Minimise personal data; restricted licence data; private evidence with short-lived signed URLs, every access logged; no invented retention periods (DEC-27).
