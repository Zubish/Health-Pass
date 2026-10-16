# Responsible consultants — owner-approved working contract

Confirmed 12 October 2026: the facility administrator assigns the consultant accountable for a patient's overall management, especially inpatient/ward care. A paediatrician may lead a child's care while other authorised GPs continue routine care. The GP handling a visit does not automatically become the overall lead.

## Scope update — 12 October 2026

The owner subsequently restricted new care-team assignment to actual inpatient/observation episodes and separated outpatient consultant referrals. Migration 013 links new responsibilities to recorded episodes; old ongoing responsibilities retain history and may be ended. The current workflow and individual/area restrictions are defined in [care-operations.md](care-operations.md). The original release description below remains a historical checkpoint.

## Implemented scope

An ongoing care responsibility is a separate object from an individual visit, primary care facility and patient sharing grant. It identifies the patient, facility, branch, responsible consultant, service, optional ward and care setting (inpatient or ongoing care). There is one active lead per patient per facility. Administrative reassignment or conclusion preserves the object and append-only history; a later new care period can have a new responsibility. Changing a ward/service or lead requires a reason and current version. Ending responsibility preserves records and individual visits; it is not a clinical discharge action.

`careteam.manage` is an operational permission granted to the workspace creator/administrator by default and assignable to applicable delegated roles. It permits only necessary registered-patient, branch and consultant assignment metadata. It does not permit clinical chart access. `careteam.view` is available to applicable clinical templates and custom roles; reception, pharmacy technicians and Zed Tech support do not receive it by default. Patients see their own responsibilities across facilities. Professionals see the permitted facility/branch roster. The role-filtered responsive side panel exposes these screens only when applicable.

A consultant must be an active verified professional in the same facility, cover the selected branch, have reviewed general medical scope, care-team view and clinical reading/documentation/signing permissions, and already have patient contribution authority in that scope. Administrators confirm that the reviewed credentials cover the chosen service and record a specialty-review reference. A job title, service label, patient's age or administrator status alone does not establish specialty qualification. Paediatricians can be represented by administrator-defined specialty roles with reviewed general medical scope and the relevant permissions. No external specialty credential registry or age-based clinical routing is claimed.

Creating/reassigning checks current roles, branch and patient permission on the server. Assignment creates no record grant and cannot override named-only patient restrictions. If authority is lost later, the responsibility/history remains visible with record access unavailable; the administrator must resolve the role/permission issue or reassign. Other GPs need their own roles, care relationships and patient permissions. Clinical notes and signed versions stay attributed to their authors; visit-specific documentation, observations, tasks and handoff rules remain unchanged. This feature does not grant consultants the right to edit someone else's signed note.

Consultant accountability is visible in the care roster and patient chart. This is the responsibility foundation for ward care, not a full bed/admission/discharge-management module or a claim of automated consultant co-signing. Additional ward workflows can build on it without replacing source records or patient controls.

## Persistence and safeguards

Migration 012 adds `care_responsibilities` and immutable, version-ordered `care_responsibility_events`. A facility/patient unique active key prevents two simultaneous leads. Creation uses an actor-scoped retry key and payload digest. Patient-row locking serializes creation, reassignment and ending; optimistic versions reject stale decisions. History stores the consultant/service/ward snapshot and specialty review reference, while responses omit credential-review references and retry internals. Each change also writes the existing append-only audit. Runtime permissions are SELECT/INSERT/UPDATE for responsibilities and SELECT/INSERT for events; no history mutation or deletion is needed.

Lists return bounded pages with explicit load-more controls; history shows the latest 100 events in version order. Consultant/patient selection is scoped and bounded to 100 entries in this first directory; larger facility directories need a paginated selection extension before rollout at that scale. No clinical case text belongs in ward labels, review references or administrative change reasons.

## Verification and deployment

Run `npm test`, `npm run typecheck` and `npm run build`. Dedicated checks exercise current consultant eligibility, administrator versus clinician authority, tenant/branch/patient tampering, named-only/readonly denial, other-GP care without replacing the lead or visit assignee, source ownership, stale/concurrent changes, retries, one active lead, and immutable history. Use synthetic fixtures only.

Apply migration 012 and restricted runtime grants before deploying the API, then deploy the frontend and verify the canonical app. Rollback must preserve consultant and care history; do not delete signed or audit data. Deployment evidence is recorded after verification completes.

### Verified release — 12 October 2026

Feature commit `2a8340c5f1359d04539f2ed3da2270dd17d0b2ca` is pushed and deployed at `https://health-pass-psi.vercel.app/`. The canonical alias points to READY Vercel deployment `dpl_6a7udxZjAGq5XCMebHZhbSDX6ndb`. Neon API deployment 13 completed, and migration 012 is applied with restricted runtime privileges and immutable event triggers.

The full suite passed 102 checks on SQLite/embedded PostgreSQL plus function/proxy checks. The final five responsibility cases also passed against a separate PostgreSQL 17 server with pooled connections; scoped patient-row locking, retry/version conflict and facility-wide uniqueness were exercised. Disposable test databases and the container were removed. TypeScript, production build and the new-component lint passed.

Local browser testing completed the synthetic child scenario: an administrator assigned a reviewed paediatrician, a different GP signed their own care while remaining the visit assignee, the overall lead stayed unchanged, and the chart displayed that consultant. Mobile ward updates, patient visibility, refresh, ending/history and preserved source authorship passed with no page errors or overflow.

Hosted tests used synthetic metadata only: administrator assignment/retry, independent GP visit ownership, no administrator clinical access, mobile patient/team and clinician chart visibility, current-access revocation without silent duty transfer, immutable history on ending and canonical refresh. No hosted clinical notes, observations, tasks or real emails were created. Successful covering-GP clinical documentation was tested locally, not claimed as a hosted clinical workflow. Synthetic visit metadata was cancelled after verification.
