# FleetIQ — Database Design Specification

**Version:** 1.4
**Status:** Approved (2026-11-17)
**Database:** PostgreSQL / Supabase PostgreSQL
**Companion documents:** PRD v1.4 (requirements, Decision Register DEC-xx), Technical Architecture v1.4 (AD-xx)

---

## 0. Change log

| Version | Date | Summary |
|---|---|---|
| 1.0 | — | Initial logical design. |
| 1.1 | 2026-11 | Odometer evidence, readings, exceptions, adjustments, mileage, service configuration, service status and alerts added. |
| 1.2 | 2026-11-12 | Added `evidence_files`, `evidence_access_log`, `vehicle_branch_assignments`, `odometer_validation_settings`, `odometer_segments`, `vehicle_damage_items`, `background_jobs`, `notification_rules`. Single branch-scope source (`branch_memberships` removed). Licence data only in `driver_licences`. Immutable accepted readings with `supersedes_reading_id`. `reading_stage` renamed `inspection_stage`. Composite FKs for repeated keys. `branch_id` added to branch-scoped tables. Exclusion constraint for allocations. Partial unique indexes for inspections and accepted readings. Idempotency columns. New exception types. Time tolerances on service configs. `allocation_mileage` made required, with unaccounted distance. Status catalogue. `maintenance_schedules` scoped to non-primary maintenance. |
| 1.3 | 2026-11-12 | Applied approved DEC-08: `drivers.profile_id` required; driver sign-in fields on `profiles`; added `auth_login_attempts`. Added proposed `company_devices` and `evidence_files.device_id` (DEC-35). Segregation of duties (DEC-24) marked approved. |
| 1.3 | 2026-11-17 | **Approved by the user as the logical database baseline.** Items marked Proposed, Open, Pending or [DEC-xx] remain configurable/nullable until their decisions are approved individually. |
| 1.4 | 2026-11-17 | AD-01, AD-05 and DEC-34 approved. `profiles.email` required for staff users. Default values documented for `odometer_validation_settings` (DEC-12, 14, 16–18); DEC-13 and DEC-15 have no default until set. |

**Notation.** **[MVP]** = required for the MVP. **[Later]** = planned phase; the table may be created later. Items marked **[DEC-xx]** depend on a pending decision and must be configurable or nullable until approved.

---

## 1. Database design objectives

The FleetIQ database must provide a reliable, auditable source of truth for:
- Organisations, branches and departments.
- Users, roles and permissions.
- Vehicles and drivers.
- Shifts and allocations.
- Inspections, evidence and the damage register.
- Odometer readings and mileage.
- Service configurations, service records and service status.
- Incidents.
- Fuel and maintenance (later).
- KPIs and analytics.
- Approvals, notifications, jobs and audit events.

The design supports approximately 50–200 vehicles initially and allows future expansion, including additional companies.

## 2. General database principles

1. UUID primary keys (`gen_random_uuid()`), unless a documented reason requires otherwise.
2. Foreign keys for every relationship; composite foreign keys where a child repeats its parent's keys (§2.1).
3. Unique, check and exclusion constraints for critical rules.
4. `timestamptz` for all timestamps; local display in Africa/Johannesburg.
5. Money as `numeric(14,2)`; currency ZAR unless stated.
6. Odometer values as `integer` whole kilometres (DEC-12), `CHECK (>= 0)`.
7. Status columns as `text` + `CHECK`, values from the status catalogue (§20) (AD-06).
8. Every operational table has `company_id`; branch-scoped tables have `branch_id`.
9. `created_at` default `now()`; `updated_at` maintained by trigger where rows are mutable.
10. Migrations for every schema change.
11. No hard deletes of evidence or important history; void or archive instead.
12. Original evidence, accepted readings, used template versions and audit rows are immutable (enforced by triggers and grants).
13. Row Level Security on every table holding company data.
14. Transactions for operations that change related records.
15. Idempotency via `client_submission_id` (client submissions) and `idempotency_key` (jobs).

### 2.1 Consistency of repeated keys

Where a child row repeats `vehicle_id`, `driver_id`, `shift_id`, `branch_id` of its allocation, consistency is enforced with a composite FK, e.g.:

- `vehicle_allocations` has `UNIQUE (id, vehicle_id, driver_id, shift_id, branch_id)`.
- `inspections` has `FOREIGN KEY (allocation_id, vehicle_id, driver_id, shift_id, branch_id) REFERENCES vehicle_allocations (id, vehicle_id, driver_id, shift_id, branch_id)`.
- `inspections` has `UNIQUE (id, allocation_id, inspection_stage)`; `odometer_evidence` and `odometer_readings` reference `(inspection_id, allocation_id, inspection_stage)`.

This prevents a reading pointing to vehicle A while its allocation is for vehicle B.

## 3. Organisation and access entities [MVP]

### companies
- id
- name
- legal_name
- registration_number
- status
- created_at, updated_at

### branches
- id
- company_id
- name
- branch_code — unique per company
- address
- status
- created_at, updated_at

