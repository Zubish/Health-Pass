# Workspace roles and access — 11 October 2026

Confirmed owner decision: each facility manages its own job roles and app permissions. The creator is its administrator. Job title is separate from clinical authority; operational permissions are configurable, while clinical capabilities require a recorded professional credential and scope review. Zed Tech Health Services provides ecosystem IT support through facility-approved, limited, expiring access.

## Available role templates

| Template                                    | Current default access                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| General practitioner                        | Registry/registration, clinical records, patient-context review, own general-practice note drafts, signing/amendments, own activity |
| Nurse / midwife                             | Registry/registration, clinical records, patient-context review, own nursing/midwifery notes, signing/amendments, own activity      |
| Pharmacist                                  | Registry, clinical records, own medication-review notes, signing/amendments, own activity                                           |
| Pharmacy technician                         | Patient registry only; no clinical chart or prescribing authority                                                                   |
| Receptionist                                | Patient registry/registration and own activity; no clinical chart                                                                   |
| Workspace administrator                     | Workspace, branch, staff and role management; facility audit; no implicit clinical chart                                            |
| Accountant, Cashier, Business developer, IT | Job titles with no app permissions until applicable tools or explicit operational permissions are assigned                          |
| Zed Tech support                            | Workspace information only; operator-verified provider identity and expiring facility grant required                                |

A legacy clinical template preserves existing verified general clinical membership during migration. Administrators can edit templates, create named custom roles and assign multiple roles to a member. A role with no permissions remains a job title; the account sees an explicit no-app-permissions message. Prescribing, dispensing, stock, payments, aggregate business reporting, exports and finance are not implemented capabilities and cannot be granted through invented permission keys.

## Configuration and enforcement

Workspace settings now show Job roles & permissions and reviewed staff access forms. Available permissions distinguish registry viewing/creation, record reading, patient-context review, note creation/editing/signing/amendment, personal/facility audit, and workspace/branch/staff/role management. Required permission dependencies are enforced by both the UI and API. Disabling or editing a role affects subsequent API requests, including existing sessions; permissions are not frozen into a login cookie. The UI refreshes on reload and throttled authenticated user activity.

Clinical role creation does not verify a person. Staff assignment requires an identity review, and clinical roles additionally require a separate confirmation and clinical review reference. Reviewed scopes are general practice, nursing/midwifery and medication review. Editing an operational role to add clinical capabilities cannot silently grant unreviewed staff clinical access. General-practice, nursing and medication notes are tagged with their discipline; create/update/sign/amend must match the author's reviewed scope. Professionals may only edit/sign/amend their own notes. Read access continues to require the original facility/branch relationship or patient sharing grant. This implementation does not interpret free-text clinical content, establish licensing automatically or activate the later individual/proxy/Rai access policies.

The creator retains administrative capabilities even if an administrator template is edited or disabled. Another authorised administrator must review the creator's personal clinical roles; users cannot review their own access. The creator cannot be suspended through staff role management. Other role managers do not receive creator immunity. Audits retain role changes and membership assignments, including permission/scope details; signed clinical snapshots remain immutable.

Staff management keeps disabled assigned roles visible so administrators can remove them before saving a replacement. Expired grants display their expiry and an Access expired status; suspended memberships are distinguished from pending approvals. Choosing Zed Tech support clears other roles, and choosing a regular staff role clears support, matching the server's exclusive-support rule. Saved membership changes refresh the review form, including branch and expiry fields.

## Zed Tech support

Facility IT titles do not establish Zed Tech employment. Only the platform operator can verify provider staff identity using the private server CLI:

```sh
npm run verify-support -- --user-id USER_ID --review-reference REVIEW_REFERENCE --confirm-zed-tech-employment
npm run verify-support -- --user-id USER_ID --review-reference REVIEW_REFERENCE --revoke
```

The command requires the existing professional's facility-scoped user ID and the operator's configured database connection; it does not print credentials. It records the identity review or revocation. A facility administrator then approves the Zed Tech support role with an expiry within 24 hours and a branch/identity review. Support cannot be combined with other roles and cannot be edited to include clinical permissions. Access is limited to workspace information; member identities, clinical charts, patient registry and facility audit are unavailable. Expiry and provider-identity revocation are checked on each request. Grant audits record the expiry. Separate authorised patient-record release for troubleshooting remains a future workflow; this implementation provides no support route to patient records.

## Migration and verification

Migration 005 adds workspace_roles and membership_roles, reviewed clinical scopes, creator designation, access expiry, operator support verification and encounter note_kind. Existing creators are identified by workspace.created audits, with a single legacy administrator fallback where no creator audit exists. Existing clinical authority is retained only for already verified clinical memberships. Existing user IDs, credentials, branches, notes and audit history are preserved.

Run migration with the controlled migration identity. Runtime requires SELECT/INSERT/UPDATE on workspace_roles and SELECT/INSERT/DELETE on membership_roles; existing table grants cover the additive columns. No new clinical-record delete or audit/signed-note mutation grants are needed.

Validation: 36 integration checks across SQLite and embedded PostgreSQL, typecheck and production build. Added checks cover default roles, custom roles, multi-role assignment, tenant isolation, unsupported/dependent permissions, live revocation, creator retention, clinical review and note scopes, own-note signing, provider identity, temporary grants and support expiry. Browser verification covers role forms, dependency selection, staff approval, clinical review, nursing note creation/signing, permission changes and mobile layout. Hosted verification uses labelled synthetic staff/workspace metadata without adding clinical records.

Hosted verification exposed compressed role-settings responses being forwarded with stale compression headers. The web proxy now requests identity encoding and removes upstream content-encoding/content-length/transfer-encoding after fetch decodes the body. A real HTTP regression check forwards a Brotli-compressed large role payload through the proxy and confirms decoded JSON, status, cookies, Origin and request body remain correct.
