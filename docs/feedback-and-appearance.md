# Completion feedback and appearance

Confirmed owner requirements: completed actions show a centered confirmation for three seconds; an optional subtle sound lasts under one second; users can choose dark mode.

The root feedback provider owns one nonblocking, polite live announcement and its timer. A new success replaces the previous message and restarts the three-second period. It does not move focus. Shared workflow hooks replace persistent success banners; errors, loading states, generated registration codes, pending requests and email-delivery instructions remain available. Clipboard success uses the same confirmation. Cancelling a dialog does not report success.

Settings & security contains Appearance (device setting, light, dark) and Play completion sounds. Both are saved to the authenticated account through `/account/preferences`, independently of workspace roles. Schema migration 016 adds constrained preference columns. The theme alone is cached on the browser for appearance continuity; no clinical information or sound preference is stored there. `/auth/me` reloads account preferences after sign-in. Session expiry/sign-out clears the sound eligibility and current confirmation.

The sound uses a low-volume, fading two-note Web Audio tone lasting 350 milliseconds. Browser gesture/autoplay rules still apply. No sound plays before account preferences are loaded, when disabled, or while the tab is hidden. Audio failure never changes the outcome of an action. Visual feedback remains available with sound off.

Explicit stylesheet colours pair the existing light palette with shared dark surface, border, text and accent tokens using CSS `light-dark()`. The `.dark` root selects the dark colour scheme, including native form controls. Device appearance changes are followed while the system option is selected.

Verification includes account isolation, invalid preference rejection, persistence after reauthentication, SQLite and PostgreSQL integration suites, and browser checks for patient/professional settings, confirmation duration and placement, sound duration/muting, device appearance changes, dialogs and responsive layouts.

## Release verification

Implementation `5bc7566` plus wordmark sizing correction `86a9e3e` passed type checking, production build, formatting and lint (only the six existing UI Fast Refresh warnings). All 172 integration checks passed across SQLite and PostgreSQL. Browser verification covered patient and professional preferences at 320, 390, 768, 1024 and 1440 pixels, actual Web Audio duration/muting, centered three-second confirmations, saved appearance, system colour changes and dialogs. The existing ten notification viewport/role checks and patient-registration redemption flow also passed.

Neon API deployment 21 and schema 016 support the release. Canonical production verification used an existing synthetic professional account, restored its original preferences, and signed it out afterward. It checked sign-in, preference save/reload, centered dismissal, five widths, notifications and the dark landing page without browser errors. No clinical records were changed.
