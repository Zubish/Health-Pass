# HealthPass foundation — working implementation

The product source is [healthpass-blueprint-v1.txt](./healthpass-blueprint-v1.txt), copied verbatim from Musa's 9 October 2026 specification. Its CONFIRMED, RECOVERED PROPOSAL, BUILD RECOMMENDATION and OPEN labels remain authoritative. This document tracks the implementation and decisions; it does not convert recommendations into approved production policy.

## Implemented first slice

- Persistent opaque patient identity, optional DOB/contact, separate facility registration links. Shared phone/name never auto-merge records.
- Password accounts, HttpOnly expiring sessions, logout, active verified facility membership, and mandatory authenticator MFA for professional access.
- Patient self-registration. Professional accounts are provisioned by an operator; public signup never grants clinical roles.
- Clinician and reception patient registry, scoped search results; administrators lack clinical chart access.
- Patient's own signed-record view, facility-local charts, and patient-issued, time-limited full-signed-history sharing grants for participating organizations. Cross-facility drafts are excluded; grants never allow source-note rewriting.
- Allergy unknown/reviewed/none-known distinctions, emergency contact context. This is not emergency break-glass access.
- Draft encounters with explicit server save, optimistic version conflicts, signing, versioned amendments and reason. Signed snapshots are immutable in the database. Hashes provide integrity digests; this is not a PKI signature service.
- Append-only allowed/denied access/action audit. Patient activity is patient-scoped; facility activity is organization-scoped. Clinical text/passwords/secrets are excluded from operational logs.
- Responsive patient/provider workspace at `/workspace`, burgundy primary accents, slate/white foundations, supporting teal, blue and amber. Public landing-page links open the workspace.

## Stack decisions

Retain the existing React 19 / TanStack Start / TypeScript / Vite app instead of migrating to the blueprint's suggested Next.js stack. The framework choice was OPEN; keeping the existing router limits unnecessary migration.

A Node 24+ HTTP API is a modular application service under `server/`. PostgreSQL (`DATABASE_URL`) is the hosted database; Node SQLite is a local development/test convenience only and refuses production startup. The same first migration applies to both adapters; immutable triggers are engine-specific. `src/server.ts` forwards `/api/healthpass/*` to the private API origin and returns an explicit unavailable state when it is not configured. No direct browser database access and no frontend credentials.

The build uses the Vercel Nitro preset on Vercel and Node-server output locally; Lovable retains its own forced target. Vercel hosts the web entry and forwards API requests, not the persistent database. Configure the API on a reviewed Nigeria-hosted Node runtime with PostgreSQL, backups and access controls; do not use a Vercel ephemeral filesystem as storage. The existing Vercel deployment is not proof this API or database is provisioned.

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

| Email | Scope |
| --- | --- |
| doctor@healthpass.test | Lagos clinician |
| ibadan@healthpass.test | Ibadan clinician, initially denied Lagos charts |
| reception@healthpass.test | Lagos registration only |
| admin@healthpass.test | Lagos audit/operations only |
| patient@healthpass.test | Adé synthetic patient |

On first professional login, add the displayed setup key to a time-based authenticator, then verify its code. Later sessions require a fresh code. Do not put the setup key in screenshots/source. An operator can create a first facility/account with `npm run provision -- --email EMAIL --name NAME --facility FACILITY --role clinician --verified`, supplying HEALTHPASS_PROVISION_PASSWORD through a private server environment. Omit --verified until external professional review is complete; pending accounts cannot log in. This CLI creates a new facility for each initial provision; further memberships require reviewed operator administration. It never reuses an organization based solely on an unverified name. No credential verification service is connected.

## Configuration

| Variable | Purpose |
| --- | --- |
| DATABASE_URL | Private PostgreSQL connection string; required for production API |
| PUBLIC_APP_ORIGIN | Exact browser origin for CSRF checks; HTTPS required in production |
| HEALTHPASS_API_ORIGIN | Private API origin for the TanStack server proxy |
| HEALTHPASS_AUTH_KEY | Server-only 32-byte hex AES-GCM key for authenticator secrets; required in production |
| HEALTHPASS_API_PORT / HOST | Listener, defaults 4100 / 127.0.0.1; use private network binding when separated |
| HEALTHPASS_SQLITE_PATH | Development-only database file |
| HEALTHPASS_DEMO_PASSWORD | Local synthetic seed only |

Development applies migration 001 at startup. Production startup only checks its applied version. Run `npm run migrate` under a controlled migration identity before starting production, then run the API with a restricted role (no schema/trigger mutation). Run only one migrator. Configure encrypted database storage and a managed secrets boundary. Authenticator secrets are AES-256-GCM encrypted when HEALTHPASS_AUTH_KEY is configured, which production startup requires. The API credential must not be exposed to browsers. Session token hashes are stored, not raw session tokens. MFA code reuse is rejected. Keep the encryption key outside the database, use tightly scoped database access, and prepare key rotation/recovery before pilot use.

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

The API integration tests cover draft release, version conflicts, simultaneous signing, immutable note/audit triggers, MFA denial, patient/cross-facility ID tampering, reception/admin denials, consent grant/expiry/revocation, source-facility amendment denial, shared-phone identities, unknown data, origin checks, malformed DOB and logout. The suite runs against SQLite and an embedded PostgreSQL engine (PGlite), checking both query/trigger paths. Hosted PostgreSQL network/TLS, runtime-role restrictions and multi-process concurrency still require a controlled staging database before pilot release. No real clinical content should be used in tests.

## Hosted pilot and rollback

Before real patient use, review data locations for the API/database/logs/backups, clinical scope, consent wording, professional onboarding, membership/care assignments, MFA recovery, audit operations and restore. No managed Nigeria infrastructure or real clinical review was configured by this change. Authentication password recovery, email verification, self-service professional onboarding tooling, durable distributed abuse controls, managed key rotation/KMS and a session-management UI remain launch work. The current in-process attempt limiter is a local/one-instance mitigation, not distributed production protection.

Deploy the reviewed API/database first, then configure the web proxy and exact origin. Test the complete authorized and denied workflows using synthetic accounts. Back up before migrations and prove restoration. This first migration is additive; rollback the application commit while preserving patient/signed/audit tables. Do not delete clinical history or attempt to roll signed notes back by mutation. Restore only into an isolated reviewed environment before any controlled recovery.

Later slices: RxLedger prescription/fulfilment contracts, scheduling, telemedicine, results/referrals, HMO and Rai. Nothing in this slice signs prescriptions or connects a partner API.
