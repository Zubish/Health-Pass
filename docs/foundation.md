# HealthPass foundation — working implementation

The product source is [healthpass-blueprint-v1.txt](./healthpass-blueprint-v1.txt), copied verbatim from Musa's 9 October 2026 specification. Its CONFIRMED, RECOVERED PROPOSAL, BUILD RECOMMENDATION and OPEN labels remain authoritative. This document tracks the implementation and decisions; it does not convert recommendations into approved production policy.

For the current product definition, user relationships, module inventory and proposed build order, read [product-definition.md](product-definition.md). The owner's reusable workflow and design approach is saved in [design-principles.md](design-principles.md), recovered from the inspected RxLedger skill library. Earlier implementation/deployment sections below are historical checkpoints: current account creation has three paths, authenticator protection is optional with remembered dismissal, custom workspace roles are implemented, and migrations run through 010. [Care workflows](care-workflows.md) add patient-issued existing-account registration and a single-professional outpatient queue. Later dated decisions supersede earlier mandatory-MFA and two-card descriptions.

## Current owner decisions — 10 October 2026

Musa confirmed there is no Nigerian hosting service available now. Use the existing Neon HealthPass project (`billowing-grass-83528069`, `production` branch) for ongoing development. Its current region is AWS US East (Ohio); do not describe it as Nigerian hosting. This decision supersedes the original blueprint's Nigeria-only hosting constraint for current development. A future infrastructure decision should be recorded here; obtaining a Nigerian provider is not a prerequisite for continuing the app.

The owner subsequently requested fixing live login, which was blocked by the missing API connection, alongside a landing-page revamp. This authorizes the hosted API/database connection and deployment required for the workspace. Unrelated infrastructure additions remain deferred. The original `hello.ts` is retained as a reference; `server/function.mjs` is the application API entry. Hosted connection details and verification are recorded below once confirmed.

Neon Auth and a private `uploads` bucket are provisioned. The current app still uses its own password sessions and professional MFA implemented in `server/api.mjs`; enabling Neon Auth does not automatically connect that service to the login form. No upload flow or AI Gateway is implemented in this slice.

Hosted connection work has applied additive migration `001`, including immutable signed-note and audit triggers, to the existing Neon production branch. The API uses the dedicated `healthpass_app` PostgreSQL role, created directly through SQL without inherited privileged role membership. It has no schema creation, role creation, database creation or row-security bypass permission, and cannot update/delete signed versions or audit records. Its only table-delete privilege is session logout. No seeded fixture identities or clinical histories were added. API deployment 3 is complete; hosted health and synthetic authentication checks pass. No real clinical records have been used.

## Implemented first slice

- Persistent opaque patient identity, optional DOB/contact, separate facility registration links. Shared phone/name never auto-merge records.
- Password accounts, HttpOnly expiring sessions, logout, active verified facility membership, and mandatory authenticator MFA for professional access.
- Patient self-registration. Facility administrators can create workspaces; staff setup under professional Sign in requires reviewed approval and MFA before care access. Operator provisioning remains available.
- Clinician and reception patient registry, scoped search results; administrators lack clinical chart access.
- Patient's own signed-record view, facility-local charts, and patient-issued, time-limited full-signed-history sharing grants for participating organizations. Cross-facility drafts are excluded; grants never allow source-note rewriting.
- Allergy unknown/reviewed/none-known distinctions, emergency contact context. This is not emergency break-glass access.
- Draft encounters with explicit server save, optimistic version conflicts, signing, versioned amendments and reason. Signed snapshots are immutable in the database. Hashes provide integrity digests; this is not a PKI signature service.
- Closing a changed note asks whether to keep editing or discard; closing is blocked while saving. Refresh/tab-close receives the browser's unsaved-work warning. Unsaved clinical content stays in memory, never browser storage; browser unload prompts are best-effort, especially on mobile.
- Append-only allowed/denied access/action audit. Patient activity is patient-scoped; facility activity is organization-scoped. Clinical text/passwords/secrets are excluded from operational logs.
- Responsive patient/provider workspace at `/workspace`, burgundy primary accents, slate/white foundations, supporting teal, blue and amber. Public landing-page links open the workspace.
- Public landing page explains the current care-record and sharing workflows, with a clearly labelled synthetic record preview, mobile navigation, provider onboarding guidance and FAQ. Create account opens `/workspace?mode=register` to choose Patient or Professional; the provider CTA opens the facility form directly. Sign-in opens `/workspace`. Prescription/result/partner integrations are identified as planned. No claimed real facility affiliations, unlimited interoperability or unsupported export/refill workflows.

