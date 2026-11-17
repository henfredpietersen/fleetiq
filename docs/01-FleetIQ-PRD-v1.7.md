# FleetIQ — Product Requirements Document (PRD)

**Version:** 1.7
**Status:** Approved (2026-11-17)
**Product:** FleetIQ
**Product type:** Internal fleet-management and operational intelligence platform
**Companion documents:** Technical Architecture v1.7, Database Design Specification v1.5

---

## 0. Change log

| Version | Date | Summary |
|---|---|---|
| 1.0 | — | Initial baseline. |
| 1.1 | 2026-11 | Mandatory odometer evidence and service interval requirements added. |
| 1.2 | 2026-11-12 | Reconciled with principal-architect review. Added: allocation lifecycle; inter-allocation unaccounted-distance control; reading lifecycle, auto-acceptance and correction rules; configurable validation thresholds; no-photo exception path; service status bands; time-based tolerances; minimal service record capture and baseline onboarding in MVP; existing-damage register; MVP dashboard definition; segregation of duties; proposed permission matrix; POPIA specifics; Decision Register; roadmap; pre-development gate. Clarified that last-service and next-service values are derived, not editable vehicle fields. Mapped "Operations manager" to a pending role decision. |
| 1.3 | 2026-11-12 | Decisions approved: DEC-08 (drivers sign in with employee number + PIN; each driver uses a company-issued phone), DEC-24 (segregation of duties as proposed), DEC-32 ("Operations manager" = Branch manager). Added DEC-34 (office user login) and DEC-35 (company device register) as Proposed. Updated driver register, notifications, security NFRs, permission matrix note and pre-development gate. |
| 1.3 | 2026-11-17 | **Approved by the user as the product baseline.** Document approval does not approve individual decisions: every Decision Register item marked Proposed or Open remains unapproved and configurable until decided individually. Pre-development gate updated (documentation approved; duplicate v1.2 PRD still present in Project Knowledge, so that item is reopened). |
| 1.4 | 2026-11-17 | Decisions approved: DEC-34 (office users: email + password, MFA for administrators and approvers); DEC-12, DEC-14, DEC-16, DEC-17, DEC-18 approved as configurable default values; DEC-13 and DEC-15 explicitly deferred to configuration (no default until set from operational data). AD-01 and AD-05 approved (Technical Architecture v1.4). Pre-development gate updated. |
| 1.5 | 2026-11-17 | DEC-23 permission matrix approved as proposed (§4.2), including: odometer corrections approved by fleet admin (company-wide) or branch manager (own branch); supervisors approve standard exceptions in their own branch; system administrator has no access to operational data (evidence, reports, licence details) but can view the audit log. All grants subject to DEC-24. |
| 1.6 | 2026-11-17 | DEC-25 approved: all personal data and evidence stay in South Africa; self-hosted Supabase and the Next.js app on RSAWEB cloud servers (South African data centres); production address fleetiq.outview.co.za; company-owned accounts with at least two administrators. Added POPIA operator agreement (Outview as operator) and in-country rule for later providers (DEC-26, DEC-28). Approved exception: Phase 1 may be built on local/CI Supabase with synthetic data before servers are provisioned. |
| 1.7 | 2026-11-17 | Approved: DEC-19 (service configuration precedence: vehicle → make/model → category → company default), DEC-20 (baseline evidence: invoice, job card or service-book photo, verified by the maintenance administrator), DEC-31 (fleet administrator approves branch transfers; history kept). Local/CI synthetic-data exception extended to Phase 2. |

**Notation.** Items marked **[DEC-xx]** depend on a decision in the Decision Register (§12). Until a decision is approved, the stated value is a **proposed default** and must be implemented as configurable, not hard-coded.

---

## 1. Product vision

FleetIQ is an internal fleet-management platform designed to improve vehicle accountability, operational efficiency, maintenance compliance and cost control.

The system will provide a central, reliable record of vehicles, drivers, shifts, allocations, inspections, mileage, maintenance, fuel and operating performance.

FleetIQ must turn day-to-day fleet activity into useful, auditable management information.

The platform must support approximately 50–200 vehicles across multiple branches and shifts.

## 2. Business objectives

FleetIQ must help the organisation:

1. Establish exactly which driver used which vehicle during each shift.
2. Record vehicle condition before and after use.
3. Capture reliable odometer evidence and calculate kilometres travelled.
4. Detect kilometres driven outside any accountable allocation (after-hours or unauthorised use).
5. Identify vehicle damage and operational exceptions.
6. Monitor service intervals and maintenance compliance.
7. Reduce unnecessary mileage and vehicle operating costs.
8. Improve vehicle utilisation and reduce downtime.
9. Monitor fuel consumption and fuel expenditure.
10. Measure driver, vehicle, branch and fleet performance fairly.
11. Identify cost-saving opportunities.
12. Support Lean Six Sigma and continuous improvement.
13. Provide management with trustworthy operational dashboards and reports.

## 3. Operating environment and assumptions

- Initial fleet: approximately 50–200 vehicles.
- Initial deployment: one organisation in South Africa; time zone Africa/Johannesburg.
- Organisation structure: multiple branches, optional departments.
- Operating model: multiple shifts, including shifts that cross midnight.
- Users: drivers, supervisors, branch managers, fleet administrators, maintenance personnel, senior management and system administrators.
- Initial mileage source: inspection odometer photographs and accepted readings.
- GPS and telematics: future integration.
- Primary interface: responsive web application.
- Driver experience: mobile-first, on mid-range Android and iOS phones, often on weak mobile connections and during load-shedding.
- Management experience: desktop and tablet friendly.
- Initial product: internal company system, not public SaaS.

## 4. User roles and permissions

### 4.1 Roles

The following roles are proposed. Final role names and permissions must be configurable. Access is determined by permissions and organisational scope, not by the visible role name.

