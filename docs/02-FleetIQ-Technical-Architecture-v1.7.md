# FleetIQ — Technical Architecture

**Version:** 1.7
**Status:** Approved (2026-11-17)
**Product:** Internal fleet-management and operational intelligence platform
**Companion documents:** PRD v1.7 (requirements and Decision Register DEC-xx), Database Design Specification v1.5

---

## 0. Change log

| Version | Date | Summary |
|---|---|---|
| 1.0 | — | Initial architecture. |
| 1.1 | 2026-11 | Odometer evidence, OCR and service monitoring architecture added. |
| 1.2 | 2026-11-12 | Corrected early-warning definition (13,500 km **after** the last verified service, not before the target). Background jobs made an MVP requirement. Added: evidence upload-verify-register flow; capture-source handling and web camera limits; reading state machine and auto-acceptance; unaccounted-distance check; odometer segments; time-based service status and effective status; canonical status catalogue reference; segregation of duties; service-role key rule; evidence access logging; scheduled jobs; capacity estimate; architecture decision register (AD-xx). |
| 1.3 | 2026-11-12 | Applied approved DEC-08 (employee number + PIN; company phone per driver), DEC-24 (segregation of duties), DEC-32. Added driver PIN authentication design (§5.1) and AD-08. |
| 1.3 | 2026-11-17 | **Approved by the user as the architecture baseline.** Document approval does not approve individual items: AD-xx entries marked Proposed or Open remain unapproved until decided individually. |
| 1.4 | 2026-11-17 | Approved: AD-01 (Postgres job table + scheduled worker), AD-05 (`user_roles` is the only branch-scope source), DEC-34 (office login). Validation threshold defaults per PRD v1.4. |
| 1.5 | 2026-11-17 | DEC-23 permission matrix approved (PRD v1.5 §4.2). |
| 1.6 | 2026-11-17 | DEC-25 approved: self-hosted Supabase and Next.js on RSAWEB cloud servers in South Africa (AD-09); Vercel removed. Deployment, backups, secrets and scheduler updated. |
| 1.7 | 2026-11-17 | DEC-19, DEC-20, DEC-31 approved (PRD v1.7). |

---

## 1. Architecture objectives

FleetIQ must use a secure, maintainable architecture capable of supporting approximately 50–200 vehicles, multiple branches and multiple shifts.

The architecture must:
- Preserve data integrity, enforced in the database where possible.
- Support mobile-first inspection workflows on weak connections.
- Protect sensitive operational and personal information.
- Provide a reliable, unbypassable audit trail.
- Support asynchronous image processing, scheduled checks and notifications.
- Allow future integrations without major redesign.
- Avoid unnecessary infrastructure complexity.
- Remain practical for a small development team.

## 2. Recommended architecture

Use a modular monolith for the initial product.

| Layer | Proposed technology |
|---|---|
| Web application | Next.js App Router |
| UI | React |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS |
| Components | shadcn/ui |
| Database | Supabase PostgreSQL, self-hosted (Docker) on RSAWEB (AD-09) |
| Authentication | Supabase Auth |
| File storage | Supabase Storage (private buckets) |
| Server logic | Next.js server-side services, server actions and route handlers |
| Background jobs | **Required for MVP** — see AD-01 |
| Source control | GitHub |
| Unit/integration tests | Vitest |
| End-to-end tests | Playwright |
| Hosting | RSAWEB cloud servers, South African data centres; Next.js (Node) behind a TLS reverse proxy on the same server as self-hosted Supabase; production at `fleetiq.outview.co.za` (DEC-25, AD-09) |

Hosting is approved (DEC-25); servers are not yet provisioned. Confirm the existing repository, deployment and database setup before implementation.

## 3. Logical architecture

Business modules:

1. Identity and access.
2. Organisation and branches.
3. Fleet and vehicles.
4. Drivers.
5. Shifts and allocations.
6. Inspections and damage register.
7. Odometer evidence and mileage.
8. Incidents.
9. Service monitoring.
10. Maintenance and suppliers (later phase).
11. Fuel (later phase).
12. KPIs and reporting.
13. Continuous improvement (later phase).
14. Notifications and approvals.
15. Evidence storage.
16. Integrations.
17. Audit and system administration.

Each module owns its business rules and exposes well-defined services to other modules. Avoid circular dependencies. Shared rules (permission checks, validation settings, status catalogue) live in one place and are reused.

Suggested code structure:

```
src/
  app/                 # Next.js routes (driver portal, management app)
  modules/<module>/
    domain/            # pure business rules (unit-tested, no I/O)
    services/          # use cases, transactions, permission checks
    data/              # queries and repositories
    ui/                # module components
  lib/                 # auth, supabase clients, logging, errors
  jobs/                # background job handlers
supabase/
  migrations/
  tests/               # RLS and constraint tests
```

## 4. Application layers

### Presentation layer
- Driver mobile workflows.
- Supervisor, administration and management screens.
- Forms, tables, filters and reporting views.
- Client-side validation feedback.

The presentation layer is never the security boundary.

### Application/service layer
- Business workflows: allocation lifecycle, inspection submission, reading capture and acceptance, mileage, service status, approvals, notifications.
- Permission and segregation-of-duties checks.
- Transaction orchestration.

Critical rules are enforced on the server and, where possible, also in the database.

### Data access layer
- Queries, transaction boundaries, persistence and access scoping.
- Uses the **user-scoped** Supabase client so Row Level Security applies.

### Integration layer
- OCR/AI providers, email delivery, future GPS/telematics, future fuel imports, external maintenance systems.
- Adapters so providers can be replaced without rewriting business modules.

## 5. Authentication and authorisation

### 5.1 Authentication

**Drivers — employee number + PIN (DEC-08, Approved).**
- Supabase Auth remains the identity provider. Supabase Auth has no native "username + PIN" method, so the proposed design (AD-08) maps each driver to an internal, non-deliverable login identifier derived from company and employee number, with the PIN as the password credential. The driver only ever types their employee number and PIN.
- The sign-in screen calls a server endpoint that resolves the employee number to the internal identifier for the company, then signs in through Supabase Auth. The resolver never reveals whether an employee number exists.
- PIN rules (configurable): proposed 6 digits, no trivial sequences or repeats; Supabase's minimum password length must be set to match.
- Temporary PINs are issued or reset by authorised supervisors/administrators through a service-role admin function (reviewed code path, §5.3). The issuer never sees the PIN afterwards; the driver must change it at first sign-in.
- Brute-force protection: per-account and per-IP rate limiting with temporary lockout after repeated failures (thresholds configurable), plus Supabase's built-in auth rate limits. Lockouts and resets are audited.
- Devices: each driver uses a company-issued phone (DEC-08), so sessions may persist on the device with sensible expiry; shared-device fast switching is not required for MVP. Recording the device per submission is proposed under DEC-35.

**Office and management users (DEC-34, Approved):** email + password, with multi-factor authentication required for administrators and anyone holding approval permissions.

### 5.2 Authorisation model
- Permissions are keys (e.g. `odometer.correction.approve`) granted to roles; roles are granted to users with a scope (company-wide or a specific branch).
- One database helper, `has_permission(permission_key, branch_id)`, is used by both RLS policies and server services.
- The approved matrix is in PRD §4.2 (DEC-23, Approved 2026-11-17), seeded as configuration data.

