# Role exceptions, care areas and consultant workflows

Owner-approved scope, 12 October 2026: implement the role/permission and care-workflow discussion through the inpatient/outpatient distinction. Reuse existing editable workspace roles and multiple-role memberships. Individual exceptions restrict inherited permissions; they do not manufacture additional capabilities. The owner accepted the proposed distinction between specialist advice and transfer of care in requesting implementation of the full discussion.

## Role defaults and individual restrictions

Common role templates remain application-defined starting points. Administrators edit their own workspace's copies or create custom roles, including senior/lead roles. One role edit applies to everyone assigned that role; assigning staff selects roles rather than repeating every permission. Individual restrictions are a separate staff-access form, with a Disable charting preset and a Use role defaults action. Checked permissions are disabled across all assigned roles. Dependencies are pruned: disabling clinical-record access also disables documenting, signing, observations, follow-ups and clinical referrals. Restrictions survive role edits and subsequent staff approvals. Changes need a reason and current policy version, and write immutable workflow history plus the facility audit.

New capabilities appear in the permission catalog and current starter templates. Migration 013 does not expand existing editable role rows. Administrators review new clinical permissions before enabling them for existing roles. Workspace creators retain the application-defined core administration capabilities, including configuring care areas and recorded admission episodes; this creates no clinical authority. They cannot change their own professional review through staff management or remove protected creator administration permissions through individual restrictions.

The Consultant template is separate from the GP template. GPs start with referral creation; consultant response requires a consultant qualification review recorded on the membership as well as reviewed general medical scope and the relevant role permissions. Merely adding referral-response permission, renaming a role or creating a specialty title cannot establish specialist qualification. The administrator remains responsible for credential review for intended services; no external licensing or specialty registry is connected.

## Departments, wards and observation areas

Care areas belong to a facility branch and have an application-defined type: outpatient department, inpatient ward or observation area. Administrators can create, rename, archive and reactivate them; they cannot convert the type after creation. Active episodes and visits prevent archival. Individual staff scopes can select one or more active areas in that member's branch; unrestricted scope still requires valid roles, reviewed credentials and patient sharing.

For restricted professionals, a patient's active ward/observation admission takes precedence over an earlier OPD visit. Otherwise an active visit in a selected outpatient department supplies location context. Unknown location, inactive area and a membership moved to a different branch fail closed. The API filters registry/visit metadata and enforces scope on clinical reads and writes; named patient grants do not override these facility restrictions, including delegation chains. Scope changes do not delete records or grant access at another facility.

## Inpatient care episodes and supporting teams

Administrators or staff granted admissions.manage open a recorded inpatient/observation episode for a locally registered patient in a ward/observation area. One active episode per patient per facility is enforced, with patient-row locking, a unique active key and retry identifiers. A typed ward label or outpatient visit alone does not establish admission status.

Each episode can have the existing accountable consultant plus multiple supporting doctors, nurses and medication professionals. Supporting duties must match reviewed general medical, nursing or medication scopes. Assignment rechecks roles, individual restrictions, branch/area scope and independent patient access. Patient grants are never created by assignment. Active inpatient care writes require current membership of that patient's episode team or its responsible-consultant assignment. Ward visit routing uses the actual episode area and an assigned team professional. General chart-note tools and source ownership are retained.

The administrator can move an episode between ward/observation areas in the same branch, update the supporting team, reassign the accountable consultant and record episode end. Resolve active ward visits before moving or ending the episode. Ending closes active supporting assignments and the episode-linked consultant responsibility, preserves signed records and all history, and does not sign a clinical discharge decision. The accountable consultant is independent of the doctor/nurse documenting an individual visit. Ending or reassigning an old unlinked responsibility is not a new admission. Historical ongoing responsibilities remain readable and may be ended; new assignments require an active inpatient/observation episode. The live area is displayed separately from historical assignment labels.

This is a recorded care-episode and team workflow, not bed occupancy, discharge prescriptions, billing, consultant co-signing or a full admission/discharge module. Inpatient access cannot bypass patient-controlled sharing. Duty history remains after staff roles, scope or access are withdrawn.

## Outpatient consultant referrals

