# Named-professional access — implementation contract

Next slice, 11 October 2026. Implements the owner's named-professional sharing requirement. It does not enable primary-facility privileges, proxies, emergency release, unregistered external contributors or Rai redaction.

## Patient choice and migration

Existing patients retain the current facility-based policy until they deliberately enable **Only selected professionals**. Enabling it is one-way in this slice; it immediately overrides broad facility-registration and historical facility-consent fallbacks across clinical reads/writes. Operational registration/arrival demographics remain available to permitted facility staff. It preserves histories and patient links. A patient account is required to enable it for their own record; staff cannot claim an unlinked chart or opt a patient in.

The patient chooses an active reviewed professional by checking the facility code. Each professional identity is facility-scoped and displayed with facility/branch context. The first grant requires acknowledgement that only explicitly selected professionals will retain future clinical access. Grant creation and policy activation are atomic. Revoking the final grant leaves the patient in restricted mode, rather than silently restoring facility access.

## Grant scope

A root grant permits selected signed note categories (general, nursing, medication) and optionally the clinical profile (allergies and emergency contact). Each selected category includes whole signed notes and their retained versions; it does not conceal sensitive lines within a permitted note. Individual-note/line protection and Rai redaction remain future work. Basic identity (name, DOB, HealthPass ID) is available with a valid grant; other profile fields are omitted without profile scope. Drafts are always author-private. Versions, complaint previews, observations and follow-up text must obey the same scope; no hidden payload is returned.

Profile-edit authority must come from the same effective grant that includes the profile and valid contribution scope. Independent read-only profile and no-profile contribution grants cannot be combined to allow profile edits.

A separate contribute choice permits new records within granted categories AND the recipient's current reviewed role scope. Read-only grants do not permit profile changes, note creation/sign/amend, observations or follow-up writes. Clinical profile edits additionally require profile scope. Source records remain immutable/versioned and only their author can edit/sign/amend. All permission checks use current membership, expiry, branch, roles, verification and patient authority on each request.

A root grant expires within 90 days. Patient grant creation and professional delegation use stable client request IDs with exact-payload retry checking. Patient revocation disables future reads/writes, including author access, without removing previous signed records.

## Delegation

The patient may allow one-level delegation and separately allow delegation to another facility. Both default off. A granted professional may delegate only the same or narrower categories/profile/contribute scope, for the same patient and no later expiry. Only currently reviewed active professionals are eligible. Child grants cannot delegate again. Patient and delegator may revoke children; the patient sees recipient, facility, delegator, scope, purpose, status and expiry. Parent revocation/expiry or loss of the delegator's reviewed clinical authority invalidates child access immediately. Delegation never grants a new workspace membership, branch permission, global registry search, or visit assignment.

Named grants authorize permitted signed linked-visit notes as well as historical notes. Visit assignment is still required for the current visit's clinical actions. [Explicit same-facility handoff](care-handoffs.md) is now implemented in the subsequent slice. It requires existing contribution/source-reading authority and recipient acceptance; named sharing alone still does not transfer visit responsibility or another author’s draft.

## Contract shared between modules

Migration 009 adds patient_access_settings(patient_id, restricted, updated_at) and professional_grants with id, patient_id, recipient_user_id, recipient_organization_id, recipient_branch_id snapshot, grantor_id, parent_id, scopes_json, include_profile, can_contribute, allow_delegation, allow_external_delegation, purpose, expires_at, revoked_at, created_at, client_request_id, request_payload. Unique grantor_id/client_request_id. Historical follow-up tasks receive an unknown discipline; unrestricted care preserves them, while named-category views omit them until their provenance can be reviewed rather than guessing a category. New follow-ups require a reviewed contribution discipline. Use runtime SELECT/INSERT/UPDATE only, no deletion.

server/professional-access.mjs owns schema-related API/domain logic and exports:

