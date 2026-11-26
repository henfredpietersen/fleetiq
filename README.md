# FleetIQ

Internal fleet management and operational intelligence platform for a single South African company (50–200 vehicles, multi-branch, multi-shift). Mobile-first driver portal and desktop management app. Built on Next.js (App Router), TypeScript (strict), Tailwind, shadcn/ui and Supabase.

**Status:** Phases 0–4 complete (foundation, registers, shifts and allocations, mobile inspections); Phase 5 (odometer readings and review) in progress. Start with [docs/CONTEXT.md](docs/CONTEXT.md); open the full v1.4 docs in `docs/` only for a specific section. Open decisions: [docs/DECISIONS-STATUS.md](docs/DECISIONS-STATUS.md).

## Setup

Requires Node 22 (`.nvmrc`) and npm.

```bash
nvm use
npm ci
cp .env.example .env.local   # placeholders only; never commit real values
npm run dev
```

The Supabase service-role key must never be `NEXT_PUBLIC_*` or used in user requests or the browser (jobs and reviewed admin functions only). Local Supabase config lives in `supabase/` (`supabase init` only; no cloud project yet). Schema changes are migrations only.

## Scripts

| Script              | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `npm run dev`       | Start the dev server                                       |
| `npm run build`     | Production build                                           |
| `npm run check`     | Typecheck → lint → unit tests; one PASS/FAIL line per step |
| `npm run check:e2e` | Playwright mobile smoke test (line reporter)               |
| `npm run typecheck` | `tsc --noEmit`                                             |
| `npm run lint`      | ESLint (errors only)                                       |
| `npm test`          | Vitest                                                     |
| `npm run format`    | Prettier write (`format:check` to verify)                  |

Locally, if the installed Playwright expects a different browser build than the one on the machine, set `PW_CHROMIUM_PATH` to a Chromium binary, or run `npx playwright install chromium`.

## Branching

`main` is protected by review. Work on short-lived branches (`chore/…`, `feat/…`, `fix/…`), open a PR to `main`; CI (typecheck, lint, unit tests, Playwright) must pass. One roadmap phase (PRD §9) per PR/session.

## Copyright

Copyright © 2026 Henfred Pietersen. All rights reserved. This repository is public for viewing only; no licence is granted to copy, modify, distribute or use it. See [LICENSE](LICENSE).