**Driver**
- View own profile, assigned shifts and allocations.
- View assigned vehicle and its known-damage register.
- Complete pre-shift and post-shift inspections.
- Capture odometer photographs and submit readings.
- Report existing or new damage and operational problems.
- View own inspection and allocation history where permitted.

**Supervisor**
- View branch operational activity.
- Create and manage allocations within assigned branches.
- Monitor outstanding, late and missing inspections.
- Review flagged odometer readings and approve standard exceptions within delegated permissions.
- Complete a post-shift inspection on a driver's behalf where permitted [DEC-09].
- Record or review incidents.
- Escalate unresolved issues.

**Fleet administrator**
- Manage vehicles, vehicle records and branch transfers.
- Manage allocation rules and validation settings.
- Configure service intervals and approve service-configuration overrides.
- Review odometer exceptions; approve corrections and odometer adjustments.
- Monitor service compliance.
- View fleet-wide operational records within assigned scope.

**Maintenance administrator**
- Record service completion and attach evidence.
- Verify service records created by others.
- Load and verify initial service baselines.
- Manage repair and maintenance records (later phase: work orders, suppliers, costs).
- Review vehicle downtime.

**Branch manager**
- Monitor branch vehicles and drivers.
- View branch-level KPIs and reports.
- Review exceptions and approvals within authority.
- Receive escalations for service due and overdue.

**Senior management**
- View consolidated management dashboards.
- Compare branch and fleet performance.
- Review costs, utilisation, service compliance and savings.
- Receive critical escalations.
- Monitor continuous-improvement projects.

**System administrator**
- Manage organisation settings.
- Manage user accounts, roles, permissions and branch access.
- Configure system-wide rules.
- Access audit and configuration records as authorised.

**Operations manager** — not a separate role. Approved: wherever "Operations manager" was referenced, the Branch manager role applies [DEC-32 — Approved].

### 4.2 Permission matrix [DEC-23 — Approved]

Approved 2026-11-17. Grants are stored as configuration (roles, permissions, `user_roles`) and every grant is subject to segregation of duties (§4.3). Scope key: **Own** = own records only · **Branch** = assigned branches · **All** = whole company.

| Permission | Driver | Supervisor | Fleet admin | Maint. admin | Branch mgr | Senior mgmt | System admin |
|---|---|---|---|---|---|---|---|
| inspection.submit | Own | Branch (on behalf) | — | — | — | — | — |
| allocation.manage | — | Branch | All | — | Branch | — | — |
| odometer.exception.review | — | Branch | All | — | Branch | — | — |
| odometer.exception.approve (standard) | — | Branch | All | — | Branch | — | — |
| odometer.correction.approve | — | — | All | — | Branch | — | — |
| odometer.adjustment.approve | — | — | All | — | — | — | — |
| odometer.no_photo.approve [DEC-03] | — | Branch | All | — | Branch | — | — |
| service.record.create | — | — | All | All | — | — | — |
| service.record.verify | — | — | All | All | — | — | — |
| service.config.manage | — | — | All | — | — | — | — |
| vehicle.manage | — | — | All | — | — | — | — |
| vehicle.transfer.approve [DEC-31] | — | — | All | — | — | — | — |
| driver.manage | — | — | All | — | Branch | — | — |
| driver.licence.view_sensitive | Own | Branch | All | — | Branch | — | — |
| incident.record | Own | Branch | All | — | Branch | — | — |
| incident.investigate / close | — | Branch | All | — | Branch | — | — |
| evidence.view | Own | Branch | All | All (service evidence) | Branch | All | — |
| reports.view | — | Branch | All | All | Branch | All | — |
| settings.validation.manage | — | — | All | — | — | — | All |
| users.roles.manage | — | — | — | — | — | — | All |
| audit.view | — | — | All | — | — | All | All |

### 4.3 Segregation of duties [DEC-24 — Approved]

Approved rules (no override):
- Nobody may approve, correct or verify a record they created or submitted.
- A supervisor may not approve an exception on an allocation in which they are the driver.
- A service record must be verified by a different user from the one who created it.
- A user may not grant themselves roles or permissions.

## 5. Functional requirements

### 5.1 Dashboard

Provide dashboards appropriate to each user's permissions.

**MVP management dashboard tiles:**
- Total vehicles; available; currently in use; in maintenance; out of service.
- Allocations today: planned, in use, awaiting post-shift inspection, closed, closed with exceptions.
- Missing and late inspections.
- Odometer exceptions awaiting review (by age).
- Unaccounted kilometres between allocations (count and km).
- Kilometres travelled: confirmed vs provisional.
- Service status distribution: baseline required, approaching, due, overdue, awaiting verification, data-quality review.
- Open incidents and unverified damage reports.
- Branch comparison of the above.

**Later-phase dashboard tiles:** maintenance expenditure, fuel expenditure, cost per kilometre, utilisation trends, KPI targets and continuous-improvement results. Until the source module exists, these tiles are hidden or shown as "Not yet available" — never with placeholder figures.

Dashboard metrics must distinguish accepted/verified information from provisional, missing, disputed and no-photo data.

### 5.2 Organisation and branches

The system must support:
- One organisation initially.
- Multiple branches.
- Optional departments.
- Branch-specific vehicle assignment with history.
- Branch-specific users and permissions.
- Controlled vehicle transfers between branches, approved by the fleet administrator [DEC-31 — Approved] and kept as history.
- Consolidated management reporting.

A user must not access another branch's restricted records without explicit permission. Historical records keep the branch that applied at the time.

### 5.3 Vehicle register

Each vehicle record should support:
- Registration number.
- Fleet number or internal identifier.
- Make, model, variant where relevant, model year.
- Vehicle category.
- Current branch and department where applicable.
- VIN/chassis number; engine number where required.
- Fuel type; transmission where relevant.
- Administrative status.
- Service interval configuration (via service configuration, §5.10).
- Purchase/lease information where required.
- Insurance and licence-disc information.
- Supporting documents.
- Vehicle history.

