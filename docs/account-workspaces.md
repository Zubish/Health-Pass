# Account and facility workspaces — 11 October 2026

Implemented following the owner's account-choice and identity clarifications. RxLedger `Zubish/RxLedger` at `5c9aea6` was inspected: `src/components/AuthViews.tsx` separates workspace setup from workspace-selected sign-in/access requests; `server/_shared.ts` resolves the tenant by workspace code; branch scope is managed within that tenant. HealthPass adopts the selection pattern while retaining its clinical access checks and optional authenticator protection.

## Account paths

- Landing **Create account** opens `/workspace?mode=register`, with separate Patient, Professional and Facility cards.
- **Create professional account** opens `/workspace?mode=professional` directly for a professional access request. Facility creation has its own `/workspace?mode=facility` form.
- Patient creation uses name, optional DOB/contact, email and password. Patient sign-in resolves the patient identity independently of professional accounts.
- Facility creation uses the administrator's name/email/password, facility type/name/address, initial branch and authority declaration. It creates an isolated workspace, a random workspace code and an administrator membership. Ownership permits administration, not clinical records or authoring. The creator is an active administrator immediately and may set up an authenticator or skip it to continue.
- Professional creation is under **Create account → Professional**, using workspace code, name, profession, applicable registration number, email and password. **Request access** creates a pending membership, not immediate care access. Sign-in has only Patient and Professional choices; facilities are workspaces, not users. Professional sign-in requires workspace code, email and password.
- The administrator reviews identity and applicable credentials, records a review reference, and approves a supported role and branch. Approved professionals may verify with an authenticator or skip it for their current session. Suspension and branch changes take effect on subsequent API requests, including existing sessions.

## Identity and branch isolation

A professional may use the same email/password or different credentials at another facility. Each new facility-scoped identity has its own user ID, credential hash, MFA setup and membership. There is no mandatory global professional identity. The same email may also have a separate patient account. Never identify a professional by email alone without workspace context.

Migration `002` adds the public login email and account scope while preserving existing user IDs, patient IDs, credentials, sessions, signed history and audits. The old unique internal email column remains an implementation key; professional email is exposed through `login_email`. Existing provisioned accounts retain the legacy API login path for compatibility; new professional identities always require a workspace code. UI sign-in explicitly chooses Patient or Professional.

New non-administrator clinical/registration memberships are assigned to a branch. Local registry/chart access checks its branch relationship; drafts and source-note mutation stay within the assigned branch. Explicit patient facility sharing continues to authorize signed-history reads under the existing consent policy; it does not unlock another branch's drafts or source-note rewriting. Legacy memberships without branch assignment retain their previous facility scope until reviewed and assigned. Administrators manage the whole workspace and have no implicit clinical access.

## Verification and deployment

Twenty-one tests cover the existing clinical foundation plus facility-scoped reused credentials, separate patient identity, wrong/missing workspace codes, pending membership denial, administrator-only management, cross-workspace approval denial, required review, branch ownership, professional MFA, branch reassignment and session suspension. Tests run on SQLite and embedded PostgreSQL. Browser verification covers account choice, facility form, owner MFA, workspace code, professional registration, pending status, approval, staff MFA, logout and mobile layout.

Apply migrations through the migration identity, never runtime schema mutation. The runtime role additionally needs `INSERT` on organizations, `INSERT/UPDATE` on memberships, and `SELECT/INSERT` on branches and branch_patient_links. No signed-note/audit update or delete permissions are added. Hosted migration `002` is applied and API deployment 3 completed with existing private environment values inherited. The frontend is deployed after API verification. Rollback application code carefully: the old email-only professional lookup is incompatible with migrated internal professional email keys. Preserve records and prefer a forward fix; do not undo migration by deleting history.

Production deployment of commit `23d8c4e` is READY at the canonical address. Eighteen hosted API checks passed: synthetic facility creation, owner/staff MFA, pending clinical denial, reviewed reception approval, registry access, branch creation, logout and workspace-code login. Synthetic workspace metadata and identities remain labelled for verification; no clinical record was created in the hosted check. The landing responds with the new account-choice labels and direct professional-form link.

