# Account setup guide

Confirmed owner request: an optional first-use setup card tailored to patients, professionals and facility administrators, with “Don’t show this again” and a permanent way to reopen it.

The first eligible workspace visit introduces the guide. This also gives existing accounts one opportunity to use the new guide. Continue setup opens the unfinished checklist; actions navigate to existing screens. Settings & security → Account setup always reopens it. Later or closing the guide pauses automatic reminders for seven days. Don’t show this again suppresses automatic reminders across devices for that account/workspace; it does not prevent manual access. A successfully presented guide does not reopen merely because the page refreshes. Failed saves remain visible and users can continue without saving instead of being trapped in a modal.

## Relevant steps

- Patients: review record details, choose a primary care facility, review sharing, review session security, and choose appearance/sound. Primary care completion is derived from the real designation; a pending request is labelled as awaiting acceptance. The guide never grants consent or chooses a facility itself.
- Professionals: confirm workspace, branch, job roles and effective access; locate department/daily work only when permitted; review security and preferences.
- Administrators: relevant facility-logo, branch, department/ward, role and team setup, according to effective permissions. Keeping the initials logo is valid.
- Professionals awaiting approval: approval context and personal appearance/sound only. Existing clinical and security-management gates remain in place. After approval, an active-workspace introduction becomes eligible unless permanently dismissed.

Review steps have an explicit “I’ve reviewed this” action. Merely opening a destination never implies completion. Primary designation and stored logos are checked against actual state on reopening. Completed steps are removed from the unfinished list. Workspace access labels show only the signed-in professional’s current permissions; patient sharing and care-area restrictions still apply.

Superseded on 15 October 2026: the patient guide now links to implemented emergency proxy appointments. See `emergency-proxies.md` for explicit consent, scope and approval rules. Authenticator onboarding remains in the existing optional authentication flow; this guide does not add a nonexistent authenticator-management screen or require enrollment.

## Persistence and boundaries

Migration 018 adds `account_setup`, keyed by user and workspace scope, with reviewed steps, permanent dismissal, snooze expiry and the pending/active presentation phase. `/account/setup` derives allowed steps from the authenticated account and permissions. It does not accept a target user/workspace. Writes serialize the state row so concurrent devices do not overwrite each other’s reviews or dismissal. Runtime grants are limited to SELECT, INSERT and UPDATE on the setup table.

Pending professionals may change their own appearance/sound preferences; this does not enable session administration or clinical routes. The guide uses Radix focus trapping, keyboard dismissal and a bounded scrolling dialog for small screens. No patient data or guide progress is stored in browser storage.

## Release verification — 15 October 2026

Implementation `982a99d559adbc5f6f2650994d23a9500c64d536` is pushed to `feat/healthpass-foundation`. Migration 018 is applied to production; Neon API deployment 23 is completed. Vercel deployment `dpl_4SCJVyV3P3ZY8T41vWE44dkX6ccZ` is ready and the canonical `https://health-pass-psi.vercel.app/` alias points to it.

All 176 automated checks passed across SQLite and PostgreSQL, including concurrent setup updates, cross-session persistence, role filtering, pending-access restrictions and approval transitions. TypeScript, formatting and the production build passed; lint has no errors and six pre-existing UI Fast Refresh warnings.

Local Chromium checks exercised patient, administrator, GP and pending-professional accounts at widths 320, 390, 768, 1024 and 1440. Dismissal, reopening, explicit review, navigation without false completion, keyboard close and overflow checks passed. Additional checks verified the failed-save escape and dark appearance; mobile screenshots were visually reviewed. Hosted synthetic administrator and GP accounts successfully signed in on the canonical URL and verified permission-specific steps, saved dismissal after reload and manual reopening. No real patient records or personal credentials were used. These browser checks do not claim testing every physical device or Safari.