**Displayed, derived values (not editable fields):** current operational odometer, last verified service odometer and date, next service threshold, service status and in-use status. These are calculated from accepted readings, verified service records and active allocations.

**Administrative statuses (stored):** Available, In maintenance, Out of service, Retired.
**Operational statuses (derived from allocations):** Allocated, In use, Awaiting post-shift inspection.

The system must preserve historical allocations and records when vehicle details change.

### 5.4 Driver register

Each driver record should support:
- Name and employee identifier.
- Linked user account (required; every driver signs in) [DEC-08 — Approved].
- Sign-in identifier: employee number, with a PIN [DEC-08 — Approved].
- Issued company phone, where recorded [DEC-35].
- Contact details where necessary.
- Branch.
- Employment/active status.
- Licence records: number, class/code, issue and expiry date, professional driving permit where required, evidence and verification status.
- Required authorisations.
- Training or competency information where approved.
- Allocation, inspection and incident history subject to access controls.

Avoid collecting unnecessary personal information.

**Eligibility at allocation [DEC-22] (proposed):** block allocation if the driver's licence has expired or is unverified; warn and require authorised override if the licence class does not match the vehicle category.

### 5.5 Shifts and allocations

The system must support:
- Configurable shift templates, including shifts crossing midnight.
- Multiple shifts per day.
- Shift start and end times; the shift date is the local (Africa/Johannesburg) date of the scheduled start.
- Branch and department.
- Driver and vehicle assignment.
- Allocation start and end.
- Allocation lifecycle status.
- Vehicle handover records where applicable [DEC-02].
- Allocation history.

**Allocation lifecycle:**

| Status | Meaning | Moves to |
|---|---|---|
| planned | Created, not yet started | pre_inspection_pending, cancelled |
| pre_inspection_pending | Driver has opened the allocation | in_use, no_show, cancelled |
| in_use | Pre-shift inspection submitted | post_inspection_pending |
| post_inspection_pending | Shift ended or driver started post-shift inspection | closed, closed_with_exceptions |
| closed | Both inspections done, both readings accepted, no open exceptions | — (corrections only via approved process) |
| closed_with_exceptions | Closed by an authorised user with unresolved or approved exceptions | closed (when exceptions resolve) |
| cancelled | Not used; no inspections | — |
| no_show | Driver did not take the vehicle | — |

Every allocation must establish:
- Which vehicle was used.
- Which driver used it.
- Which shift it related to.
- When use started and ended.
- Which inspections were completed, by whom and when.
- Which odometer readings were accepted.
- Any exceptions or handovers.

Prevent overlapping active allocations for the same vehicle unless an authorised handover workflow explicitly supports the transition.

Support multiple drivers using the same vehicle in different shifts. Whether a driver may use more than one vehicle in a shift is pending [DEC-01]; proposed: yes, one at a time, each allocation with its own inspections.

### 5.6 Mandatory pre-shift inspection

Before using a vehicle, the driver must complete a pre-shift inspection.

The inspection must include:
- Vehicle identity confirmation.
- Driver identity confirmation.
- Allocation and shift linkage.
- Inspection date and time.
- Configurable, versioned inspection checklist for the vehicle category [DEC-21].
- Odometer photograph.
- Odometer reading capture (§5.8).
- Vehicle condition responses.
- Review of the vehicle's known-damage register and reporting of any damage not listed.
- Supporting photographs where necessary.
- Inspection submission status.

The odometer photograph is mandatory.

The driver must not be able to complete a normal pre-shift inspection without the required odometer evidence. An authorised exception process must be available for genuine technical or operational circumstances (§5.8.6).

**Late pre-shift inspection:** submitted more than the configured period after scheduled shift start (default 30 minutes, configurable) [DEC-17 — Approved]. Flag as an exception; do not block submission.

### 5.7 Mandatory post-shift inspection

At the end of the allocation, the driver must complete a post-shift inspection.

The inspection must include the same elements as §5.6, plus new damage or incident reporting.

The post-shift odometer photograph is mandatory.

A post-shift inspection must be linked to the correct allocation, not merely to a vehicle and date.

**Missing post-shift inspection:** not submitted within the configured period after scheduled shift end (default 60 minutes, configurable) [DEC-17 — Approved]. Create an exception and notify the supervisor.

**Completion by another person:** whether a supervisor may complete it when the driver is unavailable is pending [DEC-09]; proposed: yes, flagged and audited.

Only one non-void inspection may exist per allocation and stage. A wrong inspection is voided with a reason, never deleted.

### 5.8 Odometer evidence and reading validation

#### 5.8.1 Principle

The initial operational mileage source is accepted readings obtained from pre-shift and post-shift inspection odometer photographs.

The system keeps three values separate and never collapses them into one editable field:
- **OCR-extracted reading** (may be absent).
- **Driver-entered/confirmed reading.**
- **Accepted operational reading** (set only by the acceptance rule or an authorised reviewer).

#### 5.8.2 Evidence record

Each odometer evidence record must include:
- Vehicle, driver, shift, allocation and inspection IDs.
- Inspection stage: pre-shift or post-shift.
- Original image reference (private).
- Capture source: in-app camera, gallery, or file upload.
- Device capture timestamp when available.
- Server receipt timestamp.
- Image hash.
- OCR result(s) and confidence where available.
- Driver-entered/confirmed reading.
- Reading status and review status.
- Exception reason where applicable.
- Reviewer and approval details where applicable.

Retakes are kept; only one evidence record per inspection is marked current.

#### 5.8.3 Capture

- Use an in-app camera capture where the browser supports it.
- A web application cannot guarantee live capture. Gallery or file uploads must be technically identified; proposed handling: allowed, flagged and routed to review [DEC-04].
- The "original" is the image as captured by the app at a defined resolution (proposed ~1600 px long edge, high-quality JPEG) [DEC-07]. Once uploaded it is never altered.
- EXIF GPS coordinates are stripped on upload in the MVP [DEC-29].

