import { canConfigureManagement, canManageLocation } from "./ward-management.mjs";
import { proxyTasks } from "./emergency-proxies.mjs";
import { hasPermission } from "./roles.mjs";
import { careAreaAllows } from "./care-area-access.mjs";

/** Live work summaries, not a second store of clinical records or workflow state. */
export async function handleNotifications(tx, context) {
  const { actor, path, method, strong, careAuthority, assignmentAuthority } = context;
  if (path !== "/notifications" || method !== "GET") {
    return undefined;
  }
  strong(actor);
  const now = new Date().toISOString();
  const can = (permission) => hasPermission(actor, permission);
  const counts = {};
  const items = [];
  const add = (id, tab, label, count) => {
    counts[tab] = (counts[tab] ?? 0) + count;
    if (count > 0) {
      items.push({ id, tab, label, count });
    }
  };
  const count = async (sql, args) => Number((await tx.get(sql, args)).count);
  const branchArgs = [actor.organization_id, actor.branch_id ?? null, actor.branch_id ?? null];
  const branchWhere = "organization_id=? AND (CAST(? AS TEXT) IS NULL OR branch_id=?)";
  // Read candidates in bounded batches without truncating the task count to a UI page size.
  async function eligibleCount(sql, args, eligible) {
    let total = 0;
    let after = "";
    while (true) {
      const rows = await tx.all(`${sql} AND id>? ORDER BY id LIMIT 100`, [...args, after]);
      for (const row of rows) {
        try {
          if (await eligible(row)) {
            total++;
          }
        } catch (error) {
          if (![403, 404, 409].includes(error.status)) {
            throw error;
          }
        }
      }
      if (rows.length < 100) {
        return total;
      }
      after = rows.at(-1).id;
    }
  }
  async function mayContribute(patientId, scope, assignment = false) {
    if (!can("records.view") || !actor.clinicalScopes?.includes(scope)) {
      return false;
    }
    const { accessPolicy } = await (assignment ? assignmentAuthority : careAuthority)(
      tx,
      actor,
      patientId,
      true,
    );
    return accessPolicy.canContribute && accessPolicy.contributionScopes.includes(scope);
  }

  add(
    "signin-review",
    "security",
    "Sign-ins to review",
    await count(
      "SELECT COUNT(*) AS count FROM signin_events WHERE user_id=? AND risk<>'normal' AND reviewed_at IS NULL",
      [actor.id],
    ),
  );

  add(
    "proxy-tasks",
    "proxies",
    "Proxy invitations and emergency updates",
    await proxyTasks(tx, actor),
  );

  if (actor.patient_id) {
    add(
      "facility-access",
      "relationships",
      "Facility access requests to review",
      await count(
        "SELECT COUNT(*) AS count FROM facility_access_requests WHERE patient_id=? AND status='pending' AND expires_at>?",
        [actor.patient_id, now],
      ),
    );
    add(
      "registration-codes",
      "sharing",
      "Registration codes awaiting facility linking",
      await count(
        "SELECT COUNT(*) AS count FROM patient_link_invitations i JOIN branches b ON b.id=i.branch_id WHERE i.patient_id=? AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>? AND b.active=1",
        [actor.patient_id, now],
      ),
    );
  } else {
    if (canConfigureManagement(actor) || actor.managementGrants?.length) {
      add(
        "ward-placement",
        "wards",
        "Admitted patients awaiting a room or bed",
        await eligibleCount(
          `SELECT id,care_area_id,branch_id FROM care_admissions WHERE ${branchWhere} AND status='active' AND unit_id IS NULL`,
          branchArgs,
          async (row) => {
            const area = await tx.get("SELECT department_id,active FROM care_areas WHERE id=?", [
              row.care_area_id,
            ]);
            return (
              area?.active &&
              careAreaAllows(actor, row.care_area_id) &&
              canManageLocation(actor, row.branch_id, area.department_id, "placement")
            );
          },
        ),
      );
    }
    if (can("registry.create")) {
      add(
        "registration-invitations",
        "patients",
        "Patient invitations awaiting code review",
        await count(
          `SELECT COUNT(*) AS count FROM patient_link_invitations WHERE ${branchWhere} AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>? AND branch_id IN (SELECT id FROM branches WHERE active=1)`,
          [...branchArgs, now],
        ),
      );
    }
    if (can("primary.manage")) {
      add(
        "primary-requests",
        "relationships",
        "Primary care requests to review",
        await count(
          "SELECT COUNT(*) AS count FROM primary_care_requests WHERE organization_id=? AND status='pending' AND expires_at>?",
          [actor.organization_id, now],
        ),
      );
    }
    if (can("workspace.view") && can("staff.manage")) {
      add(
        "staff-requests",
        "workspace",
        "Professional access requests to review",
        await count(
          "SELECT COUNT(*) AS count FROM memberships WHERE organization_id=? AND active=0 AND review_reference=''",
          [actor.organization_id],
        ),
      );
    }
    if (can("visits.view")) {
      const visitCount = await eligibleCount(
        `SELECT id,patient_id,assigned_user_id,care_area_id FROM care_visits WHERE ${branchWhere} AND status IN ('waiting','in-progress')`,
        branchArgs,
        async (row) => {
          if (!careAreaAllows(actor, row.care_area_id)) {
            return false;
          }
          if (can("visits.manage")) {
            return true;
          }
          if (!can("visits.document") || row.assigned_user_id !== actor.id) {
            return false;
          }
          for (const scope of actor.clinicalScopes ?? []) {
            if (await mayContribute(row.patient_id, scope)) {
              return true;
            }
          }
          return false;
        },
      );
      add("active-visits", "today", "Active visits requiring care or coordination", visitCount);
      if (can("visits.document")) {
        add(
          "handoffs",
          "today",
          "Care handoffs awaiting your response",
          await eligibleCount(
            `SELECT id,visit_id FROM visit_handoffs WHERE ${branchWhere} AND to_user_id=? AND status='pending' AND expires_at>?`,
            [...branchArgs, actor.id, now],
            async (row) => {
              const visit = await tx.get(
                "SELECT patient_id,care_area_id,status FROM care_visits WHERE id=?",
                [row.visit_id],
              );
              if (
                !visit ||
                !["waiting", "in-progress"].includes(visit.status) ||
                !careAreaAllows(actor, visit.care_area_id)
              ) {
                return false;
              }
              for (const scope of actor.clinicalScopes ?? []) {
                if (await mayContribute(visit.patient_id, scope, true)) {
                  return true;
                }
              }
              return false;
            },
          ),
        );
      }
    }
    if (can("referrals.respond")) {
      add(
        "referrals",
        "referrals",
        "Consultant referrals awaiting your response or completion",
        await eligibleCount(
          `SELECT id,patient_id FROM consultant_referrals WHERE ${branchWhere} AND consultant_id=? AND status IN ('pending','scheduled','accepted')`,
          [...branchArgs, actor.id],
          async (row) => {
            // Pending referrals can also be declined; do not expose inaccessible clinical details.
            return mayContribute(row.patient_id, "general");
          },
        ),
      );
    }
    if (can("careteam.manage")) {
      add(
        "consultant-assignment",
        "careteam",
        "Care episodes awaiting a responsible consultant",
        await eligibleCount(
          `SELECT id,care_area_id FROM care_admissions WHERE ${branchWhere} AND status='active' AND NOT EXISTS(SELECT 1 FROM care_responsibilities r WHERE r.admission_id=care_admissions.id AND r.status='active')`,
          branchArgs,
          (row) => careAreaAllows(actor, row.care_area_id),
        ),
      );
    }
    if (can("admissions.view") || can("admissions.manage")) {
      add(
        "admissions",
        "admissions",
        "Active care episodes assigned to you",
        await eligibleCount(
          `SELECT id,patient_id,care_area_id FROM care_admissions WHERE ${branchWhere} AND status='active' AND (EXISTS(SELECT 1 FROM admission_team_members t WHERE t.admission_id=care_admissions.id AND t.user_id=? AND t.active=1) OR EXISTS(SELECT 1 FROM care_responsibilities r WHERE r.admission_id=care_admissions.id AND r.consultant_id=? AND r.status='active'))`,
          [...branchArgs, actor.id, actor.id],
          async (row) => {
            if (!careAreaAllows(actor, row.care_area_id)) {
              return false;
            }
            for (const scope of actor.clinicalScopes ?? []) {
              if (await mayContribute(row.patient_id, scope)) {
                return true;
              }
            }
            return false;
          },
        ),
      );
    }
    const departmentPermissions = {
      laboratory: "laboratory.work",
      radiology: "radiology.work",
      pharmacy: "pharmacy.review",
    };
    if (can("diagnostics.order") || Object.values(departmentPermissions).some(can)) {
      add(
        "department-work",
        "departments",
        "Department requests, reports and reviews to complete",
        await eligibleCount(
          `SELECT id,patient_id,department,status,assigned_to,requested_by FROM department_orders WHERE ${branchWhere} AND status NOT IN ('declined','cancelled')`,
          branchArgs,
          async (row) => {
            const scope = row.department === "pharmacy" ? "medication" : row.department;
            if (
              can("diagnostics.order") &&
              (row.department !== "pharmacy" || can("prescriptions.create")) &&
              actor.clinicalScopes?.includes("general") &&
              ["accepted", "in-progress", "released"].includes(row.status)
            ) {
              const action = row.status === "released" ? "acknowledge" : "respond";
              const outstanding = await tx.get(
                "SELECT id FROM department_events WHERE order_id=? AND action=? AND version>COALESCE((SELECT MAX(version) FROM department_events WHERE order_id=? AND action=?),0) LIMIT 1",
                [row.id, action === "acknowledge" ? "release" : "clarify", row.id, action],
              );
              if (outstanding && (row.requested_by === actor.id || row.status === "released")) {
                try {
                  const { accessPolicy } = await careAuthority(tx, actor, row.patient_id, true);
                  if (
                    accessPolicy.canContribute &&
                    accessPolicy.contributionScopes.includes("general") &&
                    (action === "respond" || accessPolicy.scopes.includes(scope))
                  ) {
                    return true;
                  }
                } catch (error) {
                  if (![403, 404].includes(error.status)) {
                    throw error;
                  }
                  // A denied general-care action does not erase a permitted department assignment.
                }
              }
            }
            if (
              !can(departmentPermissions[row.department]) ||
              !(await mayContribute(row.patient_id, scope, true))
            ) {
              return false;
            }
            if (row.status === "awaiting-report") {
              return can("radiology.report");
            }
            if (row.assigned_to && row.assigned_to !== actor.id) {
              return false;
            }
            if (["requested", "accepted"].includes(row.status)) {
              return true;
            }
            if (row.status === "in-progress") {
              return row.department !== "laboratory" || can("laboratory.report");
            }
            return (
              row.status === "reported" &&
              can(row.department === "pharmacy" ? "pharmacy.fulfil" : row.department + ".release")
            );
          },
        ),
      );
    }
  }
  return { counts, items, total: items.reduce((sum, item) => sum + item.count, 0), updatedAt: now };
}