### departments
- id
- company_id
- branch_id, nullable
- name
- status

### profiles
One row per authenticated user.
- id — equals the Supabase auth user id
- company_id
- display_name
- email, nullable — required when `user_type = staff` (DEC-34, Approved: email + password, MFA for administrators and approvers); `CHECK (user_type <> 'staff' OR email IS NOT NULL)`
- phone, nullable
- user_type — `driver`, `staff`
- login_identifier — internal, non-deliverable identifier used for driver PIN sign-in (AD-08); `UNIQUE`
- must_change_pin — boolean, true after issue or reset
- locked_until, nullable
- status
- created_at, updated_at

`employee_number` is held on `drivers` (and on a staff record later), not duplicated here.

### roles
- id
- company_id, nullable for system-defined roles
- name
- description

### permissions
- id
- permission_key — unique (e.g. `odometer.correction.approve`)
- description

### role_permissions
- role_id
- permission_id
- PK (role_id, permission_id)

### user_roles
**The single source of access scope (AD-05, Approved).**
- id
- user_id → profiles
- role_id → roles
- company_id
- branch_id, nullable — null means company-wide
- effective_from
- effective_to, nullable
- granted_by
- created_at

Constraint: `granted_by <> user_id` (no self-grant).

`branch_memberships` from v1.1 is removed.

### auth_login_attempts
Supports rate limiting and lockout for PIN sign-in (AD-08). Append-only.
- id
- company_id, nullable
- employee_number_attempted — stored hashed
- profile_id, nullable
- ip_hash
- succeeded — boolean
- occurred_at

### company_devices (DEC-35, Proposed)
- id
- company_id
- branch_id
- device_label / asset_tag
- assigned_driver_id, nullable
- assigned_from, assigned_to
- status — active, lost, retired

### Helper function
`has_permission(permission_key text, target_branch_id uuid) returns boolean` — used by RLS policies and server services.

## 4. Vehicle and driver entities [MVP]

### vehicles
- id
- company_id
- current_branch_id — cache of the open `vehicle_branch_assignments` row
- department_id, nullable
- fleet_number
- registration_number
- make, model, variant
- model_year
- vehicle_category
- vin
- engine_number
- fuel_type
- transmission
- administrative_status — `available`, `in_maintenance`, `out_of_service`, `retired`
- current_odometer_km — cache only
- current_odometer_reading_id, nullable — reference to the latest accepted reading
- created_at, updated_at
- archived_at

Constraints:
- `UNIQUE (company_id, registration_number)`; `UNIQUE (company_id, fleet_number)`; `UNIQUE (company_id, vin)` where not null.
- `CHECK (current_odometer_km >= 0)`.

Operational status (allocated / in use / awaiting post-shift inspection) is **derived** from allocations, not stored. Last service and next service values are **derived** in `vehicle_service_status`, not stored on the vehicle. The cached odometer is maintained by the reading-acceptance service and is never an independent source of truth.

### vehicle_branch_assignments
- id
- company_id
- vehicle_id
- branch_id
- effective_from
- effective_to, nullable
- approval_id, nullable (DEC-31)
- created_by
- created_at

Constraint: exclusion — no overlapping ranges per vehicle.

### vehicle_documents
- id
- company_id
- vehicle_id
- document_type
- document_number
- issue_date
- expiry_date
- evidence_file_id → evidence_files
- verification_status
- created_at

### drivers
- id
- company_id
- profile_id → profiles, **required** (DEC-08 Approved: every driver signs in) — `UNIQUE`
- employee_number — `UNIQUE (company_id, employee_number)`
- branch_id
- active_status
- created_at, updated_at

### driver_licences
**The only home of licence data.**
- id
- company_id
- driver_id
- licence_number
- licence_code / class
- issue_date
- expiry_date
- prdp_required, prdp_expiry_date, nullable
- verification_status
- evidence_file_id, nullable
- created_at

Access to licence numbers and evidence is restricted (`driver.licence.view_sensitive`).

## 5. Shifts and allocations [MVP]

### shift_templates
- id
- company_id
- branch_id
- name
- start_time
- end_time
- crosses_midnight
- status

### shifts
- id
- company_id
- branch_id
- department_id, nullable
- shift_template_id, nullable
- shift_date — local date of the scheduled start
- scheduled_start_at
- scheduled_end_at
- actual_start_at, actual_end_at
- status

`CHECK (scheduled_end_at > scheduled_start_at)`.

### vehicle_allocations
- id
- company_id
- branch_id
- vehicle_id
- driver_id
- shift_id
- planned_start_at
- planned_end_at
- started_at, nullable
- released_at, nullable
- active_period — generated `tstzrange(planned_start_at, coalesce(released_at, planned_end_at))`
- status — `planned`, `pre_inspection_pending`, `in_use`, `post_inspection_pending`, `closed`, `closed_with_exceptions`, `cancelled`, `no_show`
- allocation_type — `standard`; `handover_segment` reserved (DEC-02)
- previous_allocation_id, nullable — the vehicle's previous allocation, set at creation (supports unaccounted distance)
- licence_override_approval_id, nullable (DEC-22)
- created_by
- closed_by, nullable
- created_at, updated_at