## Stack decisions

Retain the existing React 19 / TanStack Start / TypeScript / Vite app instead of migrating to the blueprint's suggested Next.js stack. The framework choice was OPEN; keeping the existing router limits unnecessary migration.

A Node 24+ HTTP API is a modular application service under `server/`. PostgreSQL (`DATABASE_URL`) is the hosted database; Node SQLite is a local development/test convenience only and refuses production startup. The same first migration applies to both adapters; immutable triggers are engine-specific. `src/server.ts` forwards `/api/healthpass/*` to the private API origin and returns an explicit unavailable state when it is not configured. No direct browser database access and no frontend credentials.

The build uses the Vercel Nitro preset on Vercel and Node-server output locally; Lovable retains its own forced target. Vercel hosts the web entry and forwards API requests, not the persistent database. The prepared Neon Functions adapter runs the API next to PostgreSQL. Do not use a Vercel ephemeral filesystem as storage. The existing Vercel deployment is not proof this API or database is connected.

## Run with synthetic data

```sh
npm ci
cp .env.example .env
# Set a unique HEALTHPASS_DEMO_PASSWORD of at least 12 characters in .env.
npm run seed
npm run api
# In another terminal (Vite receives API configuration at runtime):
HEALTHPASS_API_ORIGIN=http://127.0.0.1:4100 npm run dev -- --port 3000
```

Requires Node 24+ (built-in SQLite). `.env` and `.data/` are ignored. The synthetic seed requires an empty database and is disabled in production. All fixture records are explicitly synthetic.

Accounts use the password chosen by the operator:

| Email                     | Scope                                           |
| ------------------------- | ----------------------------------------------- |
| doctor@healthpass.test    | Lagos clinician                                 |
| ibadan@healthpass.test    | Ibadan clinician, initially denied Lagos charts |
| reception@healthpass.test | Lagos registration only                         |
| admin@healthpass.test     | Lagos audit/operations only                     |
| patient@healthpass.test   | Adé synthetic patient                           |

On first professional login, add the displayed setup key to a time-based authenticator, then verify its code. Later sessions require a fresh code. Do not put the setup key in screenshots/source. An operator can create a first facility/account with `npm run provision -- --email EMAIL --name NAME --facility FACILITY --role clinician --verified`, supplying HEALTHPASS_PROVISION_PASSWORD through a private server environment. Omit --verified until external professional review is complete; pending accounts cannot log in. This CLI creates a new facility for each initial provision; further memberships require reviewed operator administration. It never reuses an organization based solely on an unverified name. No credential verification service is connected.

## Configuration

| Variable                   | Purpose                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| DATABASE_URL               | Private PostgreSQL connection string; required for production API                                                                            |
| PUBLIC_APP_ORIGIN          | Exact browser origin for CSRF checks; HTTPS required in production                                                                           |
| HEALTHPASS_API_ORIGIN      | Private API origin for the TanStack server proxy                                                                                             |
| HEALTHPASS_MODE            | Set `synthetic-development` for hosted development; this changes the visible workspace label, not production security controls               |
| HEALTHPASS_AUTH_KEY        | Server-only 32-byte hex AES-GCM key for authenticator secrets; required in production                                                        |
| HEALTHPASS_ORIGIN_SECRET   | Same private random secret (at least 32 characters) on web server and Neon API; rejects direct native-function requests before database work |
| HEALTHPASS_API_PORT / HOST | Listener, defaults 4100 / 127.0.0.1; use private network binding when separated                                                              |
| HEALTHPASS_SQLITE_PATH     | Development-only database file                                                                                                               |
| HEALTHPASS_DEMO_PASSWORD   | Local synthetic seed only                                                                                                                    |

Development applies migration 001 at startup. Production startup only checks its applied version. Run `npm run migrate` under a controlled migration identity before starting production, then run the API with a restricted role (no schema/trigger mutation). Run only one migrator. Configure encrypted database storage and a managed secrets boundary. Authenticator secrets are AES-256-GCM encrypted when HEALTHPASS_AUTH_KEY is configured, which production startup requires. The API credential must not be exposed to browsers. Session token hashes are stored, not raw session tokens. MFA code reuse is rejected. Keep the encryption key outside the database, use tightly scoped database access, and prepare key rotation/recovery before pilot use.

### Neon API connection