A GP—or another reviewed professional explicitly granted referrals.create—refers using their own signed record within their reviewed clinical category and branch. Consultant options require separately reviewed consultant qualifications, general medical scope, response/documentation/signing permissions and location scope. Before creation or acceptance, the consultant must independently have the patient's permission to read the source category and contribute general medical care. Only the sender and recipient see their professional referral inbox; patients see their own cross-facility referral metadata. Administrators do not receive clinical referral-source access through administration permissions.

Two purposes are explicit:

- **Specialist advice:** the referring professional keeps visit responsibility. The consultant writes and signs their own consultation record.
- **Transfer of care:** requires the sender's current in-progress visit, a signed source, no outgoing drafts and no pending visit handoff. The sender remains responsible until explicit acceptance/start. Pending/scheduled transfers must be resolved or withdrawn before completing that visit.

The consultant selects Accept, then Accept now or Schedule. Scheduling requires a future date/time, including later today. A scheduled transfer retains GP responsibility until the scheduled time arrives and the consultant explicitly starts it; this does not run an automatic timer transfer. The consultant can reschedule or cancel a scheduled consultation with a reason; the sender may withdraw pending/scheduled referrals. Decline opens a reason form and requires confirmation. Each transition is version-guarded and retains immutable workflow events. Times are stored in UTC and presented by the user's browser.

At acceptance/start, patient sharing, staff roles, individual restrictions, area/branch scope, specialist review, signed-source version, sender responsibility and unfinished visit work are rechecked. A stale or amended pending source needs a new referral. Accepted transfer participants retain permitted historical access and source authorship; new visit care remains with the current assignee. The recipient never edits the GP's signed source. After consultation the consultant links their own signed general medical response recorded and signed for this referral. Transfer completion also completes the consultant's active visit, or links an already completed visit, without changing note authors or follow-up ownership.

The schedule records a consultation appointment; it does not promise calendar availability, booking-conflict detection, reminders, email delivery or an external referral integration. Inpatient/observation patients use their episode team rather than this outpatient referral path.

## Administrator configuration boundaries

Configurable: workspace role names/default permissions, senior/lead roles, individual restrictions, approved staff/branches, care-area names and staffing assignments. Only supported application permissions can be granted. Clinical review and consultant qualification review are explicit professional checks, not a role-title shortcut.

Application-controlled: identity and tenant isolation, patient consent, permission-denial precedence, credential review gates, admission/referral distinction, supported duty/area types, required decision reasons, valid state transitions, immutable signed records, source ownership, version/retry guards and audit history. Administrators cannot create arbitrary permission keys, redefine workflow transitions or bypass those protections.

## Persistence and validation

Migration 013 adds membership policy/consultant-review fields, care areas, care admissions, supporting team memberships, episode links on consultant responsibilities, visit location and consultant referrals, with append-only care_workflow_events. Runtime roles receive only the required table operations; workflow history has SELECT/INSERT and immutable database triggers, never UPDATE/DELETE. Existing membership-role grants, signed-note/audit protections and session policy stay in force.

The first directories are bounded to 100 registered-patient/professional choices and 200 care areas; lists show up to 100 episodes/referrals and the latest 30 episode events. An episode allows up to 50 active supporting staff, with 100 displayed active/former team entries. Larger installations require directory/list pagination rather than silently assuming every record is visible. All validation and browser fixtures use synthetic identities and clinical text.

Inpatient supporting teams can include a pharmacist or pharmacy technician for medication care. Team assignment never expands their reviewed clinical scope or restores individually disabled permissions. Cancelling an outpatient visit also cancels its pending or scheduled transfer requests, retaining the referral and decision history.

## Verification (12 October 2026)

Targeted SQLite and isolated PostgreSQL 17 checks pass for eleven care-operation scenarios, including independent concurrent sessions, scope restrictions, source preservation, consultant scheduling and medication-team boundaries. Browser checks cover administrator care-area/team setup on desktop, ward and referral screens on mobile, source preview, scheduled transfer through an independently signed consultant response, completion, refresh persistence, and tablet decline with a required reason. No real patient information is used. TypeScript and the production build pass; lint has zero errors and eleven existing React dependency/refresh warnings. Existing role permissions are preserved; workspace administrators must review and enable new clinical capabilities and confirm consultant qualifications before staff use them.
