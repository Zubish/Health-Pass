# Familiar and remembered sign-in devices

Owner-approved on 16 October 2026: reduce routine sign-in alert fatigue, show an optional device confirmation after **This was me**, warn against shared/public devices, and allow removal in Settings & security. Recognition must not bypass credentials or the existing session limits.

## Behaviour

A random HttpOnly browser cookie identifies a browser, independently of the session cookie. Only its hash is stored in `login_devices`, scoped to the account. Existing familiar-browser recognition is retained: repeated normal sign-ins with the same cookie do not create another new-device alert. Country changes now compare with that device's own last observed location, rather than another device's most recent sign-in. Browser/platform label changes also raise a review alert. Browser version changes within the same browser/platform are not treated as a new device.

**This was me** marks the sign-in reviewed. For a successful sign-in whose device is not already remembered, a modal shows the device and approximate country and offers **Remember this device** and **Not now**. Remember requires an explicit checkbox confirming personal ownership/control. The warning says not to remember shared/public devices and explains that passwords, 30-minute inactivity logout and 30-day reauthentication still apply. This is user confirmation for alert recognition, not hardware attestation or a substitute for authentication.

Choosing Not now or closing the modal keeps the alert reviewed without remembering the device. The latest successful sign-in for an unremembered device also offers Remember device, so users can choose later. Failed-password events can be reviewed but cannot be used to remember a device. A reviewed successful event and explicit confirmation are required by the API; device ownership is always bound to the authenticated account. Remembering resolves earlier device-only alerts for that device up to the confirmed event, without dismissing unrelated country changes or failed attempts.

Settings & security lists explicitly remembered devices, last sign-in time and the current-device marker. Forget device removes the remembered status and flags subsequent sign-ins for review. It does not end active sessions; the adjacent Active sessions controls remain available for that. The browser cookie remains private and expires after 30 days without a successful sign-in renewing it. Recognition persists across ordinary sign-out. Clearing cookies, private browsing or changing browsers may produce a new device; the app does not silently match devices by IP address or browser fingerprint.

## Implementation

Migration 021 adds `remembered_at` and `forgotten_at` to `login_devices`. Existing sign-in history is preserved, with no automatic bulk trust or review of old alerts. Existing table permissions are sufficient. API routes are `POST /account/security/events/:id/review`, `POST /account/security/events/:id/remember-device` (requires `confirmed: true`) and `POST /account/security/devices/:id/forget`. Remember/forget actions are audited, while events and active sessions remain separate. State-changing requests retain session and origin checks.

## Verification

Four new integration scenarios pass on both SQLite and PostgreSQL/PGlite: familiar-browser/location behaviour; reviewed-event, explicit-confirmation and account ownership gates; Not now and forgetting; and credentials/inactivity/thirty-day expiry independence. The existing eleven treatment/security checks pass on both engines, and all three proxy/cookie transport checks pass. Type checking, build and lint pass (six existing UI Fast Refresh warnings). Browser and deployment evidence follow below.