#### 5.8.4 Reading lifecycle

1. Driver captures the photograph; the upload is verified and registered by the server.
2. OCR is attempted (with a short timeout so the driver is not kept waiting).
3. Driver enters the reading. Proposed: **blind entry** — the driver types the reading without seeing the OCR value, and the system compares the two [DEC-05].
4. Validation checks run (§5.8.5).
5. **Auto-acceptance** — the reading is accepted without human review only when all of the following hold:
   - The evidence is an in-app capture.
   - OCR succeeded at or above the confidence threshold [DEC-13].
   - The driver's reading matches OCR within tolerance (default 0 km, configurable) [DEC-14 — Approved].
   - All validation checks pass.
   The acceptance records `accepted_by = system`, the method and the rule version.
6. Otherwise, the reading goes to review with an exception reason; an authorised reviewer accepts, rejects or corrects it.
7. If OCR completes after the driver has submitted, the comparison runs then, and a mismatch creates an exception.

#### 5.8.5 Validation checks

The system must flag:
1. Unreadable images (OCR failure plus reviewer confirmation).
2. Low-confidence extraction [DEC-13].
3. Discrepancies between OCR and driver reading [DEC-14].
4. Decreasing readings compared with the previous accepted reading for the vehicle.
5. Implausible distance within an allocation, above the configured maximum for the vehicle category [DEC-15].
6. **Unaccounted distance** between the previous allocation's accepted post-shift reading and this allocation's accepted pre-shift reading, above the configured tolerance (default 5 km, configurable) [DEC-16 — Approved].
7. Duplicate or repeated evidence (identical image hash; perceptual similarity in a later phase).
8. Gallery or file uploads [DEC-04].
9. Late or delayed submissions [DEC-17].
10. Possible odometer rollover or replacement.
11. Missing pre-shift or post-shift readings.

An anomaly is an investigation signal, not proof of misconduct.

All thresholds are configurable settings with effective dates and are recorded against each validation result.

#### 5.8.6 No-photo exception [DEC-03]

Where a photograph genuinely cannot be captured (for example, a failed camera or dead phone), the proposed process is:
- The driver or supervisor records the reason.
- A supervisor witnesses and records the reading.
- An authorised user approves it, subject to segregation of duties.
- The reading is accepted with method `no_photo_exception` and is permanently labelled as such.
- It is excluded from "photo-verified" figures and shown separately on dashboards and reports.

If [DEC-03] is not approved, such allocations remain incomplete and their mileage stays provisional.

#### 5.8.7 Corrections and adjustments

- An accepted reading is never edited. A correction creates a new reading that supersedes the old one; both are kept.
- A correction records the original reading, corrected reading, reason, requester, approver, timestamps and supporting evidence.
- Corrections require approval by an authorised user other than the requester.
- Corrected readings trigger recalculation of affected mileage and service status, keeping the previous calculation in history.
- If an odometer has been replaced, reset, rolled over or otherwise legitimately changed, record a controlled **odometer adjustment** with supporting evidence. Adjustments start a new odometer segment so lifetime kilometres stay continuous for mileage and service calculations.
- Original evidence is never overwritten by edited or corrected images.

#### 5.8.8 Definition of "latest accepted reading"

The latest accepted reading for a vehicle is the accepted, non-superseded reading belonging to the most recent allocation (by allocation start time, then stage: post-shift after pre-shift). It is not the highest value and not the latest device timestamp.

A reading is **stale** when an active vehicle has had no accepted reading for the configured period (default 7 days, configurable) [DEC-18 — Approved].

### 5.9 Mileage calculation

**Allocation distance = accepted post-shift odometer reading − accepted pre-shift odometer reading.**

**Unaccounted distance = accepted pre-shift reading of this allocation − accepted post-shift reading of the vehicle's previous allocation.**

Rules:
- Only accepted, non-superseded readings may be used in official mileage calculations.
- If either reading is missing, disputed, invalid or unapproved:
  - Do not calculate a confirmed distance.
  - Mark the allocation mileage as provisional or incomplete.
  - Create or keep a data-quality exception.
  - Notify the appropriate authorised user.
- A negative result is never stored as confirmed distance; it creates an exception.
- Do not silently replace missing readings with estimates.
- Unaccounted distance above tolerance creates an `unaccounted_distance` exception. Unaccounted distance is never attributed to a driver automatically.
- Readings across an odometer adjustment are calculated on lifetime kilometres.
- Where handovers within a shift are later supported [DEC-02], calculate each allocation segment separately and prevent double counting.
- Calculations are versioned and recalculated when an authorised correction occurs; previous results are kept.

### 5.10 Service interval monitoring

#### 5.10.1 Defaults

- Interval: 15,000 km.
- Early tolerance: 1,500 km.
- Late tolerance: 1,500 km.
- Early warning: 13,500 km since the last verified service.
- Target: 15,000 km since the last verified service.
- Maximum tolerance: 16,500 km since the last verified service.

The tolerance is a manufacturer-permitted operating range, not the preferred service booking target. The system recommends arranging service by the target.

#### 5.10.2 Calculations

**Next service odometer = last verified actual service odometer + applicable service interval.**
**Early warning odometer = next service odometer − early tolerance.**
**Late tolerance odometer = next service odometer + late tolerance.**
**Distance since service = latest accepted operational odometer − last verified service odometer** (on lifetime kilometres where an adjustment has occurred).

Example:
- Last verified service: 82,400 km.
- Early warning: 95,900 km.
- Target: 97,400 km.
- Maximum tolerance: 98,900 km.

The calculation is based on the actual verified service odometer, never a rounded milestone. A service done late at 99,500 km sets the next target at 114,500 km.

#### 5.10.3 Status bands [DEC-10]

