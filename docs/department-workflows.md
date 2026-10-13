# Department care workflows

## Confirmed scope — 13 October 2026

The owner requested frontend and backend workflows for the healthcare departments used by the professional testing account. This connects the existing reception, GP/consultant, ward/nursing and patient experiences to laboratory, radiology and clinical pharmacy work. Billing/accounts and additional specialist departments were asked about separately; they are not silently included in this release.

## Existing care foundations retained

Reception registers or links a patient and manages arrival/routing. The assigned professional documents the visit, records observations, prescribes, requests consultant advice or transfers care, and records follow-up. Administrators open ward/observation episodes and assign responsible consultants/supporting teams; permitted physicians record admission/discharge decisions, nurses chart administrations and observations. These deployed workflows continue to use their existing permissions, patient-sharing rules and care-team gates.

## Implemented department flow

A permitted, reviewed general-care professional requests a named laboratory investigation, imaging study or pharmacy review from the patient's chart. Each request records patient, facility, branch, requester, priority, clinical reason and timestamp. Pharmacy requests reference an existing active signed prescription in that branch; the queue shows the original regimen and shared allergy context. Prescribing does not mean that supply has happened.

Laboratory: requested → accepted → collection/reference recorded → signed report → released report → clinical review. Signing requires a complete narrative including relevant measurements, units and interpretation; no invented normal ranges or automated diagnoses. Critical findings require a recorded communication/escalation account. A service can be scheduled and clarification requested/responded to. Decline/cancellation require a reason.

Radiology: requested → accepted → examination started → examination completed → interpretation → signed report → release → clinical review. Radiographer defaults permit examination work, not interpretation or release. A radiologist with reporting permission can take a completed examination for interpretation; the examination performer's events stay intact. Modality/examination references are recorded. Image acquisition, DICOM/PACS storage and remote image viewers are not implemented.

Pharmacy: active prescription → requested review → accepted → medication review → signed review → actual supply recorded. Supply requires actual quantity, unit, dispensing-system reference and counselling. The initial release records one supply event; releasing an amended review does not record a second supply. Repeated/partial dispensing, inventory, batches, sales and stock reconciliation remain RxLedger responsibilities and are not inferred from this record. There is no live RxLedger integration in this release.

Results appear in the patient record and a patient Tests & medicines worklist after department release. Professionals have a Department work queue, filtered by permissions, facility, branch and current patient access. Requesters can record clinical review and respond to clarification. Every action shows its time; signed report amendments retain previous signed versions and reasons and require release again.

## Authority and data boundaries

Migration 015 adds department_orders, append-only department_events and immutable department_reports. Mutations are transactional, lock the patient for competing department actions, use expected versions and client request IDs, and preserve audit records. Queue pages contain at most 50 orders; each order includes bounded history. The frontend retains failed form input and prevents older queue responses replacing the current filter.

New permissions: diagnostics.order; laboratory.work/report/release; radiology.work/report/release; pharmacy.review/fulfil. Reporting and release are independently configurable but require their prerequisite permissions. Laboratory and radiology have distinct reviewed scopes and explicit patient-sharing categories. Diagnostic-only default roles see their department records, not general/nursing/medication notes or clinical profile by default. Existing patient-selected grants are not expanded automatically.

An explicit department order authorizes only work on that ordered service, under current department permissions and patient contribution sharing. Department contributions do not require joining the inpatient general/nursing team, and do not confer any authority to prescribe, chart ward care or modify another department's notes. Ordering and clinician-review actions still use the ordinary care-team contribution gate. Current department/ward restrictions, membership suspension, branch boundaries and sharing revocation remain enforced for both queues and direct URLs.

New facilities get updated role defaults. Existing facilities receive unassigned Laboratory scientist, Radiologist and Radiographer defaults without expanding existing staff role permissions. Administrators review new capabilities for existing roles. Platform-approved individual testing access can be extended explicitly without changing the person's GP profession or granting administration.

## Verification status

Implementation includes integration tests for laboratory release/amendment, radiology scheduling/reporting, pharmacy supply, stale versions/retries, cross-facility denial, patient sharing, diagnostic-only scope and immutable report history. Local browser and production verification evidence is appended after those checks complete. No production clinical test data or real emails are required.

Local verification: the full existing-plus-department suite passed 160 checks with zero failures. An additional radiographer-to-radiologist permission/handoff scenario was then added; all six department scenarios passed again on both SQLite and embedded PostgreSQL. TypeScript, the production build and the new department component's lint passed. Browser checks completed GP request → laboratory collection/sign/release → patient report, radiographer examination → radiologist interpretation/release, and pharmacy review → actual supply, across 390px, 768px and 1440px with refresh and no page errors. Browser verification found and fixed the missing department route-search allowlist entry. Test data was synthetic. External instrument/PACS/RxLedger connections were not tested or claimed.
