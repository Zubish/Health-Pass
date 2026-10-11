# Patient linking and assigned outpatient visits

Implementation checkpoint, 11 October 2026. Applies the [product definition](product-definition.md) and [saved design principles](design-principles.md). This implements the first connected patient-registration and single-professional visit workflow, not the whole target product.

## Patient-issued facility registration

A patient opens Sharing & permissions → Connect a facility, checks the facility's workspace code, chooses an active branch and acknowledges the registration disclosure. The server creates a random one-use invitation valid for 24 hours; only its hash is stored. The code is displayed once and can be copied. The patient can inspect invitation status and revoke an outstanding invitation.

Reception or another professional with registry.create opens Patient registry → Link existing account. Review requires the code, the current workspace and branch, and an authenticated approved membership. Only limited identity data are returned. The staff member confirms the presented person's identity and records a review reference. Similar local records produce a warning and explicit duplicate-review requirement, not an automatic merge. Redemption atomically links the existing patient ID to the facility/branch and records the action once. Replay, wrong workspace/branch, expiry or cancellation cannot create a second registration.

This registers an existing patient account identity. It does not claim an older facility-created chart, reassign a chart's identity, or merge two people's histories. Matching name, DOB, email or phone is not proof of identity. A patient may connect the same identity to multiple participating facilities. Each facility contributes its own source-attributed care.

The registration disclosure describes the current facility-role access to that facility's records. Connecting does not share previous facilities' notes: that still requires the existing patient-controlled signed-history sharing flow. Patients may now opt into [named-professional access](named-access.md), which overrides facility-based clinical access. Primary-facility privileges, proxies and verified historical-chart reconciliation remain separate work.

## Today's work

Relevant clinical and reception role templates receive arrival-work permissions when their existing prerequisite capabilities permit them. Custom roles are not silently expanded. Administrators retain administration without automatic patient access; they can explicitly configure operational roles.

Today's work displays a bounded, branch-aware queue with patient identity, arrival time, visit status and assigned professional. It excludes complaint, note text, observations and follow-up content. Check-in selects a registered branch patient and an active, reviewed professional with visit-documentation authority. Patient lookup is scoped and bounded; no global record search is introduced.

The workflow is waiting → in-progress → completed, or cancelled. Assignment can be changed while waiting, with a version check; it cannot become an implicit clinical handoff after care starts. An assigned professional still needs existing chart access, action permissions and a reviewed clinical scope. Reception can route/cancel but cannot start clinical work, read observations, author/sign clinical notes or complete a clinical visit.

The assigned professional can start a consultation, record permitted general/nursing observations, create an own-discipline linked encounter using the existing draft editor, save and sign it, arrange a follow-up task and complete the visit. Completion requires a signed linked source note. Back to visit preserves the route context after documentation. Signing releases the existing signed patient view; no new release-policy engine is claimed.

Under facility-based access, linked consultation notes are visible to their author and the patient. In selected-professional mode, signed linked notes follow the patient’s named/delegated category scope; even authors require a current grant. Other clinicians' drafts are no longer returned by the chart API. The existing historical unlinked signed-record/facility-sharing policy remains in effect. The new visit model does not yet support a shared nursing-triage → consultant handoff; a single assigned professional can document their own reviewed discipline.

Observations use typed, bounded measurements and carry discipline, author and time. These are input validation rules, not a clinical decision-support protocol. Follow-up items have a due date, open/completed/cancelled state and version; they are per-visit tasks, not appointment booking or delivered reminders. Closed visits and cancelled workflows preserve clinical/source/audit history.

## Persistence and failures

Migration 007 adds patient_link_invitations. Migration 008 adds care_visits, append-only visit_events and visit_observations, versioned visit_followups, and optional encounter.visit_id plus draft-create retry metadata. Reviewed template roles are extended only where their existing registry/note prerequisites support the new tools; clinical credential scopes are unchanged.

Check-in, observations, follow-up creation and note draft creation accept scoped client request IDs. Matching retries return the original result; changed content under the same key returns a conflict. UI request IDs persist for the active attempt. Clinical input remains in memory on failure; saved drafts stay on the server. Optimistic versions prevent stale status/assignment/task/note writes. Internal original-request payloads are removed from chart responses so draft content cannot leak into signed patient views.

Visit routing and clinical history use the existing API transaction. Runtime needs SELECT/INSERT/UPDATE on invitations, visits and follow-ups; SELECT/INSERT on events and observations. Events/observations reject update/delete through database triggers. No additional signed-note/audit mutation or record deletion grants are needed. Apply both migrations with the controlled migration identity before deploying the API; schema changes are additive and records must not be rolled back by deletion.

## Verification

Fifty automated checks run across function security, compressed HTTP proxy behaviour, SQLite and embedded PostgreSQL. Seven care-workflow scenarios on each database cover invitation disclosure and code secrecy, tenant/branch checks, expiry/revocation, duplicate review, concurrent one-use redemption, no merging, bounded operational queues, reviewed assignment, current permissions and patient relationship, own-note confidentiality, signed completion, stale writes, retry conflicts and immutable history.

Local Chromium verification passed the complete patient-code → reception identity review/link → check-in → assigned consultation → observations → linked draft/sign → follow-up → completion journey. The patient, reception and clinician screens fit a 390px phone viewport; refresh retains visit context and there were no browser errors.

Hosted verification passed against https://health-pass-psi.vercel.app with explicitly labelled synthetic owner/reception/GP/patient accounts: invitation issuance/review/redemption, branch queue, reviewed assignment, reception clinical denial, clinician access, mobile rendering and refresh. The synthetic visit was cancelled afterward; no clinical observations or notes were written to production.

Deployment: frontend commit 296a010, Vercel dpl_7wXAsZrS7eYcRXBV1UNVB8CHvbqU READY and assigned to the canonical domain; Neon API deployment 9 completed; migrations 007–008 applied with restricted runtime grants and append-only event/observation triggers. No real patient fixture or clinical content is used.

## Subsequent work

Named-professional grants and one-level delegation are now implemented in a separate slice. Complete verified historical-chart linking and an explicit clinical handoff before transferring visit ownership. Then add patient-directed primary facility/proxy flows, structured prescriptions and RxLedger exchange, scheduling/remote care, results/referrals, contracted HMO workflows and evaluated Rai assistance according to the staged product plan. Do not present these as implemented simply because the queue and registry are available.
