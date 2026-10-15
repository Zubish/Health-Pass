# Emergency proxies and patient-controlled sharing

CONFIRMED: patients may appoint an existing HealthPass user or their current primary care facility as an emergency proxy. Invitations require acceptance. The patient chooses record categories and separately accepts versioned emergency-sharing terms. Being a proxy grants authority to approve emergency sharing, not authority to read records. External SMS/email code recipients remain deferred.

## Implemented workflow

The new **Proxies & emergency sharing** page is available to patients and professionals because either identity can receive a personal proxy invitation. Patients appoint a person by exact account email; a professional recipient additionally requires the facility code so independently scoped identities are not confused. Facility appointments are restricted to the current primary care facility. Staff must have reviewed clinical authority and `emergency.approve` to respond on its behalf. Administrators assign this clinical permission to designated roles; administration alone is insufficient. Existing/new GP, consultant, legacy clinician and nurse templates include `emergency.request`, subject to individual denials and clinical verification. Approval permission is deliberately not assigned automatically.

An authorised requesting professional enters the exact HealthPass ID, selects an accepted proxy, requests a subset of the patient's permitted categories, explains the emergency and confirms the patient cannot consent and delay could jeopardise care. Requests expire after 24 hours without a decision. A proxy can approve or decline with a required reason. Approval is read-only for the named requester in the same facility and branch for one hour from approval. A new request and approval are required for extension; neither the requester nor facility administrator can extend it directly.

A facility proxy may authorise access when its own facility is treating the patient, as the patient explicitly accepted in policy `emergency-sharing-v1`. The requester cannot approve their own request: a different authorised clinician must respond. There is no single-person override. An external personal proxy also cannot approve their own request. Requests do not add routine sharing grants or alter care-team assignments.

The patient can revoke a pending/accepted appointment, immediately invalidating its active emergency access, or cancel an individual pending/approved request. Primary-facility changes invalidate an old facility appointment. Every record read rechecks appointment status, policy version, expiry, requester role/clinical authority, workspace/branch and the facility approver's current authority. A suspended approver or lost approval permission blocks further reads. Appointments cannot be edited into broader authority: revoke and create a fresh, explicitly accepted appointment.

## Record scope and interface

Scoped read-only emergency views expose signed note snapshots, prescribed medicines and administration events, released laboratory/imaging reports, discipline-specific observations/vitals and physician admission/discharge decisions. Allergy summaries require their own patient permission and request selection. Draft notes and unreleased reports are excluded. No write, delegation or normal-chart access follows from emergency approval. The requesting professional uses the dedicated **View approved records** action.

Category sharing may include sensitive information inside the selected notes. The policy explicitly says line-level redaction is not available; no AI filtering or special HIV/mental-health concealment is claimed. This limitation is shown before consent. Facilities see no emergency records merely because they are proxies; only the approved named requester receives the selected facts.

Proxy invitations, pending decisions and patient updates appear in the notification bell/sidebar counts. The patient can inspect a paginated history and mark only displayed events as read. History records request reasons, requested categories, actors, source facilities, timestamps, decisions, expiry and exact signed-version/structured-record IDs viewed. The setup guide now offers proxy setup.

## Evidence, security and operational limits

Migration 019 adds appointments, requests, append-only events, patient-scoped hash-chain heads and notification receipts. Transactions serialize decisions and revocations against the patient's evidence row. Database triggers reject evidence updates/deletion and prohibit changes to the original appointment/request payload; status transitions append new events. Runtime grants omit DELETE and omit UPDATE on evidence. SHA-256 links make event history tamper-evident; this is not encryption or protection from a database owner rewriting the database and its anchors.

Transport uses the existing HTTPS/TLS deployment and storage protection remains Neon-managed. No independent application encryption keys, end-to-end encryption, immutable external archive or disaster-recovery guarantee is claimed in this release. On 15 October 2026 the Neon project reported **21,600 seconds (six hours) of recovery history**, with no snapshot schedule. An attempt to configure daily snapshots retained for seven days was rejected: **“backup schedule creation is not enabled for this project.”** Longer protected backup retention and a restore drill remain an operational follow-up; implementation must not be described as independently backed up long-term.

## Setup card correction

The setup dialog inherited `.hp-shell { display:flex; min-height:100vh }`, laying its children in columns on desktop and defeating its intended height. It now explicitly uses block layout, zero minimum height and bounded vertical scrolling. Browser checks must assert the internal layout and child widths, not just the outer dialog box or page overflow.