Every sensitive server-side operation verifies:
1. The user is authenticated.
2. The user has the required permission.
3. The user is authorised for the relevant company and branch.
4. The target record is within the user's permitted scope.
5. The requested state transition is valid.
6. Segregation of duties is respected (the approver is not the submitter or the allocation's driver) (DEC-24, Approved — no override).

### 5.3 Service-role key rule
The Supabase service-role key bypasses Row Level Security. It may be used only by:
- Background job handlers.
- Explicitly reviewed administrative functions (e.g. initial data import).

It must never be used to serve ordinary user requests and must never be exposed to the browser. Code review must check every use.

### 5.4 Row Level Security
- Enabled on every table holding company data.
- Policies enforce company boundary, branch scope, driver-own-record access and sensitive-field restrictions.
- No `DELETE` grant to application users on evidence, readings, inspections, allocations, approvals or audit tables.
- RLS is tested directly with automated tests for each role, including cross-branch and cross-company negative tests.

## 6. Core workflow architecture

### 6.1 Allocation workflow

States: `planned → pre_inspection_pending → in_use → post_inspection_pending → closed | closed_with_exceptions`, plus `cancelled` and `no_show` (PRD §5.5).

1. An authorised user creates an allocation linked to vehicle, driver, branch and shift.
2. The system checks: vehicle administrative status, driver licence eligibility (DEC-22), and conflicting allocations (database exclusion constraint).
3. The driver opens the allocation (`pre_inspection_pending`).
4. Pre-shift inspection submitted → `in_use`.
5. Shift end or driver starts post-shift → `post_inspection_pending`.
6. Post-shift inspection submitted; both readings validated.
7. Accepted readings produce confirmed distance and unaccounted distance.
8. Exceptions are routed for review.
9. The allocation closes when both readings are accepted and no exceptions remain open, or an authorised user closes it as `closed_with_exceptions`.

All transitions are performed by a single service function that validates the transition and writes an `allocation_events` row in the same transaction. The schema supports future handover segments (DEC-02) without losing history.

### 6.2 Inspection workflow

Stages: pre-shift, post-shift.

Each inspection has: unique ID; vehicle, driver, shift and allocation links; stage; template version; start, completion and submission timestamps; responses; evidence references; capture source; submission status; late flag; exception state; completed-by user.

Rules:
- One non-void inspection per allocation and stage (database partial unique index).
- Submission carries a client-generated `client_submission_id`; a retried submission returns the existing result instead of creating a duplicate.
- Inspections are voided with a reason, never deleted.
- Templates are versioned; a template version that has been used is immutable.
- MVP ships seeded templates per vehicle category (DEC-21); a template editor is a later phase.
- The driver sees the vehicle's known-damage register during the inspection.

### 6.3 Evidence upload: upload → verify → register

The client never decides what counts as evidence. Flow:

1. Client requests an upload slot from the server for a specific inspection and purpose. The server checks permission and returns a signed upload URL to a server-chosen private path.
2. Client uploads the image directly to Supabase Storage.
3. Client calls the server to register the upload.
4. The server verifies the object exists at the expected path, checks MIME type and size, computes the SHA-256 hash itself, strips EXIF GPS (DEC-29), records capture source and timestamps, and creates the `evidence_files` row.
5. Only then can the evidence be linked to an inspection, odometer evidence or incident.

Unregistered uploads are cleaned up by a scheduled job after a grace period.

### 6.4 Capture source and web camera limits

- Preferred capture: an in-app camera view using the browser camera stream with an in-app shutter.
- A browser cannot guarantee a live capture: file-input camera hints may fall back to the gallery, and a camera can be pointed at a screen. Capture source is therefore recorded (`in_app_camera`, `gallery`, `file_upload`) and gallery/file sources are flagged (DEC-04).
- Many browsers strip EXIF, so device capture time is often unavailable; it is optional and never trusted.
- Images are captured at a defined resolution (proposed ~1600 px long edge, DEC-07). Once uploaded, the file is immutable.

### 6.5 Odometer evidence and reading workflow

Odometer photographs are the primary operational mileage evidence for the MVP.

1. Driver opens the correct inspection.
2. Driver captures the odometer photo; upload → verify → register (§6.3).
3. An `odometer_evidence` record is created; retakes create new evidence with only one marked current.
4. An OCR job is enqueued. The UI waits a short time (e.g. a few seconds) for a result but never blocks on it.
5. Driver enters the reading. Proposed blind entry: the OCR value is not shown (DEC-05).
6. A candidate `odometer_reading` is created in a single transaction with the inspection submission.
7. The validation engine runs (§7.3) using the current validation settings, and records the settings version.
8. If every auto-acceptance condition holds (§7.2), the reading is accepted by the system. Otherwise an exception is created and the reading awaits review.
9. If OCR finishes after submission, the comparison runs then; a mismatch creates an exception (and moves an auto-accepted reading back to review only through a recorded event, never silently).
10. Authorised review resolves exceptions via the approvals service.
11. Accepted readings feed mileage and service calculations.

The system retains separate values for the OCR-extracted reading, the driver-entered reading and the accepted operational reading. They are never collapsed into a single mutable field.

The MVP manual path (steps 1–3, 5–8 without OCR, and step 10) must work before OCR is integrated, so OCR is an improvement, not a dependency.

### 6.6 Image storage

- Private buckets only. No public URLs.
- Store a storage object reference, not a URL.
- Access via short-lived signed URLs (e.g. minutes) issued by the server after a permission check; every issue is written to `evidence_access_log`.
- Validate file type and size.
- Generate display derivatives (thumbnails) separately; never replace the original.
- Restrict access using the same scope as the underlying record.
- Retention and legal hold per evidence class (DEC-27); deletion only through a controlled, audited process.

### 6.7 Timestamp integrity

Store:
- Device capture timestamp, where available (untrusted).
- Server receipt timestamp (authoritative receipt time).
- OCR processing timestamp.
- Driver submission timestamp.
- Acceptance, review and approval timestamps.

Use server receipt time as the reliable record of receipt. Device time is never treated as proof of when a photo was taken. All timestamps are `timestamptz`; display in Africa/Johannesburg.

### 6.8 OCR and AI processing

OCR runs as a background job.

The job:
- Accepts an evidence file reference.
- Calls the OCR provider through an adapter.
- Stores extracted value, confidence, provider, model/engine and processing metadata in `odometer_ocr_results` (one row per attempt).
- Handles failures and retries with backoff.
- Uses an idempotency key so retries never create duplicate results or evidence.
- Allows controlled reprocessing.

AI/OCR is assistive. It must not:
- Silently change a driver-entered or accepted reading.
- Approve disputed readings.
- Determine driver liability.
- Replace the original photograph.
- Be a required dependency for the manual exception path.

The OCR provider is chosen after a trial on real fleet photos (DEC-26), including where images are processed (POPIA cross-border) and the cost per image.

## 7. Mileage and odometer domain rules

### 7.1 Reading states

| reading_status | Meaning |
|---|---|
| submitted | Driver reading received; validation pending |
| awaiting_review | One or more exceptions; needs a reviewer |
| accepted | Usable for official calculations; immutable |
| rejected | Not usable; reason recorded |
| superseded | Replaced by a correction; kept for history |

Acceptance method: `auto_rule`, `reviewer`, `no_photo_exception` (DEC-03).

### 7.2 Auto-acceptance rule

A reading is accepted automatically only when all are true:
- Evidence capture source is `in_app_camera`.
- OCR succeeded with confidence ≥ configured threshold (DEC-13).
- |driver reading − OCR reading| ≤ configured tolerance (DEC-14; default 0, configurable).
- No validation check failed.

The acceptance records `accepted_by = system`, the method and the validation settings version.

### 7.3 Validation checks

Implemented as pure domain functions with unit tests, driven by `odometer_validation_settings`:
- Decreasing reading vs previous accepted reading for the vehicle.
- Implausible allocation distance (> configured maximum for the vehicle category, DEC-15).
- Unaccounted distance vs previous allocation's accepted post-shift reading (> tolerance, DEC-16).
- OCR low confidence / OCR failure / OCR–driver mismatch.
- Duplicate image hash.
- Gallery or file-upload source.
- Late submission (DEC-17).
- Possible rollover or replacement (large decrease with plausible pattern).
- Missing reading at closure.

An anomaly is an investigation signal, not proof of misconduct.

### 7.4 Distance calculation

`distance_km = accepted_post_shift_reading_km − accepted_pre_shift_reading_km`

`unaccounted_km = accepted_pre_shift_reading_km(this allocation) − accepted_post_shift_reading_km(previous allocation of the same vehicle)`

- Calculated on lifetime kilometres (§7.6).
- Negative results are never stored as confirmed; they raise exceptions.
- Missing or non-accepted readings → mileage status `provisional` or `incomplete`.
- Unaccounted distance is never attributed to a driver automatically.
- Results are stored in `allocation_mileage` with a calculation version and the source reading IDs; a correction creates a new calculation row and marks the previous one superseded.

### 7.5 "Latest accepted reading"

The accepted, non-superseded reading belonging to the vehicle's most recent allocation, ordered by allocation start time then stage (post after pre). Never by highest value or device time. Staleness uses the configured age (DEC-18).

### 7.6 Corrections and odometer segments

- Corrections are append-only: a new reading with `supersedes_reading_id` is created; the old reading becomes `superseded`. An accepted reading's values cannot be updated (database trigger).
- Every correction requires an approval from a user other than the requester.
- Corrections trigger recalculation of affected mileage and service status.
- Odometer replacement, reset or rollover is recorded as an approved `odometer_adjustment`, which opens a new `odometer_segment` with an offset. Calculations use `lifetime_km = displayed_km + segment_offset_km`, so service distance and mileage remain continuous.

## 8. Service monitoring architecture

### 8.1 Configuration

Each vehicle resolves exactly one applicable service configuration at any time.

Fields: service interval km; early tolerance km; late tolerance km; optional interval days; early and late tolerance days; manufacturer or schedule reference; scope (vehicle, manufacturer/model, category, company default); effective dates; created/approved by.

Default configuration:
- Interval: 15,000 km.
- Early tolerance: 1,500 km.
- Late tolerance: 1,500 km.
- Early warning: **13,500 km after the last verified service** (1,500 km before the target).
- Target: 15,000 km after the last verified service.
- Maximum tolerance: 16,500 km after the last verified service.

Precedence (DEC-19, Approved): vehicle → manufacturer/model → category → company default. The configuration in effect now is applied to the last verified baseline. Changes are effective-dated and audited.

### 8.2 Calculation

```
next_service_odometer   = last_verified_service_odometer + service_interval_km
early_warning_odometer  = next_service_odometer - early_tolerance_km
late_tolerance_odometer = next_service_odometer + late_tolerance_km
distance_since_service  = latest_accepted_lifetime_km - last_verified_service_lifetime_km
```

Example — last verified service 82,400 km: early warning 95,900 km; target 97,400 km; maximum tolerance 98,900 km.

Time basis (where configured):
```
due_date            = last_verified_service_date + interval_days
early_warning_date  = due_date - early_tolerance_days
late_tolerance_date = due_date + late_tolerance_days
```

### 8.3 Status engine

Canonical keys (defined once in the Database Design status catalogue; bands per PRD §5.10.3, DEC-10):

- `baseline_required` — no verified service record.
- `normal` — distance < next − early tolerance.
- `approaching` — early warning ≤ distance < target.
- `due` — target ≤ distance ≤ late tolerance limit.
- `overdue` — distance > late tolerance limit.

Flags: `awaiting_verification`, `data_quality_review` (latest reading disputed, provisional or stale).

`effective_status` = the more severe of the kilometre status and the time status.

The engine is a pure domain function with exhaustive boundary tests (exactly 13,500 / 15,000 / 16,500 and one kilometre either side). Results are exposed through the `vehicle_service_status` view.

### 8.4 Verified service completion

- A service record is separate from any booking.
- Fields: vehicle, actual service date, actual service odometer, service type, workshop, work order or job reference, evidence file, cost details (optional in MVP), source (`workshop`, `historical_import`, `manual`), verification status, verifier and timestamp.
- Verification must be by a different user from the creator (DEC-24), enforced in the database.
- Only a verified record updates the baseline. A booking, quotation or driver report never does.
- The service odometer is cross-checked against accepted readings near the service date; inconsistencies raise a data-quality flag.
- Initial baselines are loaded by a reviewed import with source `historical_import` and verified by the maintenance administrator per DEC-20 (Approved): evidence is an invoice, job card or service-book photo; no evidence = Baseline required.

## 9. Notification architecture

- In-app notifications in the MVP; email adapter when a provider is approved (AD-02, DEC-28); future channels via adapters.
- Event-driven. Events are written in the same transaction as the business change and dispatched by the job runner.
- Deduplicated by a deterministic key (e.g. `service:{vehicle}:{cycle_baseline_id}:{status}`), so repeated readings do not repeat alerts.
- Configurable recipients per event type, role and branch, and escalation steps with delays (`notification_rules`).

Events: service approaching, due, overdue; baseline missing; service awaiting verification; odometer exception created; exception awaiting approval (ageing); inspection missing or late; unaccounted distance; incident reported; later: work-order updates.

Store notification status, recipient, delivery attempts, acknowledgement and escalation information.

## 10. Database architecture principles

- PostgreSQL relational model with foreign keys, unique, check and exclusion constraints.
- Composite foreign keys to keep repeated keys consistent (a reading cannot point to vehicle A while its allocation is for vehicle B).
- Transactions for multi-record workflows.
- Append-only audit history written by database triggers on sensitive tables.
- Immutable accepted readings, used template versions, evidence files and audit rows.
- Migrations for every schema change, tested in CI against a local database.
- Idempotency keys on client submissions and jobs.
- `timestamptz` everywhere.
- UUID identifiers.
- No image binaries in tables; private object references only.

Full design: Database Design Specification v1.4.

## 11. Background processing

Background processing is **required for the MVP**.

Jobs:
- OCR processing.
- Scheduled service status evaluation and alert generation (e.g. nightly plus on new accepted reading).
- Missing and late inspection detection (every few minutes during operating hours).
- Notification dispatch and escalation.
- Cleanup of unregistered uploads.
- Later: AI image analysis, report generation, data imports.

Requirements: retry with backoff, failure states, idempotency, processing logs, monitoring, controlled reprocessing. No complex distributed infrastructure for the initial deployment. Mechanism per AD-01 (Approved): a Postgres `background_jobs` table processed by a scheduled worker; on the RSAWEB server, jobs are triggered by `pg_cron` and processed by a Node worker process (systemd/Docker-managed) using the service-role key under §5.3.

## 12. Future integration architecture

### GPS and telematics
Provider adapters for positions, odometer, engine hours, ignition status, geofence events, routes and stops. Telematics must not replace the inspection odometer workflow without an explicit approved business decision; it may later act as a secondary verification source, particularly for unaccounted distance.

### Fuel data
Imports or APIs from fuel-card providers. Imported transactions are staged, validated, matched and approved before entering confirmed reporting.

### AI damage assessment
Store image reference, model/provider, result, confidence, potential damage category, human review decision and final verified finding. AI never determines fault or liability.

## 13. Observability and error handling

- Structured application and job logs with request IDs.
- Error tracking.
- Visibility of failed uploads, failed OCR jobs, failed notifications and stuck allocations.
- Audit records for critical state changes.
- Never log passwords, tokens, licence numbers, unnecessary personal information or image content.

## 14. Testing architecture

### Unit tests (domain functions)
Service interval and status calculations (all boundaries, km and time, effective status); mileage and unaccounted distance; odometer segments; reading validation and auto-acceptance; allocation transitions; segregation-of-duties rules; notification deduplication keys.

### Database tests
Constraints (exclusion, partial unique, composite FKs, immutability triggers); RLS policies per role, including cross-branch and cross-company denials; audit triggers.

### Integration tests
Upload → verify → register; inspection submission with idempotent retry; reading acceptance and exception creation; approvals and corrections with recalculation; service record verification and baseline update; background job retries.

### End-to-end tests (Playwright)
Driver pre-shift and post-shift workflows on a mobile viewport with network throttling; supervisor exception review; fleet admin service configuration; service alert workflow; branch-level data access.

Negative tests for unauthorised access, self-approval and invalid readings are mandatory.

## 15. Deployment and environments

- Separate development, staging and production environments.
- Environments: local (Supabase CLI) and CI with synthetic data; RSAWEB staging; RSAWEB production. Real company data only in production, never in local, CI or staging.
- Secrets: never in source control. On servers, in environment files readable only by the service user; in CI, GitHub Actions encrypted secrets. Rotate on staff change.
- Self-hosted Supabase (Docker Compose) and OS updates applied on a monthly schedule, plus urgent security fixes; staging first.
- Network: only HTTPS (443) public; SSH restricted to named IPs/keys; Supabase Studio and the database port not exposed publicly.
- Migration process: applied by CI to staging, then promoted to production.
- Backups: nightly database dump and storage sync to RSAWEB backup service (stored in South Africa), retention per DEC-27; restore tested monthly on staging.
- Controlled production deployments; monitoring after release.
- Single-branch pilot before full roll-out.
- Hosting and data region approved (DEC-25): all data in South Africa. A POPIA operator agreement is required before go-live (PRD §6).

## 16. Capacity estimate

Indicative, to be validated with pilot data: ~2,400 photos/day at full fleet size. At ~300 KB per app-captured image ≈ 0.26 TB/year; at ~1.5 MB per full camera file ≈ 1.3 TB/year. Database row volumes are small for PostgreSQL; storage cost and retention are the main scaling factors.

## 17. Architecture decision register

| ID | Decision | Proposed option | Status |
|---|---|---|---|
| AD-01 | Background job mechanism | A Postgres-backed job table processed by a scheduled worker (e.g. Supabase scheduled functions / cron), chosen to fit the approved hosting | **Approved** (2026-11-17) |
| AD-02 | Email provider | Choose when email is approved (DEC-28) | Open |
| AD-03 | Perceptual duplicate-image detection | Later phase; exact hash in MVP | Proposed |
| AD-04 | `vehicle_service_status` implementation | Database view; switch to a snapshot table only if performance requires | Proposed |
| AD-05 | Branch-scope source | `user_roles` with nullable `branch_id` is the only scope source; `branch_memberships` removed | **Approved** (2026-11-17) |
| AD-06 | Status columns | `text` + `CHECK` constraints and a documented status catalogue, not Postgres enums | Proposed |
| AD-07 | In-app camera approach | Browser camera stream with in-app shutter; file input fallback flagged | Proposed |
| AD-08 | Driver PIN sign-in implementation | Supabase Auth with internal login identifier per employee number, PIN as password, server-side resolver, rate limiting and lockout | Proposed |
| AD-09 | Production platform | Self-hosted Supabase (Docker Compose) + Next.js on RSAWEB cloud servers in South Africa; separate staging and production; RSAWEB backup service | **Approved** (2026-11-17) |

Business decisions that affect architecture (hosting, OCR provider, retention, gallery policy, permissions) are tracked in the PRD Decision Register.

## 18. Architecture acceptance criteria

The architecture is acceptable when:
- Business modules have clear boundaries.
- Sensitive actions are authorised server-side and in RLS, with segregation of duties.
- The service-role key is confined to jobs and reviewed admin functions.
- Branch-level access is enforced and tested.
- Original inspection evidence is stored privately, verified on registration and access-logged.
- OCR processing is asynchronous, traceable and optional for the manual path.
- Readings are validated before use; acceptance follows the documented rule.
- Mileage and unaccounted distance use accepted readings only.
- Service monitoring uses verified baselines and evaluates both km and time.
- Corrections are append-only and trigger recalculation.
- Background processing is retry-safe and idempotent.
- Critical workflows have automated tests.
- Future integrations can be added without rewriting the core application.
