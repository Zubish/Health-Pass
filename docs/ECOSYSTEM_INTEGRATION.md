# HealthPass, RxLedger and Rai: first working integration slice

HealthPass now has a scoped care/prescription portal at `/care` rather than only a landing page. The user's HealthPass blueprint is authoritative; HMO authorization is explicitly deferred. Rai serves both HealthPass and RxLedger through separate controlled interfaces.

## Ownership and implemented behavior

HealthPass owns patient identity, care relationships, signed encounters and prescription orders, patient consent and the returned medication timeline. RxLedger owns pharmacist review, catalog/batch mapping and actual sale/stock transactions. Rai interprets authorized operational aggregates; no patient identities, notes or prescription rows enter its HealthPass model context.

The first slice supports:

1. Operator-provisioned provider/patient accounts, organization membership, HttpOnly sessions, origin/CSRF enforcement and audited access. Real production providers require enrolled TOTP and a reviewed professional verification reference.
2. Stable generated patient IDs, explicit provider care relationships and a manually reviewed partner identity link. Names and phone numbers never automatically link patients.
3. Draft/signed encounters; immutable signed version 1 prescriptions with an authenticated author and a content digest. The digest records provenance; it is **not** a claim of certified professional digital-signature verification.
4. Patient-granted, expiring/revocable prescription sharing with one configured pharmacy.
5. Durable dispatch outbox, leased bounded retries, signed raw-body transport, pharmacy acknowledgement and deduplicated feedback inbox. Receipt, review and supply are separate states.
6. Same-pharmacy partial supply over multiple visits. Feedback is created atomically with RxLedger's existing sale/stock update. Duplicate operations cannot re-supply; excessive quantities, expired stock, ambiguous mappings and invalid scope are rejected.
7. Cancellation/revocation controls, live HealthPass authorization checks before production RxLedger supply, and immutable actual supplied quantities. Revocation never deletes the fact of prior supply.
8. Rai's exact seven aggregate workflow counts, short-lived session-bound delegated access and deterministic authoritative values. Model outage can leave counts available with an unavailable explanation.

No HMO, payments, laboratory, external EMR, video provider, shared ecosystem login or clinical AI relationships are introduced. Signed amendments, dispensing reversals, stock reservations, secure clarification chat and the rest of the full EHR blueprint are later slices; the current APIs reject unsupported versions rather than pretending to reconcile them.

## Data and transaction boundary

For the pilot, one organization is stored per PostgreSQL JSONB workspace row, with a row lock around every mutation. Signing/consent changes and outbox creation share that transaction; accepted feedback, cumulative supply and inbox deduplication also share it. PostgreSQL RLS with transaction-local organization scope adds database isolation. Use a non-superuser application role without BYPASSRLS. Normalizing the workspace into indexed resource tables is required before broad scaling; this implementation does not claim a full production EHR schema.

Development can use Node's persistent SQLite adapter; it is blocked when `NODE_ENV=production` and no PostgreSQL connection is configured. Test memory storage is never selected by the runtime. Database files and server env files are gitignored. Keep records, backups, logs, inference and keys within approved Nigerian hosting; a passing local build does not establish location compliance.

## Shared prescription contract

`POST RxLedger /api/healthpass` accepts `receivePrescription`, `receivePrescriptionControl`, `pullEvents` and `acknowledgeEvents`. RxLedger rewrites that URL to its existing function router to preserve the current function-count limit.

Both products use `x-ecosystem-key-id`, `x-ecosystem-timestamp` (Unix seconds) and `x-ecosystem-signature` (hex HMAC-SHA256 over `timestamp + '.' + exact raw body`). Requests expire after five minutes; inbox/event IDs prevent duplicate effects independently of the transport timestamp. Each service deployment is configured for one organization and target tenant/branch. Keys must be at least 32 characters, generated securely, stored server-side, and matched in both products.

Envelope: `eventId`, `eventType`, `schemaVersion:1`, `occurredAt`, `producer`, `sourceOrganizationId`, `correlationId`, `aggregateId`, `aggregateVersion`, `payload`.

Dispatch payload contains `prescriptionId`, `version`, `patientLinkId`, minimum patient identity, signed encounter/prescriber provenance, `signedAt`, `validUntil`, configured pharmacy, active consent grant/version/expiry, fixed items and signature digest. Items distinguish medicine form/strength, numeric dose/unit, instructions and authorized dispensing quantity/unit. RxLedger requires a pharmacist to map the same approved catalog medicine/form/strength/sellable unit; no guessed substitutions or package conversions occur.

Dispense feedback carries prescription/version/link, pharmacy tenant/branch, stable sale ID, pharmacist, actual supply timestamp and item quantities/units. HealthPass validates cumulative quantities, source, version and transaction deduplication before updating patient-visible totals. Invalid/old-version events remain unacknowledged for reconciliation; they never silently alter the current version. Outbox dead letters need operator review rather than unlimited retries.

