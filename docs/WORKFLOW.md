# Shared workflow (read before any slice)

Role: principal architect + senior engineer. Correctness, security, auditability over speed.

## Context (token budget matters)
- Read CLAUDE.md and docs/CONTEXT.md only. Open a full doc in /docs only for a specific § and read just that section.
- Approved decisions are rules; Proposed/Open items stay configurable — cite the DEC/AD ID.
- Approved exception (PRD §10, Phases 1–2): build and test on LOCAL/CI Supabase with SYNTHETIC data only. No cloud services, no real names/IDs/plates, no deployments. Data residency (DEC-25): never add a foreign-hosted service.

## Environment
- Local DB: Supabase CLI (`supabase start`). If Docker is unavailable in your environment, say so, write the code anyway and rely on CI.
- CI must have a job that runs `supabase start`, rebuilds the DB from migrations (`supabase db reset`) and runs database tests (`supabase test db`, pgTAP). CI must be green before you report done.

## Rules
- Branch `feat/phase-<phase><slice>-<slug>` from latest main. Short plan first (tables, policies, tests), then build.
- Every schema change is a new migration in supabase/migrations. Never edit a merged migration.
- Service-role key only in server-only modules for jobs/reviewed admin functions (import 'server-only').
- Verify with `npm run check` and the DB tests. Report real results only.
- Open a PR to main, then STOP. Do not merge. Do not start the next slice.

## Final report (brief)
Migrations/files added (grouped), what each test proves, real check + CI results, deviations from the docs (with reason), open questions.

## Carry-over fixes from review (do these first in the slice named, own migration, with tests)
- Done (slice 2B): staff password policy enforced server-side on create, reset and change (minimum 12, configurable via AUTH_STAFF_PASSWORD_MIN_LENGTH with a floor of 12) through `StaffAccounts`. Supabase's global minimum stays 6 only because driver PINs share it; never rely on it for staff. (from PR #3) Also done in 2B: C1 trigger-function EXECUTE revokes (migration 016) and C2 CI pins supabase/setup-cli to 3.2.0 (from PR #5/#6). Closed by migration 017: the database refuses any staff password-hash change without a single-use server authorisation, so direct Auth `updateUser` and recovery links fail for staff.
- Done: PR #2 items 1–3 (fixed in 1B), PR #3 item 5 (fixed in 1C).
- Done (slice 2C, migration 021): driver_register / driver_licences_safe are security_invoker views over SECURITY DEFINER row functions (advisor `security_definer_view`); the admin flag functions re-check the actor's permission; DEC-37 recorded in the database. (from PR #7 and the Supabase advisor)
- Done (slice 3A, migration 026): C1 — `service_import_rows (batch_id, company_id)` FK now has a covering index in FK order (advisor `unindexed_foreign_keys`); the redundant `(company_id, batch_id)` index is replaced by a narrow `(company_id)` one (the old index was also the only cover of the company FK); two uncovered `evidence_file_id` FKs found by the audit are indexed; pgTAP `phase3a_carryover_fk_index` asserts every FK in `public` has a covering index.
- Done (slice 3C, migration 031): C1 — migration 029's comment said maintenance administrators cannot see allocations. Wrong: they can, through `reports.view` (PRD §4.2, DEC-23), and cannot write. 029 is merged and untouched; 031 records the real rule with COMMENT ON TABLE / POLICY, and pgTAP `phase3c_carryover_allocation_visibility` proves read-in-scope and no write. No other doc in the repo repeated the wrong statement.
- Done (slice 3C, migrations 032–035): allocation lifecycle — one transition table, `transition_allocation`, amend, driver `my_allocations`; see the PR description.
- Done (slice 4A, migration 036): C1 — starting an allocation is also refused when the vehicle is no longer available (`administrative_status <> 'available'` or archived): `allocation_start_blockers` keeps `vehicle_not_available`; `my_allocations.can_open` follows (DEC-40 amended 2026-11-18). pgTAP `phase4a_carryover_vehicle_available`.
- Done (slice 4B, migration 040): C1 — DEC-17 amended 2026-11-24: pre-shift lateness is measured from the ALLOCATION's planned start (`submit_inspection` passes `a.planned_start_at`); comments and the TypeScript mirror corrected; pgTAP `phase4b_carryover_late_from_allocation` (29/30/31 and 59/60/61, 10:20 vs 10:31 inside a 06:00–18:00 shift). C2 — the post-shift inspection starts only after the driver confirms (UI only; Playwright covers Cancel and confirm).