Proposed canonical statuses (kilometre basis, default interval):

| Key | Label | Condition | Action |
|---|---|---|---|
| baseline_required | Baseline required | No verified service record | Capture and verify baseline |
| normal | Normal | Distance < 13,500 | — |
| approaching | Approaching service | 13,500 ≤ distance < 15,000 | Book service now |
| due | Service due — within late tolerance | 15,000 ≤ distance ≤ 16,500 | Urgent; escalate to branch manager |
| overdue | Overdue — critical | Distance > 16,500 | Escalate to senior management |

Additional flags shown alongside the status:

| Key | Label | Condition |
|---|---|---|
| awaiting_verification | Service recorded — awaiting verification | A service record exists after the baseline but is not yet verified |
| data_quality_review | Data quality review | Latest reading is disputed, provisional or stale |

The v1.1 "Service due" and "Within late tolerance" statuses are merged into one band because no boundary between them was defined. If two bands are preferred, the boundary must be decided under [DEC-10].

#### 5.10.4 Time-based intervals [DEC-11]

Where a time interval applies:
- Due date = last verified service date + interval days.
- Early warning date = due date − early tolerance days (proposed 30).
- Late tolerance date = due date + late tolerance days (proposed 30).
- The time status uses the same band keys.
- The **effective status is the more severe** of the kilometre status and the time status.

#### 5.10.5 Configuration and precedence [DEC-19 — Approved]

- Support vehicle-specific, manufacturer/model, category and company-default configurations.
- Precedence (approved): vehicle-specific → manufacturer/model → category → company default.
- The configuration in effect today applies to the current service cycle; changes are effective-dated and audited.
- Every override records vehicle, previous setting, new setting, reason, authorised user, approver, timestamp and supporting evidence where required.
- Tracking of alternating minor/major service types is a later-phase item [DEC-11].

#### 5.10.6 Verified service records (MVP)

The MVP includes minimal service record capture:
- Vehicle, actual service date, actual service odometer, service type, workshop name, job card or invoice reference, evidence attachment, cost (optional in MVP).
- Status: recorded → verified, or rejected.
- Verification by a different authorised user [DEC-24].
- Only a verified record sets or resets the baseline. A booking, quotation or driver report never does.
- The service odometer is cross-checked against accepted readings around the service date; inconsistencies are flagged.

#### 5.10.7 Initial baseline onboarding (MVP) [DEC-20 — Approved]

At go-live, each vehicle needs:
- An opening odometer reading (from its first accepted pre-shift reading, or an onboarding reading with photo).
- Its last service date and odometer, with evidence (invoice, job card or service-book photograph), recorded with source `historical_import` and verified by a maintenance administrator.

Vehicles without acceptable evidence show **Baseline required** until a verified service record exists. Baselines are never invented.

### 5.11 Notifications

Provide configurable notifications for:
- Approaching service; service due; overdue service.
- Missing service baseline; service awaiting verification.
- Odometer exception created; exception awaiting approval (with ageing).
- Missing or late inspections.
- Unaccounted distance detected.
- Incident reported.
- Later phase: maintenance booking or work-order updates.

Recipients are configured per event type, role and branch. Alerts previously addressed to an "Operations manager" go to the Branch manager [DEC-32 — Approved].

Notifications must support:
- In-app alerts in the MVP; email when a provider is approved [DEC-28].
- Acknowledgement.
- Escalation rules with configurable delays [DEC-28].
- Duplicate prevention (one alert per vehicle, threshold and service cycle).
- Notification history.

Do not send repeated alerts on every page load or every odometer update.

### 5.12 Damage register and incident management

**Known-damage register (MVP):**
- Each vehicle has a register of known damage: location/zone on the vehicle, description, photos, first reported inspection, status (reported → verified → repaired, or disputed).
- Drivers see the register during inspections and report only damage not already listed.
- New damage found at a pre-shift inspection that was not present at the previous post-shift inspection is flagged for investigation of the interval between them.

**Incidents (MVP basic):**
- Record incident type, date/time, description and circumstances.
- Link to vehicle, driver, allocation, inspection and damage items.
- Upload supporting photographs.
- Categorise severity.
- Assign an investigator; record findings, corrective actions, approval and closure.

The platform must distinguish reported damage, AI-suggested damage (later phase) and verified findings.

AI image analysis may identify possible damage but must not independently determine fault or liability.

### 5.13 Fuel management — planned module

Support future:
- Fuel transactions and fuel cards [DEC-33].
- Vehicle and driver linkage.
- Litres, costs, transaction dates.
- Odometer at refuelling.
- Supplier and station.
- Fuel-efficiency calculations.
- Exception detection.

Imported transactions are staged, validated and matched before entering confirmed reporting. Do not present misleading consumption figures where refuelling or mileage data is incomplete.

### 5.14 Maintenance and suppliers — planned module

Builds on the MVP service records (§5.10.6) to support:
- Preventative maintenance schedules for maintenance types other than the primary service.
- Work orders and service bookings.
- Repair jobs.
- Suppliers and workshops.
- Quotes, purchase orders where applicable, invoices.
- Labour and parts costs.
- Downtime.
- Maintenance history.

A verified service record must include actual service odometer, service date, service type, supplier/workshop and supporting job card or invoice evidence where available.

### 5.15 KPIs and analytics

Provide reporting for:
- Vehicle utilisation.
- Kilometres travelled (confirmed vs provisional).
- Unaccounted kilometres.
- Service compliance.
- Overdue maintenance.
- Vehicle downtime.
- Maintenance cost per vehicle; cost per kilometre (later phase).
- Fuel consumption where reliable (later phase).
- Damage and incident frequency.
- Inspection completion and lateness.
- Odometer exception rate; no-photo reading rate.
- Branch performance.
- Driver operational performance.

Driver KPIs must be contextual and fair. Do not automatically interpret high mileage, damage reports, unaccounted distance or anomalies as driver misconduct.

