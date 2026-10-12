# Patient registration, claiming and primary care — working contract

Owner-approved 12 October 2026. This extends the original blueprint without rewriting its evidence labels.

## Confirmed decisions

A patient may create an account independently or be registered by a facility during care. A patient email belongs to one patient identity across facilities. Facility-scoped professional identities remain independent and may reuse the same email. Names, dates of birth and shared phones never merge identities.

Reception creates a provisional profile at an explicit active branch, records the details supplied by the patient and checks their identity. If the patient supplies their own email, the profile reserves that normalized address and queues a verification invitation. The patient opens the one-use 24-hour link, recognises the registration and chooses a password. Activation retains the exact profile, signed record IDs, authors, versions and audit; it does not create a second chart. The first registering facility is offered as primary during activation, with an opt-out. Patients can change it later.

Without an email, the facility can document care on a provisional profile. Its first registering facility may later add the patient's own email after an identity review. A relative's address is not substituted for the patient identity. Proxy accounts remain a separate future workflow. If the address belongs to another profile, attachment is rejected rather than merging either chart. Historical profiles without the new first-registration provenance cannot be claimed through this route; reviewed historical identity reconciliation remains planned.

An existing patient email prevents a second profile. The facility sees a limited existing-registration message and can request registration, or the patient can use the existing patient-issued registration-code flow. A facility-initiated request contains facility, branch and purpose; it appears in the patient's Care relationships and a pending-request notice. The patient approves or declines. A requested/unknown email receives the same submission acknowledgement, and facility request lists reveal no existing patient name, email, ID, history or clinical information before approval. Requests expire after 14 days and may be withdrawn by authorised staff in that workspace/branch. Identity-review reference is required: email matching alone is not an identity check.

Approval adds the branch's local care relationship, allowing authorised roles to document their own facility records while preserving named-professional restrictions. It grants no cross-facility signed history. Existing allergy/emergency-contact context is excluded by default; the patient may separately choose to include it. This profile preference is branch-specific. A professional authorised across the workspace may use the union of those branch preferences; a branch-bound professional uses their own branch preference. Existing explicit sharing grants and named-professional restrictions remain authoritative. Source records are not rewritten.

A patient can choose a primary care facility using its workspace code. The first facility that registered them on HealthPass does not need to accept; other facilities receive a request to accept or decline. The administrator/creator receives a new operational `primary.manage` capability, which can be assigned to an applicable custom role. A pending replacement leaves the current primary facility in place. Requests expire after 30 days; withdrawal and clearing are explicit. Primary designation creates no registration link, clinical grant, broader permissions or bypass of patient sharing restrictions. Acceptance is an administrative care responsibility, not clinical access.

## Implementation and boundaries

Migration `011` adds patient-address reservations, first-registration provenance, hashed claim tokens, encrypted email outbox, facility access requests, branch profile preferences and primary-care state/history. One patient account per patient identity is enforced by an index. Account claiming, email reservation and request decisions are transactional. Registration UI retries use an actor-scoped request key and payload digest; changed input uses a fresh key. The same patient row serializes competing primary-care choices. Runtime grants need SELECT/INSERT/UPDATE on the new tables; no deletion or trigger mutation is needed. Signed versions and audit remain immutable.

Claim secrets are in the emailed URL fragment, not URL query strings, API lists, audit or logs. Review/claim uses a same-origin JSON POST. The outbox stores the minimal invitation payload encrypted with the existing server authentication key. Resend revokes earlier links. Claiming cannot reset an existing account's password or activate an older unrelated chart.

Legacy and current independent self-signup accounts are not retroactively described as email-verified. Facility request creation requires a patient-present identity review; mailbox matching is not proof of clinical identity. Existing account/email recovery and correction need a separate reviewed flow. Proxies, emergency releases, unregistered contributors and Rai line redaction remain planned.

## Email delivery

The Resend adapter is prepared but requires an existing provider account and a verified sender. Configure server-only `RESEND_API_KEY` and `HEALTHPASS_EMAIL_FROM` on the **Neon API**, not the frontend, and retain `HEALTHPASS_AUTH_KEY` and the canonical `PUBLIC_APP_ORIGIN`. No sender account, domain, billing plan or real patient email has been created/sent by this implementation.

Without those settings, registration succeeds but displays **email delivery is not configured; invitation has not been sent**. The patient can activate only once a valid invitation is delivered; neither reception nor API lists expose its secret. Once configured, resend a fresh invitation if the queued link expired. The patient-issued code and in-app request pathways continue working independently.

Delivery runs after successful mutation commits and processes one leased outbox entry. A provider outage does not undo registration. A retry-capable operator worker is available with `npm run deliver-patient-emails` under the private API environment; schedule it through an approved runtime when email delivery is connected. Provider calls use a stable idempotency key, five-second timeout, bounded retries and safe status codes. No automatic provider delivery test sends a real email; tests mock the transport.

Invitation wording: “{Facility} has registered you on HealthPass. Verify your email and create a password to view your care records and manage who can access them.” No clinical content is included.

## Verification and release

Run `npm test`, `npm run typecheck` and `npm run build`. Tests cover claim preservation, replay/expiry/resend, email uniqueness and concurrent ownership, independent professional identities, masked access requests, profile choices, old-history/named-access protection, primary authority and mocked delivery failures/leases. Browser and hosted verification are recorded after they complete; a prepared adapter is not proof of email delivery.

Apply migration 011 through a migration identity before deploying the restricted API. Roll back application code if needed while preserving all identity, signed record and request/audit history. Do not undo patient ownership or clinical history by deleting rows.

### Verified deployment — 12 October 2026

Feature commit `d2687612060851baaa40684eda417f8ca050327c` is pushed to `feat/healthpass-foundation`. Canonical production alias `https://health-pass-psi.vercel.app/` points to READY deployment `dpl_SpLH6yhmhBqK9mbCEFYbsYsMfeS2`. Neon API deployment 12 completed, and migration 011 is applied with the restricted runtime grants. Initial duplicate-account/address migration checks returned zero; no patient histories were exposed in those checks.

The full suite passed 92 checks (SQLite plus embedded PostgreSQL, function and proxy checks). The final eight onboarding cases also passed on a separate local PostgreSQL 17 server with real pooled connections, including concurrent email reservation, claiming, registration retries and primary decisions. Synthetic per-test databases were removed, and the disposable container was stopped/removed. TypeScript, production build and lint for the new components passed.

Local 390px browser verification passed reception registration, honest unsent-delivery status, actual invitation-link claiming of the same provisional profile, first-facility primary confirmation, fragment removal, duplicate-email routing, request notification, explicit approval with profile sharing off, refresh persistence and no page errors or horizontal overflow.

Hosted verification used explicitly synthetic metadata only: restricted-role registration, actor-scoped retries and duplicate-email prevention, unsent delivery status, patient request notification and mobile approval, primary request/administrator acceptance, no administrator clinical access, primary clearing, anonymous denial and canonical refresh. No clinical notes, observations or follow-up tasks were written, and no real emails were sent. Successful claiming was tested locally; hosted email delivery remains unconfigured and is not claimed as verified.