Constraints:
- `UNIQUE (id, vehicle_id, driver_id, shift_id, branch_id)` (for composite FKs).
- `EXCLUDE USING gist (vehicle_id WITH =, active_period WITH &&) WHERE (status NOT IN ('cancelled','no_show'))`.
- If DEC-01 restricts drivers to one vehicle at a time: the same exclusion on `driver_id`.
- Company and branch of vehicle, driver and shift must match the allocation (trigger or composite FK).
- Status transitions only through the allocation service function; invalid transitions rejected by trigger.
- `closed` only when both stages have an accepted reading and no open exceptions; `closed_with_exceptions` requires `closed_by` with permission.

Note: an allocation whose `released_at` is null still occupies its planned window; an overrunning allocation must be released or extended before another allocation can overlap.

### allocation_events
Append-only.
- id
- allocation_id
- event_type — created, status_changed, amended, released, handover (later), cancelled
- previous_value, new_value (jsonb)
- reason
- actor_id
- occurred_at
- metadata

## 6. Inspection entities [MVP]

### inspection_templates
- id
- company_id
- name
- vehicle_category
- version
- active_status
- first_used_at, nullable — once set, the template and its items are immutable
- created_at

`UNIQUE (company_id, vehicle_category, name, version)`.

### inspection_template_items
- id
- template_id
- item_key
- question
- response_type
- required
- applies_to_stage — pre_shift, post_shift, both
- sequence
- severity_rule
- configuration (jsonb)

### inspections
- id
- company_id
- branch_id
- vehicle_id
- driver_id
- shift_id
- allocation_id
- template_id
- inspection_stage — `pre_shift`, `post_shift`
- client_submission_id — unique
- started_at
- completed_at
- submitted_at
- server_received_at
- status — `draft`, `submitted`, `void`
- late_flag
- exception_status
- submitted_by
- completed_by_role — driver, supervisor_on_behalf (DEC-09)
- voided_at, void_reason, voided_by
- created_at

Constraints:
- Composite FK to `vehicle_allocations` (§2.1).
- `UNIQUE (id, allocation_id, inspection_stage)`.
- Partial unique: `UNIQUE (allocation_id, inspection_stage) WHERE status <> 'void'`.
- No delete grant.

### inspection_responses
- id
- inspection_id
- template_item_id
- response_value
- comments
- response_status
- created_at, updated_at (editable only while the inspection is draft)

### inspection_photos
- id
- company_id
- branch_id
- inspection_id
- vehicle_id
- evidence_file_id → evidence_files
- photo_category — condition, damage, other
- template_item_id, nullable
- created_at

Original file metadata (filename, MIME, size, timestamps) lives in `evidence_files`.

### vehicle_damage_items
Known-damage register.
- id
- company_id
- branch_id
- vehicle_id
- zone — e.g. front_bumper, left_rear_door
- description
- severity
- status — `reported`, `verified`, `repaired`, `disputed`
- first_reported_inspection_id
- first_reported_by
- verified_by, verified_at, nullable
- repaired_at, nullable
- incident_id, nullable
- created_at, updated_at

### vehicle_damage_evidence
- damage_item_id
- evidence_file_id
- inspection_id, nullable
- PK (damage_item_id, evidence_file_id)

## 7. Evidence storage entities [MVP]

### evidence_files
One row per stored file. Insert-only.
- id
- company_id
- branch_id, nullable
- bucket
- object_path — `UNIQUE (bucket, object_path)`
- sha256
- perceptual_hash, nullable (AD-03, later)
- mime_type
- size_bytes
- width, height, nullable
- capture_source — `in_app_camera`, `gallery`, `file_upload`, `import`
- device_capture_at, nullable (untrusted)
- server_received_at
- exif_gps_stripped — boolean (DEC-29)
- uploaded_by
- device_id, nullable → company_devices (DEC-35)
- purpose — odometer, inspection, damage, incident, vehicle_document, licence, service_record
- retention_class (DEC-27)
- legal_hold — boolean
- created_at

Rows are created only by the server registration step after verifying the object, type, size and hash.

### evidence_access_log
Append-only.
- id
- company_id
- evidence_file_id
- accessed_by
- access_type — signed_url_issued, download
- purpose / related_entity_type / related_entity_id
- occurred_at

## 8. Odometer evidence and mileage entities [MVP]

### odometer_validation_settings
Effective-dated, configurable thresholds (DEC-12 to DEC-18).
- id
- company_id
- vehicle_category, nullable — null = company default
- max_km_per_allocation
- ocr_min_confidence
- ocr_driver_tolerance_km
- unaccounted_tolerance_km
- pre_shift_late_minutes
- post_shift_late_minutes
- stale_reading_days
- version
- effective_from, effective_to
- approved_by
- created_at

Exclusion: no overlapping effective ranges per (company_id, vehicle_category).