Deployment checkpoint: migration 001 is applied to the HealthPass production branch and API deployment 2 completed. The dedicated `healthpass_app` runtime role has no superuser membership, role/database creation, schema creation, or signed-note/audit mutation permissions. No clinical fixtures were seeded. Trusted runtime health verification returned HTTP 200 (`synthetic-development`, PostgreSQL); direct requests without the server secret and session reads without login returned HTTP 401. The hosted landing returned HTTP 200, while its proxy health endpoint returned HTTP 503 because its connection settings remain absent. Desktop and 390px mobile browser checks confirmed no horizontal overflow or page errors, and patient signup opens the registration form.

The owner corrected the production proxy variables in Vercel. Hosted health and synthetic registration, logout and correct-password login were verified successfully. The connector still lacks environment-variable management permission; API updates inherit existing private values. Preserve the native API secret check.

The `api` function source in `neon.ts` is now `./server/function.mjs`; `hello.ts` remains as the original setup reference. Supply `PUBLIC_APP_ORIGIN`, `HEALTHPASS_AUTH_KEY` and `HEALTHPASS_ORIGIN_SECRET` through private function environment variables; Neon injects a default `DATABASE_URL`; override it with the restricted runtime role connection string. Do not commit secrets. Apply the schema separately before deploying. The function forces production mode and disables runtime migrations, pools at most five connections per isolate, and uses Neon's pool lifecycle helper. Cold-start failures return a safe retryable response. Set `HEALTHPASS_MODE=synthetic-development` for this development deployment so the workspace does not imply an approved clinical pilot; production cookie, encryption and database protections remain enabled.

On the web server, set `HEALTHPASS_API_ORIGIN` to the native function origin and the matching `HEALTHPASS_ORIGIN_SECRET`. The proxy overwrites any browser-supplied origin-secret header and keeps user cookies and the exact browser Origin for session and CSRF checks. The native function requires the server secret before parsing a request or opening PostgreSQL. This shared secret authenticates the server hop; user access still requires the existing session, membership, MFA and sharing checks.

## API

`/api/healthpass` is the web-facing prefix. Responses are `no-store`. JSON mutation requests require the configured Origin. Core groups: `/auth/login`, `/auth/register`, `/auth/me`, `/auth/logout`, `/auth/mfa/setup`, `/auth/mfa/verify`, `/organizations`, `/patients`, `/patients/:id`, `/patients/:id/profile`, `/encounters`, `/encounters/:id`, `/encounters/:id/sign`, `/encounters/:id/amend`, `/consents`, `/consents/:id/revoke`, `/audit`.

Draft save/sign/amend take `version` and reject stale writes with 409. Signing can atomically save submitted note fields and create the immutable snapshot, so a network failure between save and sign cannot produce a hidden intermediate version. Grants support up to 90 days, for signed clinical history and new partner encounters, not exports or automatic patient linking. Partner access is checked on every request. Revocation does not erase signed historical care, but denies future partner reads/writes when no other permitted relationship remains. No realtime subscription exists in this slice.

Local care access uses an explicit facility registration relationship. This is a deliberately narrow pilot assumption, not the final per-practitioner assignment/purpose policy. Patient profile review stores current allergy context; detailed versioned allergy provenance and verified observations remain future work. No automatic duplicate resolution, NIN linkage, professional credential API, guardian/delegate or emergency bypass is claimed.

## Verification

```sh
npm test
npm run typecheck
npm run build
```

The API integration tests cover draft release, version conflicts, simultaneous signing, immutable note/audit triggers, MFA denial, patient/cross-facility ID tampering, reception/admin denials, consent grant/expiry/revocation, source-facility amendment denial, shared-phone identities, unknown data, origin checks, malformed DOB and logout. The suite runs against SQLite and an embedded PostgreSQL engine (PGlite), checking both query/trigger paths. Function checks cover rejection before database work, concurrent initialization, cookie forwarding and recovery after a failed cold start. Hosted PostgreSQL network/TLS, runtime-role restrictions and multi-process concurrency still require a controlled staging database before pilot release. No real clinical content should be used in tests.

## Hosted pilot and rollback

Before real patient use, review data locations for the API/database/logs/backups, clinical scope, consent wording, professional onboarding, membership/care assignments, MFA recovery, audit operations and restore. No managed Nigeria infrastructure or real clinical review was configured by this change. Authentication password recovery, email verification, self-service professional onboarding tooling, durable distributed abuse controls, managed key rotation/KMS and a session-management UI remain launch work. The current in-process attempt limiter is a local/one-instance mitigation, not distributed production protection.

