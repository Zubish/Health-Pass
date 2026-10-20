# Facility branding

Confirmed owner requirements: the expanded side panel shows the HealthPass wordmark without its graphic icon. The collapsed panel shows neither HealthPass mark. A facility's own logo or two-letter initials remain visible beside its name, including in the collapsed panel.

Administrators manage the logo under **Settings & security → Facility logo**. Clicking the facility logo or initials opens that settings page. Other professionals see the same logo without an editing link. Uploads support PNG, JPEG and WebP up to 5 MiB (labelled 5 MB in the UI). A preview precedes Upload/Replace; Cancel discards it. Remove logo clears the saved image and restores initials. Aspect ratio and transparency are preserved without cropping.

The browser turns the selected original into a PNG bounded to 320 × 320 pixels. The server checks the PNG signature, dimensions and CRC, decodes pixels and rewrites the image to discard metadata or trailing content. Only this small derivative is retained. The dedicated authenticated endpoint has a 610 KB JSON limit; other APIs retain the existing 40 KB limit. The original file is never stored or sent to the service.

Migration 017 adds `workspace_logos`, keyed by the authenticated organization. The endpoint accepts no target organization from the caller. Reads require a current facility session; writes require an owner/administrator and effective `roles.manage` permission, respecting individual denials. Upload and removal actions are audited. Images are fetched separately from `/auth/me` to avoid retransmitting them with session checks; the React Query key includes user and workspace identity.

Production migration must grant SELECT, INSERT, UPDATE and DELETE on `workspace_logos` to `healthpass_app`. DELETE applies only to the current logo; clinical records and their history are unaffected.

## Verification

Release implementation `6bb824f`: 174 integration checks passed across SQLite and PostgreSQL. Type checking, formatting, lint and production build passed (lint retains the six existing UI Fast Refresh warnings). Logo tests cover tenant isolation, administrator-only writes, individual permission denials, invalid image rejection, persistence and audited removal.

Local browser checks passed PNG/JPEG/WebP selection, preview/upload/replacement, a valid image exactly 5 MiB, rejection above 5 MiB, invalid formats, refresh persistence, staff read-only display, removal to initials, expanded/collapsed navigation and mobile settings links across 320, 390, 768, 1024 and 1440 pixel widths. No browser errors were recorded.

Deployed Neon API 22 with schema 017 and Vercel production deployment `dpl_2M9p63w3HNjF2hVB7K78JdRUfmfJ`. The canonical `health-pass-psi.vercel.app` alias was verified against that deployment. Live verification used the existing synthetic administrator to upload a logo, reload it, inspect collapsed branding, navigate from the mobile drawer to settings and remove it. The original logo state was restored and the test session signed out; no clinical data was changed.
