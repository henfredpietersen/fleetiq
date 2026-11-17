Migrations only: every schema change is a new, reviewed migration file here — never edit the database manually.

## Phase 1A (database foundation)

1. `…01_org_access_tables` — companies, branches, departments, profiles, roles, permissions, role_permissions, user_roles, audit_logs.
2. `…02_authz_functions` — `current_company_id()`, `has_permission(key, branch_id)`.
3. `…03_audit_triggers` — generic audit trigger; `audit_logs` append-only.
4. `…04_rls` — RLS deny-by-default, grants.
5. `…05_seed_roles_permissions` — 7 roles + DEC-23 matrix (PRD §4.2) as data.

Tests: `supabase/tests/database/*.test.sql` (pgTAP, `supabase test db`). Types: `npm run db:types`.

## Phase 1B

6. `…06_carryover_1a_review_fixes` — end-only role grants, `audit_row_change()` fixes.
7. `…07_auth_signin` — MFA/PIN gating inside `has_permission()`, `auth_login_attempts`, sign-in functions.

## Phase 1C (private evidence storage)

8. `…08_carryover_1b_review_fixes` — a manager may cancel a future-dated grant (zero-length, never deleted).
9. `…09_background_jobs` — AD-01 job table + enqueue/claim/complete/fail (service role only).
10. `…10_evidence_storage` — `evidence_upload_slots`, `evidence_files` (insert-only), `evidence_access_log` (append-only), RLS, request/register/issue-access/cleanup functions.
11. `…11_evidence_bucket` — private `evidence` bucket (size + MIME backstop) and storage policies tied to the evidence tables.

## Phase 2A (vehicle register)

12. `…12_evidence_read_requires_logged_grant`, 13. `…13_perf_tidyup` — see their headers (FK covering indexes, RLS initplan wrapping).
14. `…14_approvals` — generic `approvals` (DB §17), `decide_approval()` / `cancel_approval()`, DEC-24 CHECK + transition guard, RLS (requester or approver in scope), no client writes.
15. `…15_vehicles` — `vehicles`, `vehicle_branch_assignments` (btree_gist exclusion), `vehicle_documents`, `create_vehicle()`, `request_vehicle_transfer()`, internal `apply_branch_transfer()`, RLS, caches protected, no deletes, audit triggers.
16. `…16_carryover_2b_trigger_function_privileges` — REVOKE EXECUTE on the SECURITY DEFINER trigger functions `vba_guard`, `vba_sync_cache`, `vehicle_documents_validate` (carry-over C1).
17. `…17_staff_password_change_guard` — `staff_password_authorisations` (service-only, audited), `authorise_staff_password_change()` and trigger `staff_password_guard` on `auth.users`: a staff password hash changes only with a single-use server authorisation (closes the C3 bypass).

`supabase/seed.sql` loads synthetic data only (1 company, 2 branches, 10 vehicles `TESTnnn-GP`) on `supabase db reset`.

Manual job run (no scheduler yet): `npm run job:evidence-cleanup` (needs the server-side env, see `.env.example`).
