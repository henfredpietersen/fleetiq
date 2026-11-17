# Phase 1 — shared workflow (read before any Phase 1 slice)

Role: principal architect + senior engineer. Correctness, security, auditability over speed.

## Context (token budget matters)
- Read CLAUDE.md and docs/CONTEXT.md only. Open a full doc in /docs only for a specific § and read just that section.
- Approved decisions are rules; Proposed/Open items stay configurable — cite the DEC/AD ID.
- Approved exception (PRD §10): build and test on LOCAL/CI Supabase with SYNTHETIC data only. No cloud services, no real names/IDs/plates, no deployments. Data residency (DEC-25): never add a foreign-hosted service.

## Environment
- Local DB: Supabase CLI (`supabase start`). If Docker is unavailable in your environment, say so, write the code anyway and rely on CI.
- CI must have a job that runs `supabase start`, rebuilds the DB from migrations (`supabase db reset`) and runs database tests (`supabase test db`, pgTAP). CI must be green before you report done.

## Rules
- Branch `feat/phase-1<slice>-<slug>` from latest main. Short plan first (tables, policies, tests), then build.
- Every schema change is a new migration in supabase/migrations. Never edit a merged migration.
- Service-role key only in server-only modules for jobs/reviewed admin functions (import 'server-only').
- Verify with `npm run check` and the DB tests. Report real results only.
- Open a PR to main, then STOP. Do not merge. Do not start the next slice.

## Final report (brief)
Migrations/files added (grouped), what each test proves, real check + CI results, deviations from the docs (with reason), open questions.

## Carry-over fixes from review (do these first in your slice, own migration, with tests)
- From PR #2 (1A), fix in slice 1B:
  1. `user_roles` update policy: a manager may only END a grant (set `effective_to` to a time ≤ now() and never later than an existing `effective_to`). Re-activating or extending an ended grant must require a new grant row. Add pgTAP tests for both.
  2. `audit_row_change()`: `current_user` inside SECURITY DEFINER is always the owner, so `metadata.db_role` is meaningless. Record `session_user` (or drop the field).