Seeded company-default values (approved as configurable defaults, 2026-11-17): `ocr_driver_tolerance_km = 0` (DEC-14), `unaccounted_tolerance_km = 5` (DEC-16), `pre_shift_late_minutes = 30`, `post_shift_late_minutes = 60` (DEC-17), `stale_reading_days = 7` (DEC-18); readings in whole km (DEC-12). `ocr_min_confidence` (DEC-13) and `max_km_per_allocation` (DEC-15) are nullable and have no default: while null, no reading can be auto-accepted, and the implausible-distance check reports `not_configured` rather than passing.

### odometer_segments
Continuous lifetime kilometres across replacements and rollovers.
- id
- company_id
- vehicle_id
- segment_number
- starts_at
- ends_at, nullable
- offset_km — added to displayed reading to give lifetime km
- created_by_adjustment_id, nullable
- created_at

`lifetime_km = displayed_km + offset_km`. Exactly one open segment per vehicle.

### odometer_evidence
One record per odometer photo capture for an inspection stage; retakes kept.
- id
- company_id
- branch_id
- vehicle_id
- driver_id
- shift_id
- allocation_id
- inspection_id
- inspection_stage
- evidence_file_id → evidence_files
- is_current — boolean
- retake_of_id, nullable
- processing_status — pending_ocr, ocr_complete, ocr_failed, not_required
- created_at

Constraints:
- Composite FK `(inspection_id, allocation_id, inspection_stage)` → inspections.
- Partial unique: `UNIQUE (inspection_id) WHERE is_current`.

### odometer_ocr_results
One row per OCR attempt; never overwritten.
- id
- company_id
- odometer_evidence_id
- provider
- model_or_engine
- extracted_reading_km, nullable
- confidence_score, nullable
- raw_result_reference or restricted metadata
- processing_status — success, failed
- processing_error
- idempotency_key — unique
- processed_at
- created_at

### odometer_readings
A candidate reading and its acceptance state. Accepted rows are immutable.
- id
- company_id
- branch_id
- vehicle_id
- driver_id
- shift_id
- allocation_id
- inspection_id
- inspection_stage — (renamed from `reading_stage`)
- odometer_evidence_id, nullable only for `no_photo_exception` (DEC-03)
- segment_id → odometer_segments
- ocr_result_id, nullable
- ocr_reading_km, nullable
- driver_reading_km, nullable
- accepted_reading_km, nullable
- accepted_lifetime_km, nullable
- reading_status — `submitted`, `awaiting_review`, `accepted`, `rejected`, `superseded`
- review_status — `not_required`, `pending`, `approved`, `rejected`
- acceptance_method, nullable — `auto_rule`, `reviewer`, `no_photo_exception`
- validation_settings_id → odometer_validation_settings
- supersedes_reading_id, nullable → odometer_readings
- exception_summary
- client_submission_id — unique
- submitted_at
- accepted_at, nullable
- accepted_by, nullable (system user for `auto_rule`)
- approval_id, nullable
- created_at

Constraints:
- Composite FK `(inspection_id, allocation_id, inspection_stage)` → inspections.
- `CHECK` all km values `>= 0`.
- `CHECK (odometer_evidence_id IS NOT NULL OR acceptance_method = 'no_photo_exception')`.
- `CHECK (reading_status <> 'accepted' OR (accepted_reading_km IS NOT NULL AND accepted_at IS NOT NULL AND acceptance_method IS NOT NULL))`.
- `CHECK (acceptance_method <> 'no_photo_exception' OR approval_id IS NOT NULL)`.
- Partial unique: one accepted reading per `(allocation_id, inspection_stage) WHERE reading_status = 'accepted'`.
- Trigger: once `reading_status = 'accepted'`, the only permitted change is `reading_status → superseded` when a correction referencing it is accepted. Value columns cannot change.
- No delete grant.

The OCR value, the driver value and the accepted value are kept separately. Only accepted, non-superseded values feed official calculations.

### odometer_reading_events
Append-only lifecycle log.
- id
- company_id
- odometer_reading_id
- event_type — submitted, ocr_completed, validated, exception_created, reviewed, accepted, rejected, correction_requested, corrected, superseded
- previous_value, new_value (jsonb)
- reason
- actor_id
- occurred_at
- approval_id, nullable
- metadata

### odometer_exceptions
- id
- company_id
- branch_id
- vehicle_id
- driver_id, nullable
- allocation_id, nullable
- odometer_reading_id, nullable
- inspection_id, nullable
- exception_type
- description
- severity
- status — `open`, `in_review`, `resolved`, `dismissed`
- assigned_to
- approval_id, nullable — the decision record (authoritative)
- created_at
- resolved_at
- resolution_summary

Exception types:
- unreadable_image
- ocr_low_confidence
- ocr_failed
- ocr_driver_mismatch
- decreasing_reading
- implausible_distance
- unaccounted_distance
- duplicate_submission
- duplicate_image
- gallery_upload
- missing_reading
- missing_inspection
- late_inspection
- no_photo_exception
- possible_odometer_replacement
- possible_rollover
- service_odometer_inconsistent
- other