- handleProfessionalAccess(tx, context) for route groups below (undefined otherwise).
- resolveProfessionalAccess(tx, actor, patientId) returning {restricted:boolean, grants:Array<{id,scopes:string[],include_profile:boolean,can_contribute:boolean}>, scopes:string[], includeProfile:boolean, canContribute:boolean, canEditProfile:boolean, contributionScopes:string[], grantId:string|null}. Resolution checks all current recipient/parent authority and branch constraints, so callers can trust this result. Patient self-handled by caller.
- listProfessionalPatients(tx, actor) returning bounded (max100) minimal patient rows for active effective grants; role registry.view+records.view still required by caller.

Routes (JSON web prefix /api/healthpass):

- GET /professional-access: patient {restricted,grants} with display-ready grant metadata; professional with ?patient_id=ID {restricted,grants} only actor's root/delegated grants and own outgoing children, with authority evaluated. No unrelated grant identities returned to professionals.
- GET /professional-access/options?workspace_code=CODE&patient_id=ID: patient checks own record; professional must hold active delegatable root for patient. Returns {facility:{id,name},professionals:[{id,name,branch_id,branch_name,clinicalScopes}]} bounded50, no emails/registration numbers; clinical eligible only, current parent external-facility permission enforced. Patient list uses their own identity without patient_id required.
- POST /professional-access: patient root {recipient_user_id,recipient_organization_id,scopes:['general'...],include_profile:boolean,can_contribute:boolean,allow_delegation:boolean,allow_external_delegation:boolean,purpose,expires_at,acknowledge_restriction:true,client_request_id}. Returns {id,restricted:true}.
- POST /professional-access/:id/delegate: root recipient only {recipient_user_id,recipient_organization_id,scopes,include_profile,can_contribute,purpose,expires_at,client_request_id}. Returns {id}. No child re-delegation.
- POST /professional-access/:id/revoke: patient for own grants or grantor for own outgoing delegated grants. Returns {revoked:true}.

The root integrator owns API clinical read/write enforcement, patient registry filtering, visit scope enforcement, db migration runner, types integration, docs and deployment. The backend module does not replace auth, registry, visits or existing consents itself. Frontend owns professional-access.tsx with exports PatientProfessionalAccess() and ProfessionalAccess({patientId,me,onChanged?}); root mounts them into Sharing and patient chart. Strong-session/permission helpers come from context; resolveProfessionalAccess independently checks effective role authority via resolveMembership.

## Verification and deployment

The automated suite includes seven named-access scenarios on both SQLite and embedded PostgreSQL: immediate facility-fallback removal, exact category/version filtering, no profile/draft metadata leakage, every read-only write denial, mixed-grant protection, one-level delegation narrowing/external limits, role/branch/parent expiry and revocation, and exact/concurrent retries. All 64 checks passed across function/proxy security and both database engines. Additional regressions cover literal-wildcard directory searches, accurate active-grant audit metadata, historical unclassified follow-ups and mixed-grant profile editing.

Local Chromium verification passed patient opt-in, persisted selected-only mode, default-off profile/contribution permissions, own chart access, narrower external delegation, no child re-delegation, patient-visible recipient/delegator history, child revocation and parent revocation. A 390px patient screen fits without horizontal overflow; refresh retains Sharing, and no browser errors occurred. TypeScript and the production build pass. Hosted Chromium/API verification passed against https://health-pass-psi.vercel.app using clearly labelled synthetic facilities, reviewed GP fixtures and a synthetic patient identity. Checks cover directory filtering, anonymous denial, category-limited root/child reads, recipient/delegator provenance, private-profile omission, mobile 390px layout and refresh, then parent revocation denying both professionals while restriction stays enabled. No clinical notes, observations or follow-up tasks were written to production.

Deployment checkpoint: frontend code 2e8915620e023369f5843e0406f254feb756ac2c, Vercel dpl_F6CUDMVhoD9wtvV5HyhugAKuxNPZ READY and assigned to the canonical domain; Neon API deployment 10 completed. Migration 009 was applied additively with SELECT/INSERT/UPDATE on professional_grants and patient_access_settings for the restricted runtime role. Production retains earlier signed/audit/visit immutability protections.
