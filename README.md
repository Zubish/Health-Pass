# HealthPass

Patient identity, continuity of care and consent-aware clinical records. Part of the RxLedger / Rai ecosystem, with burgundy accents and neutral, teal and blue supporting surfaces.

Public app: **https://health-pass-psi.vercel.app/**. Use this stable address for sharing and bookmarks; `/workspace` opens its sign-in/care workspace. New Vercel deployments redirect alternate HealthPass hosts to this address, preserving paths and query strings. Historical deployment URLs contain older immutable builds; remove retired previews through Vercel rather than sharing them.

- [Working product blueprint](docs/healthpass-blueprint-v1.txt) — supplied specification, preserved verbatim.
- [Product definition, users, relationships and build plan](docs/product-definition.md).
- [Saved ecosystem design principles](docs/design-principles.md).
- [First-slice implementation, setup and verification](docs/foundation.md).
- [Account choice, facility workspaces and branches](docs/account-workspaces.md).
- `/` — product introduction.
- `/workspace` — patient/facility sign-in, registry, charts, encounters, sharing and audit.

Use synthetic data only until the hosting, clinical and privacy pilot requirements in the implementation notes have been reviewed and completed.
