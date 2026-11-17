# FleetIQ — Claude Code rules

Detail for every rule lives in docs/CONTEXT.md (digest). Full docs: PRD, ARCH, DB in /docs (v1.3, read-only).

## A. Rules

- Docs-first: read docs/CONTEXT.md; cite DEC/AD IDs; Proposed/Open items are configurable, not rules.
- Current roadmap phase only; never build ahead (CONTEXT.md "Roadmap").
- Authorise on the server AND in RLS via one `has_permission(key, branch_id)`; UI is never the boundary.
- Service-role key: jobs and reviewed admin functions only; never `NEXT_PUBLIC_`, never in user requests/browser.
- Every schema change is a migration in supabase/migrations; no manual DB edits.
- No hard deletes of evidence/history; void or supersede; audit via DB triggers.
- OCR, driver and accepted odometer readings are three separate values, never one editable field.
- Verified baselines only: a service baseline needs a verified record (verifier ≠ creator); never invent one.
- DEC-24 segregation of duties: nobody approves, verifies or corrects their own record; no self-granted roles.
- Idempotency: `client_submission_id` for submissions, `idempotency_key` for jobs.
- Write negative and permission tests, plus loading/empty/error/success states; no fake data.
- Never claim untested work is done; report real check output only.

## B. Working efficiently

- Read docs/CONTEXT.md, not the full docs; open one § of a full doc only when needed.
- grep/glob before opening files; read only the line ranges you need.
- Never read node_modules, lockfiles, build output, coverage or reports (also denied in .claude/settings.json).
- Verify with `npm run check` (and `npm run check:e2e` for UI flows), not raw tool output.
- Install a dependency only when the task requires it.
- Keep replies short: changed files + check result, no code recaps.
- One roadmap phase per session, then start a fresh session.
