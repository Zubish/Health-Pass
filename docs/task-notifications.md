# Task notifications and patient linking — 14 October 2026

The owner requested a notification bell, numeric sidebar badges, clear instructions for registration codes and a plain-language identity check field.

## Current behaviour

The bell is available in the patient and professional top bars. It opens a keyboard-accessible panel with grouped pending work and links to the relevant workspace sections. Sidebar destinations show a numeric badge only when their count is positive. Zero counts and unavailable/loading placeholders are omitted. Counts above 99 use `99+` in compact badges, with the full number in the accessible label and notification panel.

Counts combine actionable work with explicitly unread updates where that workflow supports them. Opening the panel does not complete work. Counts change when a workflow is completed, declined, revoked or expired, or when the user's permissions change. The panel includes active care work as well as pending decisions. Informational pages do not acquire a count simply because they contain records.

Sources currently include:

- Patient facility-access requests and active registration invitations.
- Receiving-facility registration invitations, primary care requests and unreviewed professional access requests, subject to the relevant job permissions.
- Active visits and incoming care handoffs within branch, care-area and clinical access boundaries.
- Referrals assigned to the responding professional, assigned active care episodes and episodes awaiting an administrator's consultant assignment.
- Department collection/examination/review/report/release work and outstanding clinician clarification or result-review actions.
- The account's unreviewed suspicious sign-ins.
- Proxy invitations and pending emergency decisions; unread patient history updates clear when marked read. Requester approval alerts clear after viewing approved records, or when expiry, revocation or permission changes make access unavailable.

The server derives counts from current source records. Clinical candidates are checked against current permissions and sharing. Counts are not limited to the first UI page; candidates are processed in bounded batches. The response contains section labels and counts, not patient names, diagnoses, registration codes or clinical text. Existing workflow endpoints still enforce all permissions when an action is attempted.

Visible tabs refresh every minute, on returning to the app, after a successful action and on manual refresh. A failed refresh shows an error in the bell/panel and hides sidebar counts rather than presenting a misleading zero. Counts are not stored on the device. The passive `/notifications` endpoint validates the current session but does not renew its inactivity timestamp; the platform's 30-minute idle limit and absolute expiry remain enforced.

This release provides in-app task alerts. It does not introduce email, browser push, an unread event archive or permission to access additional records.

## Registration guidance

The generated-code card now directs the patient to give the code privately to facility registration staff. Staff use **Patient registry → Link existing account → Patient registration code** in the receiving facility/branch workspace.

The linking form replaces “Identity review reference” with **How did you confirm the patient’s identity?** A multiline field offers an example and explains that staff should record only checks they actually performed, without ID document numbers or passwords. It is not another code. Existing required confirmation, single-use code, expiry, branch binding and duplicate-review rules remain enforced; the stored API field is still `review_reference`.

## Verification

New integration tests exercise task transitions, cross-workspace and role isolation, revoked permissions, invitation expiry and successful redemption, counts beyond a UI page, care-area restrictions and passive refresh preserving session expiry. They run against both SQLite and PostgreSQL/PGlite.

Local browser checks cover patient and professional bell/sidebar behaviour at 320, 390, 768, 1024 and 1440px, focus restoration and Escape, alert navigation, code instructions, the identity note and successful linking clearing the counts. Synthetic data only.

Release evidence: implementation `e5852a6e45d8ad288fec22ab3ce705033e3d8fb9` is deployed as Neon API 20 and Vercel production `dpl_Dza2YLbWW5hq9fqoHgKDhaUwjQ9B`. The canonical `health-pass-psi.vercel.app` alias was confirmed on that deployment. Schema remains 015. The full regression run recorded 169 passing checks; the final department/notification suite separately passed all ten cases on each database engine, including the subsequently added administrative care-area case. TypeScript, build, formatting and focused lint pass; global lint retains only the six existing UI-library Fast Refresh warnings.

Hosted verification passed synthetic professional sign-in, the summary API, all five device widths, every sidebar badge, compact navigation, dialog focus, simulated alert-fetch failure and successful retry, and refresh persistence. No browser errors or clinical writes occurred. The deployment-scoped Vercel error/fatal log query returned no records during verification. Local and hosted mobile screenshots were reviewed.

## Badge visibility correction — 15 October 2026

Positive counts remain visible, including a single pending item; zero badges are removed on desktop, collapsed navigation and mobile. The bell already followed this rule. Emergency records viewing now refreshes task counts immediately. Requester alerts use the same current-authority check as record access, excluding already-viewed and invalid approvals. Other tasks retain their existing review/completion rules. No migration is needed.

Release verification — 16 October 2026: implementation `a994c46bdc8f973094da94cad8b4b6fd9ff5c63c` is deployed as Neon API 26 (completed) and Vercel production `dpl_5VZgSYjTNQNMx34cTF6WkEJHb3Dh` (READY). The canonical `health-pass-psi.vercel.app` alias points to this deployment. Schema remains 019.

Type checking, production build and lint passed (six existing UI Fast Refresh warnings). Focused emergency-proxy tests passed on SQLite and PostgreSQL/PGlite, including viewed approvals and revoked unread approvals; all ten PostgreSQL department/notification checks passed. Local desktop/mobile badge transitions passed. Hosted synthetic professional sign-in and the real notification-summary endpoint passed. Hosted desktop and mobile UI checks used intercepted summary responses to verify counts of one and two appear and zero removes all badges after refresh; no real clinical data was changed.