Every KPI must have a documented definition, calculation, time period, source data and data-quality qualification [DEC-30]. The MVP reports only the operational metrics needed for the MVP dashboard; the full KPI catalogue is a later phase.

### 5.16 Continuous improvement — planned module

Support Lean Six Sigma and operational improvement through:
- Identifying recurring operational problems (e.g. Pareto analysis of exception types).
- Root-cause analysis.
- DMAIC improvement projects.
- Corrective and preventive actions.
- Assigned owners and due dates.
- Baseline and target measurements.
- Verified savings.
- Control plans.
- Results tracking.

Do not claim savings without a documented baseline, calculation and verification method.

### 5.17 Audit trail and approvals

Record important actions including:
- User, role and permission changes.
- Vehicle, driver and branch-transfer changes.
- Allocation creation, amendment and status transitions.
- Inspection submission and voiding.
- Odometer reading submission, acceptance, review, correction and adjustment.
- Validation setting changes.
- Service configuration changes.
- Service record creation and verification.
- Incident investigation and closure.
- Approval decisions.
- Issue of access to private evidence.

Audit events record actor, action, entity, timestamp, relevant before/after values and reason where applicable.

Historical evidence must not be silently overwritten or hard-deleted.

## 6. Non-functional requirements

### Security
- Driver authentication: employee number + PIN [DEC-08 — Approved]. PINs are issued and reset by authorised supervisors or administrators, never visible to them after issue; the driver must change a temporary PIN at first sign-in; repeated failed attempts lock the account temporarily; PIN rules (proposed: 6 digits, no trivial sequences) are configurable.
- Office and management user authentication [DEC-34 — Approved]: email + password, with multi-factor authentication required for administrators and anyone holding approval permissions.
- Drivers use company-issued phones, one per driver [DEC-08 — Approved]. Shared-device session handling is not required for MVP.
- Role-based and branch-level access driven by the permission matrix.
- Server-side authorisation and database Row Level Security.
- Segregation of duties for approvals.
- Private image storage with short-lived signed access.
- Audit logging of changes and evidence access.
- Secure environment variable handling.

### Reliability
- Data integrity constraints.
- Safe retry behaviour on weak connections.
- Idempotent submissions (a repeated submit never creates a duplicate).
- Error handling with clear recovery steps for drivers.
- Backup and tested recovery.
- Migration discipline.
- Connectivity approach [DEC-06]: proposed online-only with robust retry for MVP, validated at the pilot branch.

### Performance
- Efficient queries and appropriate indexing.
- Pagination for large datasets.
- Display derivatives (thumbnails) generated separately; originals preserved.
- Background processing for OCR, scheduled checks and notifications.
- Inspection screens usable on mid-range phones.

### Usability
- Mobile-first driver workflows.
- Simple inspection screens.
- Clear error messages.
- Accessible controls.
- Responsive management dashboards.

### Privacy and compliance (POPIA)
- Purpose-limited collection and access.
- Driver notice that inspection photographs and readings are captured and how they are used.
- Company phones are company devices; any device management (e.g. MDM) is a company IT decision outside FleetIQ.
- Photos may incidentally include people or third-party vehicles; access is restricted accordingly.
- EXIF GPS stripped in MVP [DEC-29].
- Data residency [DEC-25 — Approved]: all personal data and evidence are stored and processed in South Africa. Any later provider (OCR, email, monitoring) must also process data in South Africa or be separately approved [DEC-26, DEC-28].
- Outview hosts and operates FleetIQ for the company: a written POPIA operator agreement (security safeguards, confidentiality, breach notification) is required before go-live.
- The user's manager is informed of the POPIA position (driver notice, operator agreement, data residency).
- Retention periods set by company policy and legal requirements [DEC-27].
- Information Officer sign-off before go-live.
- Auditability of access and changes.

### Capacity planning
Indicative photo volume (to be validated): 200 vehicles × ~2 allocations/day × (2 odometer + ~4 condition photos) ≈ 2,400 photos/day. At ~300 KB per app-captured photo ≈ 0.26 TB/year; at ~1.5 MB per full camera file ≈ 1.3 TB/year. Storage cost and retention must be planned from these figures.

## 7. MVP scope

### MVP must include
1. Authentication and user management.
2. Organisation, branches and departments.
3. Role and permission management, with segregation of duties.
4. Vehicle register with branch history.
5. Driver register with licence records and eligibility checks.
6. Shift management.
7. Vehicle allocations with lifecycle.
8. Mandatory pre-shift inspections.
9. Mandatory post-shift inspections.
10. Mandatory odometer photographs at both stages.
11. Reading capture, OCR extraction and driver confirmation workflow (manual path first; OCR added in a later MVP phase).
12. Odometer validation, exceptions, review, corrections and adjustments.
13. Mileage calculation from accepted readings, including unaccounted distance.
14. Minimal verified service record capture.
15. Initial service baseline onboarding.
16. Service interval monitoring (kilometre and time).
17. In-app service and exception alerts.
18. Known-damage register and basic incident recording.
19. Seeded, versioned inspection checklists per vehicle category.
20. Basic dashboard (§5.1 MVP tiles) and operational reports.
21. Audit history, including evidence access.

### Later phases
- Fuel management.
- Full maintenance, work-order and supplier workflows.
- Inspection template editor.
- Email and other notification channels (if not approved for MVP).
- Advanced AI damage assessment.
- Full KPI catalogue and cost analytics.
- Continuous-improvement module.
- GPS and telematics integrations.
- Route optimisation.
- Predictive maintenance.
- Automated driver messaging.
- Perceptual duplicate-image detection.
- Mid-shift handovers (if [DEC-02] defers them).
- Offline inspection capture (if [DEC-06] defers it).

## 8. Acceptance criteria for odometer, mileage and service monitoring

The MVP is not complete unless:

1. A driver can complete a pre-shift inspection with a required odometer photograph.
2. A driver can complete a post-shift inspection with a required odometer photograph.
3. Both readings are linked to the correct vehicle, driver, shift, allocation, inspection and stage, and the database rejects inconsistent links.
4. OCR extraction is recorded where available, separately from the driver reading and the accepted reading.
5. The driver can submit a reading, and the comparison with OCR is recorded.
6. An uncertain, unreadable or gallery-sourced reading is routed through a controlled exception process.
7. The auto-acceptance rule accepts only readings meeting every condition in §5.8.4.
8. Accepted readings calculate allocation kilometres correctly.
9. Unaccounted distance between consecutive allocations is calculated and flagged above tolerance.
10. Decreasing, implausible, duplicate and late readings are flagged.
11. Corrections create a superseding reading, preserve the original and full audit history, and trigger recalculation.
12. Odometer adjustments preserve lifetime kilometres for mileage and service calculations.
13. No-photo readings (if approved) are permanently labelled and excluded from photo-verified figures.
14. Current mileage feeds service interval calculations.
15. Service status uses the last verified service baseline only.
16. The 13,500 km, 15,000 km and 16,500 km default thresholds and the band boundaries are correctly applied, including exact boundary values.
17. Time-based service thresholds are applied and the more severe status wins.
18. Vehicle-specific service intervals override defaults through authorised, audited configuration.
19. Missing baselines, stale readings and disputed readings are clearly identified.
20. Unauthorised users cannot approve exceptions or alter protected records, and users cannot approve their own submissions.
21. Users cannot see other branches' records without permission.
22. Repeated submissions do not create duplicate inspections or readings.
23. The driver workflow works on mid-range mobile phones over a weak connection.
24. Automated tests cover normal, exceptional and permission-restricted scenarios.

## 9. Implementation roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| 0. Baseline & setup | Phase 0–1 decisions approved; v1.3 documents approved; permission matrix approved; hosting and Supabase approved; repository, CI, dev and staging environments | Pre-development gate (§10) passed |
| 1. Foundation | Auth, organisation/branches/departments, roles and permissions, RLS framework, audit triggers, private evidence storage with upload verification, signed URLs and access log | Cross-branch and cross-company access tests fail as expected; audit cannot be bypassed |
| 2. Registers | Vehicles and branch history, drivers and licences, service configurations with precedence, minimal service records, baseline onboarding | Every pilot vehicle has a verified baseline or shows Baseline required |
| 3. Shifts & allocations | Shift templates, shifts, allocation lifecycle, overlap constraints, eligibility checks | Overlapping allocations rejected by the database; lifecycle transitions tested |
| 4. Inspections (mobile) | Seeded templates, pre/post flows, in-app capture, condition photos, known-damage register, idempotent submission, late/missing detection | Driver completes both inspections on a mid-range phone over a weak connection |
| 5. Odometer — manual path | Driver-entered readings, validation engine and settings, exceptions, review queue, approvals, corrections, adjustments, no-photo path | Acceptance criteria met except OCR-specific items |
| 6. OCR integration | Provider adapter, background jobs, confidence, OCR-vs-driver comparison, auto-acceptance | Trial accuracy reviewed; OCR failure falls back cleanly to the manual path |
| 7. Mileage | Allocation distance, unaccounted distance, recalculation, odometer segments | Distance, gap, correction and adjustment tests pass |
| 8. Service monitoring & alerts | Status engine (km + time), status view, deduplicated alerts, in-app notifications, escalation | All boundary cases (incl. 82,400 example) tested |
| 9. Incidents, dashboard & reports | Basic incidents, MVP dashboard tiles, operational reports | Management sign-off on definitions |
| 10. Pilot & hardening | One pilot branch for 2–4 weeks; end-to-end tests; backup/restore test; POPIA review; UAT | Go/no-go for remaining branches |

## 10. Pre-development gate

Development (Phase 1) does not start until:

**Documentation**
- [x] PRD, Technical Architecture and Database Design v1.3 approved by the user (2026-11-17).
- [ ] Duplicate PRD removed from Project Knowledge (`01-FleetIQ-PRD-v1.2.md` is still present; to be deleted by the user in claude.ai).

**Decisions**
- [x] DEC-08, DEC-24, DEC-32 approved (2026-11-12).
- [x] DEC-34, AD-01, AD-05 approved (2026-11-17).
- [x] DEC-23 permission matrix approved (2026-11-17).
- [x] DEC-25 hosting approved: RSAWEB, South Africa only (2026-11-17).
- [x] Exception approved 2026-11-17: Phase 1 may be built and tested on local/CI Supabase with synthetic data only before the RSAWEB servers exist. Extended to Phase 2 (2026-11-17). No real company data until every remaining gate item is complete.
- [x] Validation threshold defaults approved (DEC-12, 14, 16–18) or explicitly deferred to configuration (DEC-13, DEC-15) (2026-11-17).
- [ ] Every other decision has an owner and a "needed by" phase.

**Security and compliance**
- [x] Permission matrix approved (2026-11-17).
- [x] Hosting and data region approved (DEC-25, 2026-11-17).
- [ ] POPIA operator agreement between Outview and the company signed.
- [ ] POPIA position confirmed: driver notice, manager and Information Officer informed (no cross-border processing under DEC-25).

**Environment**
- [x] Repository created (henfredpietersen/fleetiq, private); Phase 0 merged 2026-11-17. Branch + PR workflow; PRs are reviewed before merge from Phase 1 onward.
- [ ] RSAWEB staging and production servers provisioned (self-hosted Supabase, TLS, firewall, backups to RSAWEB backup service in South Africa).
- [ ] Secrets management agreed.
- [x] CI runs type-check, lint and unit tests (GitHub Actions, green on main 2026-11-17).

