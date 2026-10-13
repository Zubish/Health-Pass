# Code maintenance

HealthPass uses TypeScript and React for the interface, Node.js ES modules for the API, and SQL migrations for database changes. Code should follow the care workflow, use descriptive names, and keep access decisions visible to reviewers.

## Where to look

| Location                                 | Responsibility                                                      |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `src/routes/`                            | Page routes, URL state and the server-side API proxy                |
| `src/components/healthpass/`             | Patient and professional workflows                                  |
| `src/components/ui/`                     | Reusable UI primitives                                              |
| `src/lib/healthpass-*.ts`                | Shared types, API client and sign-in helpers                        |
| `src/styles.css`                         | Shared responsive styles and HealthPass visual tokens               |
| `server/api.mjs`                         | Request handling, authentication and workflow dispatch              |
| `server/roles.mjs`                       | Workspace role templates and effective permissions                  |
| `server/professional-access.mjs`         | Patient sharing and professional access rules                       |
| `server/departments.mjs`                 | Laboratory, radiology and pharmacy orders and outcomes              |
| `server/treatment.mjs`                   | Clinical decisions, prescriptions and medication administration     |
| `server/account-security.mjs`            | Session settings, devices and sign-in activity                      |
| `server/db.mjs` and `server/migrations/` | Transactions and schema history                                     |
| `tests/`                                 | Authentication, permissions and clinical workflow regression checks |

Read the relevant workflow document in `docs/` before changing a clinical or access rule. The current decisions in `docs/foundation.md` supersede the original blueprint.

## Readability conventions

- Run Prettier rather than formatting by hand. The repository uses semicolons, double quotes and a 100-character target line width.
- Declare each variable separately. Keep each React state hook on its own declaration.
- Use braces for conditions and loops, including early returns. This makes the scope of access checks and clinical validation explicit.
- Use names such as `patientId`, `organizationId`, `context` and `isPatient` instead of unexplained abbreviations. `tx` denotes a database transaction.
- Put reusable types and non-UI constants in `src/lib/`, rather than importing them from a component.
- Keep React effect dependencies explicit and use stable callbacks when an effect calls a component function.
- Comments should explain a constraint or decision, especially sharing, signing, idempotency or concurrency rules. Avoid comments that simply repeat the next line.
- Preserve external field names, permission keys, SQL column names and API routes during readability refactors.
- Do not reformat generated files, private local data, lockfiles or the original verbatim blueprint. Never rewrite an applied migration to tidy its formatting.

## Verification commands

```sh
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

The format commands target maintained source, tests and root configuration files. ESLint enforces braces, separate declarations and unused-variable checks in HealthPass frontend code. `npm test` runs shared checks and the integration suites against SQLite and PostgreSQL via PGlite. Use synthetic accounts and records for browser verification.

For refactors, review the diff for changed strings, API shapes, permissions, SQL and ordering of side effects. A successful build alone does not establish that authentication or a clinical workflow still behaves correctly. Check relevant user journeys in the browser before release.

## Cleanup verification — 13 October 2026

The readability sweep expands combined declarations and unbraced control flow across application and test code, clarifies selected backend identifiers, extracts shared role definitions, removes unused frontend code and fixes the workspace's effect dependencies. No schema migration or product rule change is included.

Prettier, TypeScript and the production build pass. ESLint reports no errors; six existing Fast Refresh export warnings remain in shared UI primitives. All 162 regression checks passed across the shared suites and SQLite/PostgreSQL integrations. Browser verification passed 174 role/screen/viewport combinations, plus session preference persistence, request/prescribing dialogs and back/forward navigation. Backend SQL, string and numeric literals were compared with the preceding revision and remain unchanged across all 26 modules.
