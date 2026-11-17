# Decisions status — Phase 1 blockers

Source: docs/CONTEXT.md; detail in PRD §12 / ARCH §17. Proposed/Open items are not rules; implement them as configuration and cite the ID.

| ID | Decision | Status |
|---|---|---|
| DEC-23 | Permission matrix (PRD §4.2) | Approved 2026-11-17 |
| DEC-25 | Hosting: self-hosted Supabase + Next.js on RSAWEB, South Africa only | Approved 2026-11-17 |
| DEC-34 | Office login: email + password, MFA for admins/approvers | Approved 2026-11-17 |
| AD-01 | Background jobs: Postgres job table + scheduled worker | Approved 2026-11-17 |
| AD-05 | Branch scope source: `user_roles` only | Approved 2026-11-17 |
| DEC-12, 14, 16–18 | Validation thresholds (configurable defaults) | Approved 2026-11-17 |
| DEC-13, DEC-15 | OCR confidence; max km per allocation | Deferred to configuration (no default) |

Approved and fixed: DEC-08, DEC-23, DEC-24, DEC-25, DEC-32, DEC-34, AD-01, AD-05 (see docs/CONTEXT.md).

Phase 1 runs on local/CI Supabase with synthetic data only (approved exception) until RSAWEB servers are provisioned.