Deploy the reviewed API/database first, then configure the web proxy and exact origin. Test the complete authorized and denied workflows using synthetic accounts. Back up before migrations and prove restoration. This first migration is additive; rollback the application commit while preserving patient/signed/audit tables. Do not delete clinical history or attempt to roll signed notes back by mutation. Restore only into an isolated reviewed environment before any controlled recovery.

Later slices: RxLedger prescription/fulfilment contracts, scheduling, telemedicine, results/referrals, HMO and Rai. Nothing in this slice signs prescriptions or connects a partner API.

## Account onboarding decision — 2026-10-11

The owner clarified that entering an existing facility workspace belongs to **Sign in**, not a separate “Join an existing workspace” account-creation option. Preserve this decision when designing the patient/professional account choice and facility onboarding. Implementation is authorized and recorded in [account-workspaces.md](./account-workspaces.md).

The owner also clarified that professional identities must not be rigidly global across facilities. A professional working at multiple facilities may use separate facility-scoped identities, with either the same email/password combination or different credentials in each facility. Do not require a single shared professional identity across workspaces. Workspace-aware authentication and identity isolation need design review before implementation. This supersedes the proposed mandatory single-identity model.

## Patient-directed access requirements — 2026-10-11

Owner-requested requirements for future design; not implemented or approved as final access policy:

- A patient can designate a facility as their primary care provider. That facility may have broader access than other facilities, within the information and privileges the patient explicitly chooses to share. Patients can also specify who may access privileged information.
- During emergencies, a caregiver or facility can contact the primary care facility to request release of privileged records necessary for treatment. The authorization, verification, scope and audit process for such releases remains to be designed; this requirement does not itself enable unrestricted emergency access.
- Patients can appoint proxies, such as a spouse, child, other relative or another person. A proxy phone number or email can receive an access code as an alternative route to obtaining authorized information through the primary facility. Proxy identity, authority, eligibility, scope, expiry and revocation need design review; receipt of a code must not be assumed to establish all those permissions.
- Access within a facility can be limited to particular professionals. A patient can select a named professional for partial or full access to their records, within applicable clinical and legal constraints.
- For a consultation, access should initially be limited to the consultant. The consultant may share access with other professionals inside or outside the facility through a scoped, authorized process. Delegation boundaries and patient controls remain to be defined.
- Future Rai integration should analyze records and redact sensitive information, particularly HIV status and mental-health information. The intended experience allows otherwise authorized professionals to read the permitted view without repeated permission requests, while protected/redacted lines require additional permission. This is a future product requirement, not an assertion that AI redaction is reliable or an authorization to bypass baseline access checks. Redaction, derived-data leakage, review, enforcement and consent policies require design before implementation.

These requirements refine the earlier external-contribution discussion and the current facility-level access assumptions. Preserve them in the working blueprint and resolve policy details before changing clinical access behavior.

## Implemented account/workspace slice — 2026-10-11

See [account-workspaces.md](./account-workspaces.md) for inspected RxLedger mechanics, account forms, facility-scoped identities, Sign in access setup, reviewed membership approval, branch enforcement, migration 002 and tests. The subsequent patient-directed access and Rai requirements above remain saved for their own implementation.

## Confirmed account UX correction — 11 October 2026

The owner superseded the earlier first-time access setup inside Sign in: **Create account** offers three cards, Patient, Professional and Facility. Professional registration collects personal/professional details and the existing facility’s workspace code; its action is **Request access**. Facility creation creates the workspace and branches with an administrator identity. **Sign in** offers Patient and Professional only, since a facility is not a user. Professional sign-in checks and displays the selected facility using its workspace code before proceeding. Preserve “Already have an account? Sign in”; remove “Existing facility workspace? Sign in”. Facility-scoped independent credentials and reviewed membership requirements remain in force.

## Confirmed optional authenticator decision — 11 October 2026

The owner removed compulsory authenticator verification. Users must be able to **Skip for now** and continue after password authentication and the applicable facility/membership checks. This supersedes earlier requirements for mandatory professional TOTP. Facility creators are active administrators of their own workspace and do not require a separate staff access request or approval. A separate ecosystem authenticator application, working like a regular authenticator, is planned for later. HealthPass retains optional TOTP support for that future integration; the separate app is not part of this implementation.

## Confirmed authenticator prompt preference — 11 October 2026

