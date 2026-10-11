# Account and facility workspaces — 11 October 2026

Implemented following the owner's account-choice and identity clarifications. RxLedger `Zubish/RxLedger` at `5c9aea6` was inspected: `src/components/AuthViews.tsx` separates workspace setup from workspace-selected sign-in/access requests; `server/_shared.ts` resolves the tenant by workspace code; branch scope is managed within that tenant. HealthPass adopts the selection pattern while retaining its clinical access checks and professional MFA.

## Account paths

- Landing **Create account** opens `/workspace?mode=register`, with Patient and Healthcare professional / facility choices.
- **Create professional account** opens `/workspace?mode=professional` directly.
- Patient creation uses name, optional DOB/contact, email and password. Patient sign-in resolves the patient identity independently of professional accounts.
- Facility creation uses the administrator's name/email/password, facility type/name/address, initial branch and authority declaration. It creates an isolated workspace, a random workspace code and an administrator membership. Ownership permits administration, not clinical records or authoring. Professional MFA is required before workspace management.
- Existing workspace access is under **Sign in → Professional**, using workspace code, email and password. First-time staff setup stays in that sign-in flow and records name, profession and applicable registration number. It creates a pending membership, not immediate care access.
- The administrator reviews identity and applicable credentials, records a review reference, and approves a supported role and branch. Approved professionals still complete MFA. Suspension and branch changes take effect on subsequent API requests, including existing sessions.

## Identity and branch isolation

A professional may use the same email/password or different credentials at another facility. Each new facility-scoped identity has its own user ID, credential hash, MFA setup and membership. There is no mandatory global professional identity. The same email may also have a separate patient account. Never identify a professional by email alone without workspace context.

Migration `002` adds the public login email and account scope while preserving existing user IDs, patient IDs, credentials, sessions, signed history and audits. The old unique internal email column remains an implementation key; professional email is exposed through `login_email`. Existing provisioned accounts retain the legacy API login path for compatibility; new professional identities always require a workspace code. UI sign-in explicitly chooses Patient or Professional.

New non-administrator clinical/registration memberships are assigned to a branch. Local registry/chart access checks its branch relationship; drafts and source-note mutation stay within the assigned branch. Explicit patient facility sharing continues to authorize signed-history reads under the existing consent policy; it does not unlock another branch's drafts or source-note rewriting. Legacy memberships without branch assignment retain their previous facility scope until reviewed and assigned. Administrators manage the whole workspace and have no implicit clinical access.

## Verification and deployment

Twenty-one tests cover the existing clinical foundation plus facility-scoped reused credentials, separate patient identity, wrong/missing workspace codes, pending membership denial, administrator-only management, cross-workspace approval denial, required review, branch ownership, professional MFA, branch reassignment and session suspension. Tests run on SQLite and embedded PostgreSQL. Browser verification covers account choice, facility form, owner MFA, workspace code, staff setup under Sign in, pending status, approval, staff MFA, logout and mobile layout.

Apply migrations through the migration identity, never runtime schema mutation. The runtime role additionally needs `INSERT` on organizations, `INSERT/UPDATE` on memberships, and `SELECT/INSERT` on branches and branch_patient_links. No signed-note/audit update or delete permissions are added. Hosted migration `002` is applied and API deployment 3 completed with existing private environment values inherited. The frontend is deployed after API verification. Rollback application code carefully: the old email-only professional lookup is incompatible with migrated internal professional email keys. Preserve records and prefer a forward fix; do not undo migration by deleting history.

## Saved subsequent requirements

Primary-care designation, patient-selected individual professional access, partial/full grants, consultant-specific access and scoped delegation, proxies, verified emergency release, external contributor invitations and future Rai redaction remain recorded in `foundation.md`. They are not activated by workspace creation or this migration. Current facility-level consent does not provide those finer controls. Do not claim they are already available or broaden access on their basis.

No automated credential-verification service, email verification, password recovery or proxy OTP delivery is added here. Manual administrator review is recorded rather than presented as independent external verification. Prescribing and other future clinical modules retain their separate authorization requirements.