HealthPass authorization endpoint: `POST /api/v1/integrations/rxledger/authorization`, signed with the same partner key, body `{prescriptionId,version,patientLinkId}`, response `{authorized:boolean}`. Production RxLedger denies supply during HealthPass authorization outages. This protects revocation even if asynchronous control delivery is delayed.

## Run locally with synthetic records

Use Node 24+, then:

```sh
npm ci
cp .env.example .env.local
```

Set the organization, public URL and synthetic pharmacy scope in `.env.local`. Supply `HEALTHPASS_PROVISION_PASSWORD` privately (at least 16 characters), then run:

```sh
npm run provision -- --synthetic
npm run dev -- --host 127.0.0.1 --port 3100
```

Synthetic accounts are `doctor@example.test` and `patient@example.test`, using the password you supplied. They are not verified real professionals. Synthetic provisioning refuses production and nonempty workspaces. For real onboarding, the private provisioning command requires an existing reviewed patient ID or reviewed professional evidence plus enrolled TOTP. It records operator-supplied evidence; it does not contact a professional registry or invent a verification result.

For API-only development, `npm run dev:api` listens on 127.0.0.1:3101. The full frontend handles `/api/v1` in its server entry without a browser database connection. The build pins a Node-server preset; it no longer silently inherits the landing page's Cloudflare deployment preset. Lovable can override that preset in its own environment: do not activate real records there without a separately verified Node/data-location deployment.

Set `RXLEDGER_HEALTHPASS_URL` to the actual RxLedger `/api/healthpass` URL, with matching service key/scope. In RxLedger set `HEALTHPASS_AUTHORIZATION_URL` to HealthPass's authorization endpoint. Set the HealthPass analytics URL and paired keys according to Rai's `RAI_HEALTHPASS_ACCESS_CONTRACT.md`, and only enable both HealthPass/Rai flags on an approved inference deployment.

Run `npm run integrations:deliver` from an approved scheduler (e.g. every minute). It sends signed queued orders/controls, polls feedback, commits each batch before acknowledgement and reports retry failures without patient content. The browser retry control invokes the same bounded worker. No public unauthenticated scheduler endpoint exists. Delayed processing is shown as queued/retry-required, never completed treatment.

## Verification

```sh
npm test
npm run build
npx tsc --noEmit
npm run lint
```

Cross-product tests require sibling clones at `../RxLedger` and `../Rai`, and run actual RxLedger sale/stock mutation code with a synthetic database. They verify lost acknowledgements, duplicate dispatch/sale events, partial then complete supply, item totals, consent revocation and minimized Rai context. Standalone foundation tests still run without sibling clones; the explicit ecosystem command requires them.

For real PostgreSQL adapter tests, apply `db/migrations/001-prescription-foundation.sql` to an **isolated test database**, grant the restricted test role SELECT/INSERT/UPDATE on `healthpass_workspaces`, set `HEALTHPASS_TEST_DATABASE_URL`, and run `node server/postgres.test.mjs`. The test exercises actual RLS, concurrent mutations and rollback. It must never target a live patient database.

For a seeded synthetic development portal:

```sh
npx playwright install chromium
# Supply HEALTHPASS_BROWSER_PASSWORD privately; optionally HEALTHPASS_BROWSER_URL.
npm run test:browser
```

The browser test signs an encounter and prescription, exercises patient consent/revocation, confirms patients cannot sign, and checks page errors. Screenshots contain only the provisioned synthetic fixture.

## Deployment and rollback

1. Provision approved Nigerian Node/PostgreSQL infrastructure and separately governed encryption, TLS, backups and keys. Apply the additive migration with a schema administrator; use a restricted application database role.
2. Configure server-only organization, origin, partner target, keys and real URLs in each service. No secret belongs in `VITE_*` variables or frontend bundles. Keep Rai flags disabled until inference location and evaluation are approved.
3. Build all three apps, deploy matching branches without routing real users yet, provision reviewed pilot accounts and run the synthetic whole-flow test against the actual deployment. Verify the production live authorization callback and worker schedule.
4. Verify professional/consent policies, patient identity links, backup restore and deployment locations before real records. The local tests do not prove these operational facts.
5. Roll back application routes/flags first; pause dispatch and polling workers. Preserve the additive table and existing RxLedger fulfilment history/outboxes for reconciliation. Do not drop patient records, migrate backwards destructively, or re-enable supply based on a cached consent.

## Remaining deployment inputs

The session has no configured application database, approved production inference endpoint or service keys. Pilot facility/pharmacy identities, professional-review process, Nigerian hosting/backups and reviewed consent/retention policies are still deployment inputs. They do not prevent synthetic implementation, but this slice is not activated for real patient traffic.