The optional authenticator screen uses Continue and a Don't show this again checkbox, with no Sign out action on that screen. Continuing without the checkbox skips only the current session. Checking it saves the preference to the professional's facility membership, so later sign-ins and other devices bypass this optional prompt in that facility. Other facility identities keep independent preferences. It does not mark authenticator verification complete or bypass password, membership, expiry, permission or credential checks. Migration 006 adds the membership preference; the skip event records the choice in the audit. Workspace HTML is returned with no-store to avoid caching older onboarding pages.

## Confirmed workspace role and support decisions — 11 October 2026

Each workspace supplies common healthcare job-role templates and lets its administrator create/edit roles and assign applicable app permissions. Defaults include general practitioner, nurse/midwife, pharmacist and pharmacy technician. Operational roles such as accountant, cashier, business developer and IT may be added; a job title alone does not imply usable app permissions. Operational access is configurable, while clinical authority requires reviewed professional credentials and scope. Zed Tech Health Services provides ecosystem IT support through verified provider identity and facility-approved, audited, expiring operational access, without automatic patient-record access. See [workspace-roles.md](./workspace-roles.md) for implemented capabilities and the boundaries of currently unavailable modules.

## Implemented named-professional access — 11 October 2026

Continuation of the agreed staged build implements patient opt-in to Only selected professionals, named reviewed facility-scoped recipients, whole signed-note categories, separately selected clinical profile, read-only versus reviewed contributions, and optional one-level delegation. Scope/expiry cannot expand; parent revocation, expiry, clinical-role or branch changes invalidate children immediately. Clinical reads/writes use current authority and selected mode disables prior facility/consent fallbacks, including author access without an active grant. Operational registration and arrival demographics remain available under workspace roles. Revocation preserves clinical and audit history and never restores facility-wide access implicitly.

These are implementation boundaries for this slice, not a claim that primary-facility privileges, proxy/emergency release, unregistered external contribution or AI line redaction are settled. There is no automatic visit handoff or editing of another author's drafts. See [named access](named-access.md) for the complete scope, migration 009, UI and verification contract.

## Implemented explicit care handoff — 12 October 2026

[Care handoffs](care-handoffs.md) add a request/review/accept lifecycle within one facility/branch. The outgoing assigned professional signs their own source note and stays responsible until the permitted recipient accepts. Current patient grants and reviewed roles determine both source viewing and new contribution; handoff does not expand sharing. Past participants retain permitted signed history and their own correction/task responsibility, with drafts private and new visit care reserved for the current assignee. Completion requires that assignee's own signed note. Pending or expired requests must be explicitly resolved before completion; cancellation closes requests while preserving care and correction history. Migration 010 records the lifecycle and guarded transitions.

## Facility registration and primary care decision — 2026-10-12

The owner approved [patient-onboarding.md](patient-onboarding.md): unique patient email identities, facility-created provisional profiles and verified invitation claiming, private existing-account registration requests, optional profile-context sharing, and primary-facility acceptance/decline except for the first registering facility. This supersedes earlier descriptions of primary care as entirely planned. Primary designation does not create clinical authority. Independent professional facility identities remain unchanged. Proxies and emergency release remain later work.

Migration 011 and the email-delivery adapter are part of this slice. The hosted API has no configured patient email sender; the app must state that an invitation has not been sent and permit a fresh resend when delivery is connected. Do not describe independent legacy/self-signup emails as verified or historical unrelated charts as claimable.

Deployment verification: frontend feature `d268761` is live at the canonical alias, Neon API 12 completed, and migration 011 is applied. The 92-check suite, eight separate PostgreSQL concurrency cases, mobile browser flow and hosted synthetic metadata checks passed. See the detailed verification and unsent-email boundary in [patient-onboarding.md](patient-onboarding.md).

## Responsive side panel — 2026-10-12

Owner requested adapting RxLedger's side panel for every HealthPass user. The workspace shell now provides a fixed 252px desktop panel with a remembered 80px compact rail, and a modal drawer below 1024px for phones/smaller tablets. Patient navigation and professional role-filtered destinations remain distinct. This changes navigation presentation, not clinical authority, account behavior or API permissions. Facility/branch context and account identity remain visible; drawer navigation closes on smaller screens, desktop layout persists, and URL-based back/forward/refresh behavior is retained.

Local verification passed for patient, clinician, receptionist, administrator and a limited pharmacy-technician account across 320×740, 390×844, 768×1024, 844×390, 1024×768, 1440×1000 and 2560×1440 (35 role/viewport combinations). Checks covered permitted menu sets, drawer focus containment, Escape/outside closure and focus return, resize cleanup, desktop collapse/persistence, full-height side-panel scrolling, URL back/forward/current destination and page overflow. The limited-role account's clinical/administration API requests remained denied. No browser errors were found. TypeScript, production build and lint for the new navigation component passed. This UI slice does not change the backend or require a database migration.

