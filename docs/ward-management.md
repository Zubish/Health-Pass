# Branch, department and ward management

Confirmed by the owner on 16 October 2026: implement branch managers, department heads, administrator-controlled delegation, named ward units, doctor/nurse coverage and inpatient placement. This extends care areas and care episodes; it does not replace job roles, sharing policy or physician decisions.

## Management scope

**Wards & departments** is a professional sidebar destination. Existing administrators with both role and staff management can configure it within their existing branch boundary. They assign an active professional either a branch or a particular department, and select supported controls: areas/units, doctor/nurse coverage, inpatient placement/transfers and inpatient care teams. Controls can be edited or revoked with a reason and version check. They never add workspace role-editing, global staff administration, clinical permissions or permission to redelegate. Multiple assignments may coexist; an individual denial overrides the corresponding delegated control. Branch, membership, support status and grant authority are checked on each request.

A department belongs to a branch. A care area can be linked to its department by the administrator; existing areas are preserved without guessed department assignments. Branch managers with area controls can create departments; department heads can create areas within their department. Administrative management access alone does not expose clinical notes or permit prescribing.

## Rooms and beds

Create an inpatient ward or observation area with zero to 100 initial named rooms or beds. For example, Female ward with ten rooms creates Room 1–Room 10. Add more batches with a different prefix, or add beds under an existing room. Each unit can be renamed and closed/reopened with a reason. There is no destructive delete control.

A room without child beds is a single placement unit. A shared room uses individually named beds; patients are placed in those beds, not the parent room. A unique active-occupancy index prevents double booking. Occupied rooms cannot be subdivided, and occupied units cannot be closed. Close child beds before closing their room. Names and placement changes are preserved in append-only workflow history.

## Staff coverage and patient care

Assign reviewed doctors and nurses to a whole ward, a room or a bed. Room coverage includes its beds. Existing role permissions, individual care-area restrictions, credential checks and patient sharing still apply. Coverage supplies the appropriate general/nursing inpatient participation for permitted work; it does not establish consultant responsibility or grant another discipline's privileges.

**Starting coverage makes the professional inpatient-coverage restricted.** Only patients currently admitted within their active assigned locations are available. Assign every required location. Removing the last assignment leaves access restricted rather than restoring global access. An administrator can explicitly restore the person's normal role/care-area scope, with a reason, when they return to outpatient or broader work. Owner accounts and self-assignment are excluded from this coverage control. Existing users are unchanged until coverage is assigned.

Patient-specific team assignments remain available to delegated heads. Responsible consultant assignment remains the existing separate workflow. Placement is available only for active admission/observation episodes. Managers need authority over both source and destination for a transfer; transfers stay within the admission's branch. Active ward visits must be resolved before a ward transfer. Admission/discharge clinical decisions are separate. Ending an episode releases occupancy while retaining its historical placement. Existing ward-move actions clear a previous room/bed allocation to avoid keeping a unit from the former ward.

Patient and professional admission views display the named room/bed. A task count on Wards & departments shows admitted patients awaiting placement within the manager's scope; it clears after placement or episode closure. Opening the panel does not resolve placement work.

## Implementation and verification

Migration 020 adds departments, management grants, ward units, coverage assignments and the current admission unit. No existing clinical records, job permissions, wards or assignments are rewritten. The existing immutable `care_workflow_events` table records actor, timestamp, reason and before/after placement or management details. Operational writes serialize on the facility row; placement additionally locks the patient and rechecks the current episode version. Clinical access continues through the central patient-access guard.

The new API is `/ward-management`, with subroutes for departments, grants, areas, units, staff and admission placement/team changes. Only the dedicated scoped routes consume management grants; they do not confer access to the old unrestricted workspace-management endpoints.

Synthetic integration checks cover department and branch isolation, role-escalation denial, immediate revocation, individual denials, room/bed occupancy, stale versions, closed units, transfers, episode release, immutable history, restricted patient reads, fail-closed coverage removal and permitted ward documentation. Both SQLite and PostgreSQL/PGlite are exercised. Release evidence is recorded below after deployment verification.

Local verification: the 190-check regression suite passed across SQLite and PostgreSQL/PGlite. The final six ward-management integration cases were separately rerun on both engines after adding editable delegation and placement counts; all passed. Type checking, production build and affected-file lint passed; global lint has only the six existing UI Fast Refresh warnings. Browser checks created a department and ten rooms, renamed a room, assigned a department head, verified refresh persistence and checked page/dialog overflow at 320, 390, 768, 1024 and 1440px. Only synthetic local fixtures were used.

Production release: code `292d1ecf000e9afd15d9b5e47c70ca9b51c41a09` is pushed and deployed as Neon API 27 (completed) and Vercel production `dpl_52vZYU2JEG8nz4PsiVNMzJcxP48r` (READY). Migration 020 is applied. The canonical `health-pass-psi.vercel.app` alias was confirmed on this deployment.

Runtime grants required for this migration are SELECT/INSERT/UPDATE on `facility_departments`, `management_grants`, `ward_units` and `ward_staff_assignments`, plus column-level `UPDATE(name)` on `organizations` for the existing-value facility lock. The first hosted create-department check exposed the missing lock permission; the narrow grant was applied and the real workflow then passed. No table-wide organization UPDATE, DELETE, schema mutation or audit-history rewrite permission was added.

Final browser verification additionally assigned doctor coverage and placed an admitted synthetic patient in a room, checking the saved API placement. Hosted checks passed owner and GP sign-in, department/room creation, department isolation, denial of redelegation, immediate revocation and phone/tablet/desktop layout. The temporary synthetic manager grant was revoked in cleanup. Hosted verification created only clearly labelled synthetic facility metadata; no real patient or clinical record was changed.
