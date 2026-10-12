# Clinical handoff contract

Next phase, 12 October 2026. Continues the outpatient visit and patient-directed access slices. A handoff changes responsibility, not consent, workspace identity, note ownership, or branch.

Within one facility/branch, the assigned professional may request handoff of an in-progress visit using their own signed linked note. No outgoing draft may remain unfinished. The chosen recipient must be active, credential-reviewed, permitted to document the visit, have current patient contribution authority for at least one reviewed category, and be able to read the source note category. Named grants must already exist: this action never creates or expands them. Cross-facility/branch transfers are not included.

The recipient explicitly accepts or declines. The outgoing professional remains assigned while pending. Request/accept/cancel/decline use visit versions and stable scoped request IDs where created. One pending handoff per visit. A pending handoff prevents completion; operational visit cancellation closes it atomically. Acceptance rechecks both professionals' current roles, branch and patient authority, the source signed-note version, absence of outgoing drafts, and the current visit version before switching assignee. Stale or revoked authority cannot transfer care. Request expiry is 24 hours, after which the sender may withdraw it or create a fresh request; expired requests never expand recipient clinical access.

Current assignee, accepted participants, and an eligible pending recipient may read the permitted visit clinical context and signed visit notes while retaining current patient/role authority. Former participants cannot create new visit notes/observations/tasks after transfer. They may amend their own signed note and complete/cancel their own follow-up task while their patient contribution scope remains valid. Signed-note corrections also remain available after visit cancellation; they preserve versions and do not reopen the visit or permit new/signature-completing care. The recipient cannot edit a predecessor's note, draft or task. Follow-ups remain author-owned; visible tasks carry author and discipline. Completion requires the current professional's own signed linked note, so a nurse's triage note cannot complete the consultant's work.

No shared drafts, implicit delegation, primary-facility privilege, emergency release, proxies or notification delivery are introduced. Historical uncategorized follow-ups stay hidden in named sharing. No free clinical handoff text is shown in operational queues; the source is the existing signed note.

## Module contract

Migration010 creates visit_handoffs(id,visit_id,organization_id,branch_id,from_user_id,to_user_id,source_encounter_id,source_version,status[pending/accepted/declined/cancelled],pending_key nullableuniquevisit,requested_visit_version,created_at,expires_at,resolved_at,client_request_id,request_payload,version default1). Mutable status uses guarded updates, immutable visit_events/audits record transitions. Runtime SELECT/INSERT/UPDATE, no deletion.

server/care-handoffs.mjs exports:

- handleCareHandoffs(tx,context) (undefined outside routes).
- visitParticipation(tx,actor,visitId): boolean current-assignee or acceptedfrom/to or livependingto, scoped org/branch, never clinical authority itself.
- participatingVisitIds(tx,actor,patientId): array of IDs for the same relationship, used by chart filtering.

Context provides existing {actor,path,method,body,searchParams,permit,strong,access,fail,text,audit,correlation} plus careAuthority(tx,currentResolvedProfessional,patientId,write): returns accessPolicy without requiring target to have an active login session. It never authenticates a target or issues sessions. Actual acting requests still require strong/permit. Fresh candidate memberships are resolved through resolveMembership.

Routes:

- GET /visits/:id/handoffs: permits visits.view; metadata-only list with names/status/source ID+version/times, no note payload. Response {handoffs,canRequest,canAccept,canWithdraw,sourceNotes:[{id,version,note_kind,created_at}],professionals:[{id,name,clinicalScopes}]}: sourceNotes/options only assigned professional with current clinical contribution authority, bounded50. Action flags can be perhandoff fields can_accept/can_decline/can_withdraw; topflags convenience. Recipient preview clinical context uses existing scoped chart/visit endpoints, never this metadata list. Only pending live recipient/source can act; stale inactive state should show actionable clear explanation.
- POST /visits/:id/handoffs {version,to_user_id,source_encounter_id,client_request_id}: {id,version} where version is new visitversion.
- POST /visits/:id/handoffs/:handoffId/accept|decline|withdraw {version}: {id,version} new visitversion; sourcewithdraw, targetaccept/decline only; current role/access checks, acceptfail409 ifsourcechanged; duplicateacceptalreadytransferred sameactor response stable without restoringauthority.

Backend agent owns only newmodule+migration010. Root owns API/context/schema integration/chart participant filtering/own amendments and docs/deployment. Visit agent owns server/visits.mjs changes for participant reads/author task updates/pending-completion guard/operational cancellation; newmodule owns all handoffroutes. Frontend agent owns new visit-handoff.tsx component plus VisitDetail types as needed; root mounts component and changes existing visits.tsx actions. Verification agent owns tests/care-handoffs.test.mjs. No other files concurrent-edited.

## Verification

The complete function/proxy/foundation/workspace/named-access/care suite passes 76 checks across SQLite and embedded PostgreSQL. Six handoff scenarios cover real nurse-to-GP scope differences, signed-source ownership, drafts, current consent and role/branch authority, expiry, decline/withdrawal, cancellation, retries and concurrent clinical writes. A PostgreSQL-only ordering failure found in recipient preview was fixed before deployment.

The same six handoff cases also passed on an isolated PostgreSQL 17 server with multiple pool connections, including concurrent acceptance against outgoing draft, amendment and observation writes. Every test used a separate empty database with synthetic fixtures; databases and the temporary container were removed afterward. Runtime clinical/handoff writes lock the visit first, then check current assignment and source records, so the transfer and clinical writes serialize without a semantic version change for the lock.

Local Chromium verification passed the full named-access nurse-to-consultant journey: signed nursing source, pending request with unchanged responsibility, permitted recipient preview, explicit mobile acceptance, former assignee new-write controls absent, consultant’s own general signed note, completion and refresh preserving handoff history. The 390px screen has no horizontal overflow or browser errors. Hosted verification follows canonical deployment. The optional live database test harness refuses non-loopback servers; use HEALTHPASS_TEST_ENGINE=postgres-live and HEALTHPASS_TEST_POSTGRES_URL only with a disposable local PostgreSQL instance. It creates and removes isolated hp_test_* databases, not production schemas. Normal npm test continues to use SQLite/PGlite.
