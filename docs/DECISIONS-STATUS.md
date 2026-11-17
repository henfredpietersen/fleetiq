# Decisions status — Phase 1 blockers

Source: docs/CONTEXT.md ("Phase 1 blockers"); detail in PRD §12 / ARCH §17. Proposed/Open items are not rules; implement them as configuration and cite the ID.

| ID           | Decision                                          | Proposed default (not binding)                 | Status                |
| ------------ | ------------------------------------------------- | ---------------------------------------------- | --------------------- |
| DEC-23       | Permission matrix (PRD §4.2)                      | —                                              | Pending — owner: user |
| DEC-25       | Hosting / Supabase project / data region          | Vercel + Supabase (region unconfirmed)         | Pending — owner: user |
| DEC-34       | Office login method                               | Email + password; MFA for admins/approvers     | Pending — owner: user |
| AD-01        | Background job mechanism                          | Postgres job table + scheduled worker          | Pending — owner: user |
| AD-05        | Authorisation scope source                        | `user_roles` only                              | Pending — owner: user |
| DEC-12–18    | Validation thresholds (odometer/OCR checks)       | — (keep configurable)                          | Pending — owner: user |

Approved and fixed: DEC-08, DEC-24, DEC-32 (see docs/CONTEXT.md).