**Business inputs**
- [ ] Current paper inspection checklists per vehicle category.
- [ ] Vehicle list with category, make/model and manufacturer service schedule.
- [ ] Last known service date and odometer per vehicle, with evidence where available.
- [ ] Branch list, shift patterns and nominated pilot branch.
- [ ] 50–100 sample odometer photographs from real vehicles.

## 11. Approval and change control

This document is the approved version 1.7 product baseline (v1.3 approved by the user on 2026-11-17; v1.4–v1.7 record decisions approved the same day).

Approval of this document does not approve any Decision Register item still marked Proposed or Open; those remain configurable proposed defaults until decided individually.

Changes to approved requirements must be documented, versioned and traceable in the change log.

Do not remove mandatory MVP requirements without explicit user approval.

## 12. Decision Register

Status values: **Proposed** (recommendation awaiting approval) · **Open** (input needed, no recommendation) · **Approved** · **Rejected** · **Deferred**.

| ID | Decision | Proposed option | Status | Needed by |
|---|---|---|---|---|
| DEC-01 | Can a driver use more than one vehicle in a shift? | Yes, one at a time; each allocation has its own inspections | Proposed | Phase 3 |
| DEC-02 | Mid-shift vehicle handover between drivers | Not in MVP; schema ready for it | Proposed | Phase 3 |
| DEC-03 | Can a reading be accepted without a photo? | Yes, supervisor-witnessed, approved, permanently labelled, excluded from photo-verified figures | Proposed | Phase 5 |
| DEC-04 | Gallery/file uploads for odometer photos | Allowed, flagged and routed to review | Proposed | Phase 4 |
| DEC-05 | Driver reading entry | Blind entry, compared with OCR | Proposed | Phase 5 |
| DEC-06 | Connectivity | Online-only with retry for MVP; revisit after pilot | Proposed | Phase 4 |
| DEC-07 | Definition of the original photo | App-captured at ~1600 px, high-quality JPEG; never altered after upload | Proposed | Phase 4 |
| DEC-08 | Driver login method and devices | Employee number + PIN; each driver uses a company-issued phone | **Approved** (2026-11-12) | Phase 1 |
| DEC-09 | Post-shift inspection completed by someone other than the driver | Supervisor may, flagged and audited | Proposed | Phase 4 |
| DEC-10 | Service status bands | As in §5.10.3 | Proposed | Phase 8 |
| DEC-11 | Time-based tolerances; minor/major service alternation | 30 days early / 30 days late; alternation later phase | Proposed | Phase 8 |
| DEC-12 | Odometer precision | Whole kilometres | **Approved** as configurable default (2026-11-17) | Phase 5 |
| DEC-13 | OCR confidence threshold for auto-acceptance | Set after OCR trial; conservative start | Open — deferred to configuration (2026-11-17) | Phase 6 |
| DEC-14 | OCR vs driver tolerance | 0 km | **Approved** as configurable default (2026-11-17) | Phase 5 |
| DEC-15 | Maximum plausible km per allocation | Per vehicle category from operational data | Open — deferred to configuration (2026-11-17) | Phase 5 |
| DEC-16 | Unaccounted distance tolerance | 5 km | **Approved** as configurable default (2026-11-17) | Phase 7 |
| DEC-17 | Late inspection windows | Pre-shift +30 min after start; post-shift +60 min after end | **Approved** as configurable default (2026-11-17) | Phase 4 |
| DEC-18 | Stale reading age | 7 days on an active vehicle | **Approved** as configurable default (2026-11-17) | Phase 8 |
| DEC-19 | Service configuration precedence | Vehicle → manufacturer/model → category → company default; current config applies to current cycle | **Approved** (2026-11-17) | Phase 2 |
| DEC-20 | Baseline onboarding evidence and verifier | Invoice, job card or service-book photo; verified by maintenance administrator | **Approved** (2026-11-17) | Phase 2 |
| DEC-21 | Mandatory checklist items per vehicle category | Business to supply current checklists | Open | Phase 4 |
| DEC-22 | Licence validity at allocation | Block expired/unverified; warn + override on class mismatch | Proposed | Phase 3 |
| DEC-23 | Permission matrix | As in §4.2 | **Approved** (2026-11-17) | Phase 1 |
| DEC-24 | Segregation of duties | As in §4.3, no override | **Approved** (2026-11-12) | Phase 1 |
| DEC-25 | Hosting, Supabase approval and data region | Self-hosted Supabase + Next.js on RSAWEB cloud servers in South Africa; production at fleetiq.outview.co.za; data stays in South Africa; company-owned accounts, ≥2 admins | **Approved** (2026-11-17) | Phase 0 |
| DEC-26 | OCR provider | Trial two providers on 50–100 real photos; must process data in South Africa (DEC-25); check cost | Open | Phase 6 |
| DEC-27 | Retention periods for photos, evidence and audit logs | Company policy / legal input required | Open | Phase 4 |
| DEC-28 | Notification channels and escalation periods | In-app for MVP; email when an in-country provider is approved (DEC-25); escalation delays to be set | Proposed | Phase 8 |
| DEC-29 | EXIF GPS in photos | Strip on upload for MVP | Proposed | Phase 4 |
| DEC-30 | KPI definitions and targets | MVP operational metrics only; catalogue later | Proposed | Phase 9 |
| DEC-31 | Branch transfer approval | Fleet administrator approves; history kept | **Approved** (2026-11-17) | Phase 2 |
| DEC-32 | "Operations manager" role | Same as Branch manager; no separate role | **Approved** (2026-11-12) | Phase 1 |
| DEC-33 | Fuel data source | Later phase | Deferred | Later |
| DEC-34 | Office and management user login | Email + password; multi-factor authentication for administrators and approvers | **Approved** (2026-11-17) | Phase 1 |
| DEC-35 | Company device register | Record the issued company phone per driver and the device used for each submission (for accountability; not a block on submission) | Proposed | Phase 4 |