`approvals` holds the decision; `odometer_exceptions.status` mirrors it.

### odometer_adjustments
- id
- company_id
- branch_id
- vehicle_id
- previous_reading_km
- new_reading_km
- adjustment_type — replacement, reset, rollover, other
- reason
- evidence_file_id
- requested_by
- approval_id
- approved_by, approved_at
- new_segment_id → odometer_segments
- created_at

`CHECK (approved_by IS NULL OR approved_by <> requested_by)`. An adjustment never erases the historic reading sequence.

## 9. Mileage calculation model [MVP]

### allocation_mileage
Required. One current row per allocation; previous calculations kept.
- id
- company_id
- branch_id
- allocation_id
- start_reading_id, nullable
- end_reading_id, nullable
- start_lifetime_km, nullable
- end_lifetime_km, nullable
- distance_km, nullable
- previous_allocation_id, nullable
- previous_end_reading_id, nullable
- unaccounted_km_before, nullable
- calculation_status — `confirmed`, `provisional`, `incomplete`, `invalid`
- calculation_version
- is_current — boolean
- superseded_at, nullable
- calculated_at

Formulas:
- `distance_km = end_lifetime_km − start_lifetime_km` (only when both readings are accepted).
- `unaccounted_km_before = start_lifetime_km − previous allocation's end_lifetime_km`.

Constraints:
- `CHECK (distance_km IS NULL OR distance_km >= 0)`.
- `CHECK (calculation_status <> 'confirmed' OR (start_reading_id IS NOT NULL AND end_reading_id IS NOT NULL))`.
- Partial unique: `UNIQUE (allocation_id) WHERE is_current`.

Recalculation after an authorised correction inserts a new row and marks the previous row superseded. Handover segments (DEC-02) are each one allocation, so they are not double counted.

## 10. Service interval and maintenance entities

### vehicle_service_configs [MVP]
- id
- company_id
- scope — `vehicle`, `make_model`, `category`, `company_default`
- vehicle_id, nullable
- make, model, nullable
- vehicle_category, nullable
- manufacturer_reference
- service_interval_km
- early_tolerance_km
- late_tolerance_km
- service_interval_days, nullable
- early_tolerance_days, nullable (DEC-11)
- late_tolerance_days, nullable (DEC-11)
- service_type_sequence, nullable [Later] (DEC-11)
- effective_from
- effective_to, nullable
- reason
- created_by
- approved_by, nullable
- created_at

Constraints:
- Scope consistency: exactly the fields for the chosen scope are set (`CHECK`).
- `CHECK (service_interval_km > 0 AND early_tolerance_km >= 0 AND late_tolerance_km >= 0 AND early_tolerance_km < service_interval_km)`.
- `CHECK (service_interval_days IS NULL OR service_interval_days > 0)`.
- Exclusion: no overlapping effective ranges for the same scope target.

Default company configuration: `service_interval_km = 15000`, `early_tolerance_km = 1500`, `late_tolerance_km = 1500`.

Precedence (DEC-19, proposed): vehicle → make_model → category → company_default. Implemented in one function, `resolve_service_config(vehicle_id, at timestamptz)`, with tests.

### service_records [MVP — minimal]
- id
- company_id
- branch_id
- vehicle_id
- service_date
- actual_service_odometer_km
- actual_service_lifetime_km
- service_type
- source — `workshop`, `historical_import`, `manual`
- supplier_id, nullable [Later FK]
- supplier_name, nullable (MVP)
- work_order_id, nullable [Later FK]
- job_reference
- invoice_reference
- labour_cost, parts_cost, total_cost, nullable
- evidence_file_id, nullable
- verification_status — `recorded`, `verified`, `rejected`
- verified_by, verified_at, nullable
- rejection_reason, nullable
- created_by
- created_at

Constraints:
- `CHECK (actual_service_odometer_km >= 0)`.
- `CHECK (verified_by IS NULL OR verified_by <> created_by)` (DEC-24).
- `CHECK (verification_status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))`.
- Verified rows are immutable except through an audited reversal.

Only a verified service record sets the baseline. A booking, quotation or unverified record never does.

### vehicle_service_status [MVP] (view, AD-04)
Exposes per vehicle:
- vehicle_id
- service_config_id
- last_verified_service_record_id
- last_verified_service_odometer_km
- last_verified_service_date
- latest_accepted_odometer_reading_id
- current_accepted_odometer_km
- reading_age_days
- next_service_odometer_km
- early_warning_odometer_km
- late_tolerance_odometer_km
- distance_since_service_km
- remaining_km_to_target
- service_due_date, early_warning_date, late_tolerance_date (where time applies)
- km_status
- time_status
- effective_status — the more severe of km and time
- awaiting_verification — boolean
- data_quality_status — `ok`, `disputed`, `provisional`, `stale`
- calculated_at

Calculation:
```
next_service_odometer   = last_verified_service_odometer + service_interval_km
early_warning_odometer  = next_service_odometer - early_tolerance_km
late_tolerance_odometer = next_service_odometer + late_tolerance_km
distance_since_service  = current_accepted_lifetime_km - last_verified_service_lifetime_km
```