## Saved subsequent requirements

Primary-care designation, patient-selected individual professional access, partial/full grants, consultant-specific access and scoped delegation, proxies, verified emergency release, external contributor invitations and future Rai redaction remain recorded in `foundation.md`. They are not activated by workspace creation or this migration. Current facility-level consent does not provide those finer controls. Do not claim they are already available or broaden access on their basis.

No automated credential-verification service, email verification, password recovery or proxy OTP delivery is added here. Manual administrator review is recorded rather than presented as independent external verification. Prescribing and other future clinical modules retain their separate authorization requirements.

### Navigation and idle sessions (11 October 2026)

Workspace tabs and selected record IDs now use validated URL search parameters. Browser back/forward restore visited views; refresh restores the current view after rechecking authentication. Account choice, professional sign-in and first-time access setup also use URL state. No credentials or clinical note text are stored in navigation URLs. Unsaved notes warn before leaving or refreshing.

Sessions expire after 30 minutes of inactivity, matching RxLedger. Migration 003 adds server-side `last_seen_at`; authorized requests renew it, expired sessions cannot read records, and a new login is required. The existing eight-hour absolute session limit remains. Browser interaction renews activity with a throttled authenticated request, while an idle timer clears the workspace and returns to sign-in. Background polling does not keep a session alive.

Validation: typecheck, production build and 23 integration checks across SQLite and embedded PostgreSQL. Browser checks covered account-flow history, workspace back/forward, refresh, and a simulated 30-minute idle timeout returning to sign-in without browser errors.

### Three account-creation paths and workspace confirmation (11 October 2026)

The owner corrected the initial combined Professional/Facility flow. Create account now offers Patient (view records and manage sharing), Professional (work with the care team in a facility workspace), and Facility (create the workspace and branches). The bottom “Already have an account? Sign in” remains; the redundant “Existing facility workspace? Sign in” link and first-time setup inside sign-in are removed. Older setup links still resolve to professional registration.

Professional registration and sign-in both require checking the workspace code before their submit action is enabled. The API returns only the facility name and supplied code; it does not create a session or reveal members, branches, addresses or records. The confirmed name stays visible before submitting and during professional MFA. Editing the code invalidates the confirmation, including any in-flight result. Authentication and membership creation independently validate the code on the server. A facility administrator must create a workspace first if one does not exist.

Validation: 25 integration checks across SQLite and embedded PostgreSQL, typecheck and production build. Browser verification covered three creation cards, separate forms, a Pharmacy Technician access request, unknown and edited codes, pending approval, administrator approval, MFA, two sign-in options, facility confirmation before sign-in/MFA, navigation/refresh and mobile width.

### Optional authenticator protection and creator access (11 October 2026)

Confirmed owner decision: authenticator verification is optional. The post-password screen offers **Skip for now** both before setup, after unfinished setup and for already enrolled users. A separate ecosystem authenticator app is planned for later; this change does not build that app. Email/password sign-in and the facility workspace code remain required.

Migration 004 adds a session-scoped `mfa_skipped` flag. The skip endpoint requires an authenticated, approved professional/administrator session, records `auth.mfa_skipped`, and leaves `mfa_verified` and the account’s authenticator enrollment unchanged. A new login prompts for the optional choice again. Staff approval, workspace/branch scope, role permissions, audit records and the 30-minute idle timeout remain enforced. Incorrect authenticator codes now show a retry error rather than clearing a valid password session.

GreenSprings Hospital’s existing creator membership was inspected: active, verified administrator, with unfinished authenticator setup. No account, credential or membership mutation is needed. The creator can use Professional sign-in with the facility code and the original registration credentials, then skip the authenticator screen.

Validation: 29 integration checks across SQLite and embedded PostgreSQL, typecheck and production build; browser checks cover creator workspace access, unfinished setup, incorrect-code retry, skip, refresh, logout and facility-code sign-in with skip.
