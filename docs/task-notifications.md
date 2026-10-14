# Task notifications and patient linking — 14 October 2026

The owner requested a notification bell, numeric sidebar badges, clear instructions for registration codes and a plain-language identity check field.

## Current behaviour

The bell is available in the patient and professional top bars. It opens a keyboard-accessible panel with grouped pending work and links to the relevant workspace sections. Every visible sidebar destination has a numeric badge; zero means there is no outstanding task tracked for that section. Counts above 99 use `99+` in compact badges, with the full number in the accessible label and notification panel.

These are live task counts, not unread-message counts. Opening the panel does not complete work. Counts change when a workflow is completed, declined, revoked or expired, or when the user's permissions change. The panel includes active care work as well as pending decisions. Informational pages do not acquire a count simply because they contain records.

Sources currently include:

- Patient facility-access requests and active registration invitations.
- Receiving-facility registration invitations, primary care requests and unreviewed professional access requests, subject to the relevant job permissions.
- Active visits and incoming care handoffs within branch, care-area and clinical access boundaries.
- Referrals assigned to the responding professional, assigned active care episodes and episodes awaiting an administrator's consultant assignment.
- Department collection/examination/review/report/release work and outstanding clinician clarification or result-review actions.
- The account's unreviewed suspicious sign-ins.

The server derives counts from current source records. Clinical candidates are checked against current permissions and sharing. Counts are not limited to the first UI page; candidates are processed in bounded batches. The response contains section labels and counts, not patient names, diagnoses, registration codes or clinical text. Existing workflow endpoints still enforce all permissions when an action is attempted.

Visible tabs refresh every minute, on returning to the app, after a successful action and on manual refresh. A failed refresh shows an error and unavailable badges rather than falsely reporting zero work. Counts are not stored on the device. The passive `/notifications` endpoint validates the current session but does not renew its inactivity timestamp; the platform's 30-minute idle limit and absolute expiry remain enforced.

This release provides in-app task alerts. It does not introduce email, browser push, an unread event archive or permission to access additional records.

## Registration guidance

The generated-code card now directs the patient to give the code privately to facility registration staff. Staff use **Patient registry → Link existing account → Patient registration code** in the receiving facility/branch workspace.

The linking form replaces “Identity review reference” with **How did you confirm the patient’s identity?** A multiline field offers an example and explains that staff should record only checks they actually performed, without ID document numbers or passwords. It is not another code. Existing required confirmation, single-use code, expiry, branch binding and duplicate-review rules remain enforced; the stored API field is still `review_reference`.

## Verification

New integration tests exercise task transitions, cross-workspace and role isolation, revoked permissions, invitation expiry and successful redemption, counts beyond a UI page, care-area restrictions and passive refresh preserving session expiry. They run against both SQLite and PostgreSQL/PGlite.

Local browser checks cover patient and professional bell/sidebar behaviour at 320, 390, 768, 1024 and 1440px, focus restoration and Escape, alert navigation, code instructions, the identity note and successful linking clearing the counts. Synthetic data only.