Example: verified service 82,400 km → early warning 95,900 km; target 97,400 km; late tolerance limit 98,900 km.

Status bands (DEC-10, proposed): `baseline_required` if no verified record; `normal` < 13,500; `approaching` 13,500–14,999; `due` 15,000–16,500 inclusive; `overdue` > 16,500 (default interval; generalised by the config's tolerances).

"Latest accepted reading" = accepted, non-superseded reading of the vehicle's most recent allocation, ordered by allocation start then stage (post after pre).

### service_alert_events [MVP]
- id
- company_id
- branch_id
- vehicle_id
- service_config_id
- baseline_service_record_id, nullable
- alert_type — `approaching`, `due`, `overdue`, `baseline_required`, `data_quality_review`, `awaiting_verification`
- basis — km, time
- threshold_value
- triggered_at
- status — open, acknowledged, resolved
- acknowledged_by, acknowledged_at
- resolved_at
- deduplication_key — unique, e.g. `{vehicle}:{baseline_record}:{alert_type}:{basis}`

### maintenance_schedules [Later]
For maintenance types **other than** the primary service (e.g. tyres, brakes, licence disc). The primary service uses `vehicle_service_configs` only.
- id, company_id, vehicle_id, maintenance_type, interval_km, interval_days, next_due_date, next_due_odometer, status

### work_orders [Later]
- id, company_id, branch_id, vehicle_id, supplier_id, work_order_number, work_type, description, opened_at, scheduled_at, completed_at, status, estimated_cost, actual_cost, downtime_start, downtime_end, created_by

### work_order_items [Later]
- id, work_order_id, description, quantity, unit_cost, total_cost

## 11. Incident entities [MVP — basic]

### incidents
- id
- company_id
- branch_id
- vehicle_id
- driver_id, nullable
- allocation_id, nullable
- inspection_id, nullable
- incident_type
- severity
- description
- occurred_at
- reported_at
- status
- assigned_investigator, nullable
- created_by
- closed_by, closed_at, nullable

### incident_evidence
- incident_id
- evidence_file_id
- evidence_type
- PK (incident_id, evidence_file_id)

### incident_investigations
- id, incident_id, investigator_id, findings, investigation_status, completed_at

### incident_actions
- id, incident_id, action_description, assigned_to, due_date, status, completed_at

Reported damage, AI-suggested damage (later) and verified findings must be distinguishable (`vehicle_damage_items.status`, investigation findings, and AI results stored separately when introduced).

## 12. Fuel entities [Later]

### fuel_cards
- id, company_id, vehicle_id (nullable), card_reference, provider, status

### fuel_transactions
- id, company_id, branch_id, vehicle_id, driver_id (nullable), fuel_card_id (nullable), supplier, transaction_reference, transaction_at, litres, price_per_litre, total_cost, odometer_km (nullable), import_batch_id, import_status, verification_status, created_at

### fuel_import_batches
- id, company_id, source, filename, imported_at, imported_by, status, error_summary

Imported transactions are staged and validated before becoming confirmed records (DEC-33).

## 13. Supplier and procurement entities [Later]

### suppliers
- id, company_id, name, supplier_type, contact_details, status

### supplier_quotes
- id, supplier_id, vehicle_id, work_type, quoted_amount, quote_date, expiry_date, status, evidence_file_id

### purchase_orders
- id, company_id, supplier_id, purchase_order_number, approved_by, approved_at, total_amount, status

### supplier_invoices
- id, supplier_id, work_order_id, invoice_number, invoice_date, total_amount, evidence_file_id, verification_status

## 14. KPI and analytics entities [Later, except MVP report views]

MVP operational reports use views over allocations, readings, mileage, exceptions and service status. The following tables support the full KPI catalogue (DEC-30).

### kpi_definitions
- id, company_id, name, description, calculation_method, unit, frequency, data_quality_requirements, active_status

### kpi_targets
- id, kpi_definition_id, branch_id (nullable), target_value, effective_from, effective_to

### kpi_results
- id, kpi_definition_id, branch_id, vehicle_id, driver_id (nullable), period_start, period_end, result_value, data_quality_status, calculated_at

### utilisation_snapshots
- id, vehicle_id, branch_id, snapshot_date, allocated_duration, available_duration, distance_km, unaccounted_km, utilisation_rate, data_quality_status

### cost_records
- id, company_id, vehicle_id, branch_id, cost_type, transaction_date, amount, source_reference, verification_status

Every KPI has a documented calculation and source-data definition.

## 15. Continuous improvement entities [Later]

### improvement_projects
- id, company_id, branch_id, title, problem_statement, dmaic_phase, baseline_measure, target_measure, owner_id, status, start_date, target_date, completed_at

### root_causes
- id, improvement_project_id, description, category, evidence_file_id

### improvement_actions
- id, improvement_project_id, description, owner_id, due_date, status, completed_at

### savings_records
- id, improvement_project_id, baseline_cost, actual_cost, calculated_saving, verification_method, verified_by, verified_at

### control_plans
- id, improvement_project_id, metric, monitoring_frequency, owner_id, escalation_rule

Estimated savings are never treated as verified savings.

## 16. Notification entities [MVP]

### notification_rules
- id
- company_id
- event_type
- branch_id, nullable
- recipient_role_id, nullable
- recipient_user_id, nullable
- channel — in_app, email (DEC-28)
- escalation_step
- escalate_after_minutes, nullable
- active

### notifications
- id
- company_id
- branch_id, nullable
- recipient_user_id
- notification_type
- title
- message
- related_entity_type, related_entity_id
- priority
- deduplication_key
- escalation_step
- created_at
- acknowledged_at
- status

`UNIQUE (recipient_user_id, deduplication_key)`.

### notification_deliveries
- id, notification_id, channel, destination_reference, delivery_status, attempt_count, last_attempt_at, error_message

## 17. Approval entities [MVP]

### approvals
The authoritative record of every controlled decision.
- id
- company_id
- branch_id, nullable
- entity_type
- entity_id
- approval_type — odometer_exception, odometer_correction, odometer_adjustment, no_photo_reading, service_verification, service_config_override, branch_transfer, licence_override, allocation_close_with_exceptions
- requested_by
- assigned_approver, nullable
- status — pending, approved, rejected, cancelled
- reason
- decision_notes
- decided_by, decided_at
- created_at

Constraints:
- `CHECK (decided_by IS NULL OR decided_by <> requested_by)` (DEC-24, Approved).
- Additional segregation rules (e.g. not the allocation's driver) enforced in the approval service and by trigger.

## 18. Background jobs [MVP]

### background_jobs (AD-01, Approved)
- id
- company_id, nullable
- job_type — ocr, service_evaluation, inspection_watch, notification_dispatch, upload_cleanup
- payload (jsonb)
- idempotency_key — unique
- status — queued, running, succeeded, failed, dead
- attempts
- max_attempts
- next_run_at
- locked_at, locked_by
- last_error
- created_at, finished_at

Workers claim jobs with `FOR UPDATE SKIP LOCKED`.

## 19. Audit entities [MVP]

### audit_logs
- id
- company_id
- branch_id, nullable
- actor_id
- action
- entity_type
- entity_id
- occurred_at
- before_values (jsonb)
- after_values (jsonb)
- reason
- request_reference
- metadata

Rules:
- Written by database triggers on sensitive tables so application code cannot skip them.
- `REVOKE UPDATE, DELETE` from all application roles; append-only.
- Do not store secrets or unnecessary sensitive data (e.g. full licence numbers) in before/after values.

Evidence access is logged separately in `evidence_access_log` (§7).

## 20. Status catalogue

Canonical values, used by `CHECK` constraints and referenced by the PRD and Technical Architecture.

| Domain | Values |
|---|---|
| vehicle.administrative_status | available, in_maintenance, out_of_service, retired |
| allocation.status | planned, pre_inspection_pending, in_use, post_inspection_pending, closed, closed_with_exceptions, cancelled, no_show |
| inspection.status | draft, submitted, void |
| inspection_stage | pre_shift, post_shift |
| evidence.capture_source | in_app_camera, gallery, file_upload, import |
| reading.reading_status | submitted, awaiting_review, accepted, rejected, superseded |
| reading.review_status | not_required, pending, approved, rejected |
| reading.acceptance_method | auto_rule, reviewer, no_photo_exception |
| mileage.calculation_status | confirmed, provisional, incomplete, invalid |
| exception.status | open, in_review, resolved, dismissed |
| service.km_status / time_status / effective_status | baseline_required, normal, approaching, due, overdue |
| service.data_quality_status | ok, disputed, provisional, stale |
| service_record.verification_status | recorded, verified, rejected |
| damage_item.status | reported, verified, repaired, disputed |
| approval.status | pending, approved, rejected, cancelled |
| job.status | queued, running, succeeded, failed, dead |

## 21. Important constraints and validation rules (summary)

### Allocations
- No overlapping active allocations per vehicle (exclusion constraint); per driver if DEC-01 requires.
- Vehicle, driver, shift and allocation in the same company and branch.
- Lifecycle transitions validated; history in `allocation_events`.
- Closure rules enforced.

### Inspections
- One non-void inspection per allocation and stage.
- Mandatory odometer evidence for normal submission (submission function checks within the transaction).
- Idempotent submission via `client_submission_id`.
- Voided, never deleted.

### Odometer readings
- Non-negative values.
- Evidence required unless an approved no-photo exception.
- One accepted reading per allocation and stage.
- Accepted readings immutable; corrections supersede.
- Validation settings version recorded.
- Suspicious readings never feed confirmed mileage.

### Mileage
- Confirmed distance only from two accepted readings.
- Negative distances invalid.
- Unaccounted distance calculated against the previous allocation.
- Calculations on lifetime km; recalculations keep history.

### Service monitoring
- Positive intervals, non-negative tolerances, early tolerance < interval.
- One resolved configuration per vehicle at a time; explicit precedence.
- Baseline only from verified service records; verifier ≠ creator.
- Both km and time thresholds evaluated where configured.

### Evidence
- Registered only after server verification.
- Insert-only; private storage only.
- Access logged; deletion only via controlled retention process honouring legal hold.

### Approvals
- Decider ≠ requester; further segregation rules in service and triggers.

## 22. Indexing recommendations

Single-column (as needed): company_id, branch_id, vehicle_id, driver_id, shift_id, allocation_id, inspection_id, status columns, deduplication keys.

Composite (validate with query plans):
- `vehicle_allocations (vehicle_id, planned_start_at DESC)`
- `vehicle_allocations (branch_id, status, planned_start_at)`
- GiST `vehicle_allocations (vehicle_id, active_period)` (from the exclusion constraint)
- `odometer_readings (vehicle_id, reading_status, accepted_at DESC)`
- `odometer_readings (allocation_id, inspection_stage)`
- `odometer_exceptions (branch_id, status, created_at)`
- `inspections (allocation_id, inspection_stage)`
- `shifts (branch_id, shift_date)`
- `service_records (vehicle_id, verification_status, service_date DESC)`
- `notifications (recipient_user_id, status, created_at DESC)`
- `background_jobs (status, next_run_at)`
- `audit_logs (entity_type, entity_id, occurred_at DESC)`
- `evidence_files (company_id, sha256)`

Do not add indexes indiscriminately.

## 23. Data access and Row Level Security

Policies enforce:
- Company boundaries.
- Branch scope via `user_roles` and `has_permission`.
- Driver access to own allocations, inspections, readings and own evidence.
- Supervisor and branch manager access to assigned branches.
- Fleet administration and management reporting permissions.
- Restricted access to licence data and other sensitive personal information.
- Restricted access to evidence (`evidence_files` and storage object policies aligned).
- Restricted approval, correction, adjustment and verification actions.

The service-role key bypasses RLS and is used only by jobs and reviewed admin functions (Technical Architecture §5.3).

Test cross-branch and cross-company access, self-approval and sensitive-field access explicitly for every role.

## 24. Data retention and deletion

Retention rules are required for: inspection photographs, odometer evidence, incident evidence, damage evidence, driver records, licence evidence, vehicle documents, audit records, evidence access logs, and financial/maintenance records.

Do not invent retention periods; they must be confirmed against company policy and legal requirements (DEC-27). `evidence_files.retention_class` and `legal_hold` support the approved policy.

Where deletion is legally or operationally necessary, use a controlled, approved, audited process that preserves required audit history.

## 25. Database design acceptance criteria

The design is acceptable when:

1. Every allocation traces to a vehicle, driver, branch and shift, with consistent keys enforced by the database.
2. Every normal allocation supports exactly one non-void pre-shift and post-shift inspection.
3. Every required inspection has linked odometer photographic evidence, or an approved and labelled no-photo exception.
4. OCR, driver and accepted readings remain separately identifiable.
5. Accepted readings cannot be altered; corrections supersede and preserve history.
6. Only accepted, non-superseded readings feed confirmed mileage.
7. Unaccounted distance between allocations is calculable and recorded.
8. Lifetime kilometres stay continuous across odometer adjustments.
9. Service calculations use the latest accepted reading by allocation chronology.
10. Service baselines come only from verified service records verified by a different user.
11. Default service thresholds are configurable and correctly calculated at boundaries.
12. Vehicle, make/model and category overrides follow explicit, tested precedence and are auditable.
13. Time-based and kilometre-based intervals are supported, with effective status.
14. Evidence is stored privately, registered after verification and access-logged.
15. Branch and company access rules are enforced and tested.
16. Important state changes are audited by triggers.
17. Repeated submissions and job retries are idempotent.
18. The schema supports the MVP without GPS or telematics.

## 26. Open database design decisions

| Item | Status | Reference |
|---|---|---|
| Separate handover segment entity | Reserved via `allocation_type = handover_segment` | DEC-02 |
| Driver one vehicle at a time (driver exclusion constraint) | Pending | DEC-01 |
| Evidence nullable for no-photo readings | Pending | DEC-03 |
| Multiple photos per checklist item | Supported via `inspection_photos.template_item_id`; rules pending | DEC-21 |
| OCR provider metadata to retain | Pending | DEC-26 |
| `drivers.profile_id` required | Approved | DEC-08 |
| Company device register | Proposed | DEC-35 |
| Service config precedence | Proposed | DEC-19 |
| `vehicle_service_status` view vs snapshot | Proposed view | AD-04 |
| Branch scope source | Approved: `user_roles` only | AD-05 |
| Retention classes | Pending | DEC-27 |
| Fuel import source and format | Deferred | DEC-33 |

---

**Important implementation rule:** This specification (v1.4, approved 2026-11-17) defines the intended logical database design. Do not create production tables or migrations from it until the pre-development gate in PRD §10 is passed and the actual application repository and database have been inspected.
