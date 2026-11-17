Migrations only: every schema change is a new, reviewed migration file here — never edit the database manually.

## Phase 1A (database foundation)

1. `…01_org_access_tables` — companies, branches, departments, profiles, roles, permissions, role_permissions, user_roles, audit_logs.
2. `…02_authz_functions` — `current_company_id()`, `has_permission(key, branch_id)`.
3. `…03_audit_triggers` — generic audit trigger; `audit_logs` append-only.
4. `…04_rls` — RLS deny-by-default, grants.
5. `…05_seed_roles_permissions` — 7 roles + DEC-23 matrix (PRD §4.2) as data.

Tests: `supabase/tests/database/*.test.sql` (pgTAP, `supabase test db`). Types: `npm run db:types`.