Side-panel deployment verification: feature commit `7e0cd7d31b15fc5b428e81a7dd08a11ecaf9b068` is pushed and live at `https://health-pass-psi.vercel.app/`, assigned to READY deployment `dpl_44UvRdcjqaJ3wqqWXvNuRyXLPBPc`. Hosted checks passed for patient, limited pharmacy technician and administrator accounts on phone, tablet and desktop: permitted menu sets, drawer focus and closure, refresh/current destination, saved desktop collapse, no page overflow or browser errors, and limited-role API denials. Hosted fixtures used explicitly synthetic account/workspace metadata only; no clinical records or real emails were created. The existing Neon API 12/migration 011 remain the backend for this UI release.

## Accountable consultant decision — 2026-10-12

The owner confirmed administrator-assigned consultant responsibility for ongoing patient management, particularly inpatient wards: other GPs can give care while a paediatrician remains accountable for a child's overall management. [Care responsibilities](care-responsibilities.md) distinguishes this from visit assignment, primary facility status and sharing authority. The first implementation adds assignment/reassignment/history and chart/roster visibility with current reviewed-role and patient-access checks. Full admission/bed/discharge workflows remain later work.

Consultant release verified: code `2a8340c` is live at the canonical alias, Neon API 13 and migration 012 are applied, and the 102-check suite plus five separate PostgreSQL cases passed. Local browser testing verified the paediatrician/covering-GP workflow; hosted synthetic metadata checks verified assignment, chart/team visibility, permission revocation and preserved responsibility history. Full admission/bed/discharge operations remain separate. See [care-responsibilities.md](care-responsibilities.md).

## Facility sign-in links and remembered context — 12 October 2026

CONFIRMED: Use a facility-specific sign-in link as the usual professional entry, with workspace codes as a fallback. Show the verified facility before sign-in. Remember the selected workspace on the current device for 30 days when explicitly checked; this does not keep a user signed in. Existing 30-minute inactivity and eight-hour absolute session expiry remain enforced. Passwords and clinical data are never stored in this preference.

Implemented links use `/w/<readable-facility-name>/<unique-workspace-code>`, opening `/workspace?mode=professional-signin&workspace=<code>`. The code uniquely identifies the facility; the name is a readable label, so old links remain usable after a name change. No migration or new authentication provider is needed. Link names and browser preferences are not trusted identity evidence: the existing API checks the code and supplies the actual facility name before enabling sign-in. Existing facility-specific email/password identity and approved-membership checks remain authoritative.

Workspace & branches exposes the facility sign-in link and a copy action. Professional sign-in offers “Remember this workspace on this device” and “Use another workspace”; the latter clears the remembered selection and linked context. Generic sign-in restores an unexpired remembered workspace and rechecks it with the API. Explicit links override saved context, including invalid links (which fail safely without falling back). If an existing session belongs to another facility or a patient, the user must choose whether to keep that account or sign out to use the linked facility. Patients remain independently selectable and have no workspace code.

The expiry remains fixed from the initial choice: repeated sign-ins do not extend it. After 30 days, the saved workspace is removed and generic professional sign-in needs a code again. A verified facility link still selects its facility, with a fresh password sign-in whenever the session has expired. The remembered data contains only a workspace code and expiry; no email or password is remembered by HealthPass in this slice. Browser/password-manager autofill remains independent. Leave the checkbox unchecked on shared devices.

Verification: the complete `npm test` suite passed across SQLite and embedded PostgreSQL, including existing facility-scoped credential and 30-minute idle-expiry checks; two preference-policy checks verify fixed thirty-day expiry, forgetting, limited stored fields and storage failure. TypeScript, affected sign-in lint and the production build passed. Browser checks exercised real synthetic password sign-in, link verification, generic restoration, refresh, invalid-link precedence, patient selection, switching/forgetting, cross-session confirmation, blocked-storage successful sign-in and phone/desktop layout. A delayed-response check confirms manually selecting another workspace cannot be overwritten by an older facility lookup. The hosted canonical GreenSprings link and a synthetic facility owner were verified successfully; no personal password, clinical record or real email was used. The hosted sign-in checkbox is aligned alongside its label and the workspace settings expose the copyable link.
