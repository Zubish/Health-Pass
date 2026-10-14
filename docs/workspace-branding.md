# Facility branding

Confirmed owner requirements: the expanded side panel shows the HealthPass wordmark without its graphic icon. The collapsed panel shows neither HealthPass mark. A facility's own logo or two-letter initials remain visible beside its name, including in the collapsed panel.

Administrators manage the logo under **Settings & security → Facility logo**. Clicking the facility logo or initials opens that settings page. Other professionals see the same logo without an editing link. Uploads support PNG, JPEG and WebP up to 5 MiB (labelled 5 MB in the UI). A preview precedes Upload/Replace; Cancel discards it. Remove logo clears the saved image and restores initials. Aspect ratio and transparency are preserved without cropping.

The browser turns the selected original into a PNG bounded to 320 × 320 pixels. The server checks the PNG signature, dimensions and CRC, decodes pixels and rewrites the image to discard metadata or trailing content. Only this small derivative is retained. The dedicated authenticated endpoint has a 610 KB JSON limit; other APIs retain the existing 40 KB limit. The original file is never stored or sent to the service.

Migration 017 adds `workspace_logos`, keyed by the authenticated organization. The endpoint accepts no target organization from the caller. Reads require a current facility session; writes require an owner/administrator and effective `roles.manage` permission, respecting individual denials. Upload and removal actions are audited. Images are fetched separately from `/auth/me` to avoid retransmitting them with session checks; the React Query key includes user and workspace identity.

Production migration must grant SELECT, INSERT, UPDATE and DELETE on `workspace_logos` to `healthpass_app`. DELETE applies only to the current logo; clinical records and their history are unaffected.
