import { randomUUID } from "node:crypto";
import { hasPermission, resolveMembership } from "./roles.mjs";
import { careProfessional, handleCareOperations, workflowEvent } from "./care-operations.mjs";
import { careAreaAllows } from "./care-area-access.mjs";

export const managementCapabilities = ["areas", "staff", "placement", "teams"];
export function canConfigureManagement(actor) {
  return (
    !actor.supportAccess &&
    hasPermission(actor, "roles.manage") &&
    hasPermission(actor, "staff.manage")
  );
}
export function canManageLocation(actor, branchId, departmentId, capability) {
  if (
    !actor.organization_id ||
    actor.supportAccess ||
    actor.accessExpired ||
    (actor.branch_id && actor.branch_id !== branchId)
  ) {
    return false;
  }
  if (canConfigureManagement(actor)) {
    return true;
  }
  const denied = actor.deniedPermissions ?? [];
  const permission = {
    areas: "areas.manage",
    staff: "staff.manage",
    placement: "admissions.manage",
    teams: "admissions.manage",
  }[capability];
  if (denied.includes(permission)) {
    return false;
  }
  return (actor.managementGrants ?? []).some(
    (g) =>
      g.branch_id === branchId &&
      (!g.department_id || g.department_id === departmentId) &&
      JSON.parse(g.capabilities).includes(capability),
  );
}

export async function handleWardManagement(tx, context) {
  const { actor, path, method, body, strong, fail, text } = context;
  if (!path.startsWith("/ward-management")) {
    return undefined;
  }
  strong(actor);
  const org = actor.organization_id;
  if (
    !org ||
    actor.supportAccess ||
    (!canConfigureManagement(actor) && !actor.managementGrants?.length)
  ) {
    fail(403, "Ward management is not assigned to this account.");
  }
  // Serialise operational mutations within a facility. This prevents duplicate occupancy,
  // simultaneous room subdivision and stale grant/assignment updates across API instances.
  if (method !== "GET") {
    await tx.run("UPDATE organizations SET name=name WHERE id=?", [org]);
    const membership = await tx.get(
      "SELECT * FROM memberships WHERE user_id=? AND organization_id=? AND active=1",
      [actor.id, org],
    );
    if (!membership) {
      fail(403, "Membership is no longer active.");
    }
    await resolveMembership(tx, membership, actor);
  }
  const branch = async (id) => {
    const row = await tx.get(
      "SELECT * FROM branches WHERE id=? AND organization_id=? AND active=1",
      [id, org],
    );
    if (!row || (actor.branch_id && actor.branch_id !== id)) {
      fail(404, "Branch unavailable.");
    }
    return row;
  };
  const department = async (id) => {
    const row = await tx.get(
      "SELECT * FROM facility_departments WHERE id=? AND organization_id=? AND active=1",
      [id, org],
    );
    if (!row) {
      fail(404, "Department unavailable.");
    }
    await branch(row.branch_id);
    return row;
  };
  const area = async (id, capability) => {
    const row = await tx.get(
      "SELECT * FROM care_areas WHERE id=? AND organization_id=? AND active=1",
      [id, org],
    );
    if (!row) {
      fail(404, "Care area unavailable.");
    }
    await branch(row.branch_id);
    if (
      !canManageLocation(actor, row.branch_id, row.department_id, capability) ||
      !careAreaAllows(actor, row.id)
    ) {
      fail(403, "This action is outside your delegated management scope.");
    }
    return row;
  };
  const member = async (userId, branchId) => {
    const row = await tx.get(
      "SELECT m.*,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.user_id=? AND m.active=1 AND u.active=1 AND u.verified=1 AND u.patient_id IS NULL",
      [org, userId],
    );
    if (!row || (row.branch_id && row.branch_id !== branchId)) {
      fail(403, "Choose an active professional in this branch.");
    }
    return row;
  };
  const event = (row, action, payload) =>
    workflowEvent(tx, context, { ...row, organization_id: org }, action, payload);
  const admin = () => {
    if (!canConfigureManagement(actor)) {
      fail(403, "Only an administrator can configure management delegation.");
    }
  };
  const version = (row) => {
    if (body.version !== row.version) {
      fail(409, "This item changed. Refresh before saving.");
    }
  };
  const reason = () => text(body.reason, "change reason", 500, true);

  if (path === "/ward-management" && method === "GET") {
    const branches = (
      await tx.all(
        "SELECT id,name FROM branches WHERE organization_id=? AND active=1 ORDER BY name",
        [org],
      )
    ).filter(
      (b) =>
        (!actor.branch_id || actor.branch_id === b.id) &&
        (canConfigureManagement(actor) || actor.managementGrants.some((g) => g.branch_id === b.id)),
    );
    const departments = (
      await tx.all(
        "SELECT * FROM facility_departments WHERE organization_id=? AND active=1 ORDER BY name",
        [org],
      )
    ).filter((d) =>
      managementCapabilities.some((c) => canManageLocation(actor, d.branch_id, d.id, c)),
    );
    const areas = (
      await tx.all("SELECT * FROM care_areas WHERE organization_id=? AND active=1 ORDER BY name", [
        org,
      ])
    )
      .filter(
        (a) =>
          careAreaAllows(actor, a.id) &&
          managementCapabilities.some((c) =>
            canManageLocation(actor, a.branch_id, a.department_id, c),
          ),
      )
      .map((a) => ({
        ...a,
        capabilities: managementCapabilities.filter((c) =>
          canManageLocation(actor, a.branch_id, a.department_id, c),
        ),
      }));
    const ids = new Set(areas.map((a) => a.id));
    const units = (
      await tx.all(
        "SELECT u.* FROM ward_units u JOIN care_areas a ON a.id=u.care_area_id WHERE a.organization_id=? ORDER BY u.name",
        [org],
      )
    ).filter((u) => ids.has(u.care_area_id));
    const staff = (
      await tx.all(
        "SELECT m.id,m.user_id,m.branch_id,m.ward_assignment_required,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? AND m.active=1 AND u.active=1 AND u.patient_id IS NULL ORDER BY u.name",
        [org],
      )
    ).filter((m) => branches.some((b) => !m.branch_id || m.branch_id === b.id));
    const assignments = (
      await tx.all(
        "SELECT s.*,u.name AS user_name FROM ward_staff_assignments s JOIN users u ON u.id=s.user_id WHERE s.organization_id=? AND s.active=1 ORDER BY u.name",
        [org],
      )
    ).filter((s) => ids.has(s.care_area_id));
    const admissions = (
      await tx.all(
        "SELECT a.id,a.patient_id,a.care_area_id,a.branch_id,a.unit_id,a.version,p.name AS patient_name,p.healthpass_id FROM care_admissions a JOIN patients p ON p.id=a.patient_id WHERE a.organization_id=? AND a.status='active' ORDER BY a.created_at DESC",
        [org],
      )
    ).filter((a) =>
      areas.some(
        (v) =>
          v.id === a.care_area_id &&
          (v.capabilities.includes("placement") || v.capabilities.includes("teams")),
      ),
    );
    for (const a of admissions) {
      a.team = await tx.all(
        "SELECT t.user_id,t.duty,u.name FROM admission_team_members t JOIN users u ON u.id=t.user_id WHERE t.admission_id=? AND t.active=1",
        [a.id],
      );
    }
    const grants = canConfigureManagement(actor)
      ? (
          await tx.all(
            "SELECT g.*,u.name AS user_name FROM management_grants g JOIN users u ON u.id=g.user_id WHERE g.organization_id=? AND g.active=1",
            [org],
          )
        ).filter((g) => branches.some((b) => b.id === g.branch_id))
      : actor.managementGrants;
    const history = (
      await tx.all(
        "SELECT e.action,e.object_id,e.payload,e.created_at,u.name AS actor_name FROM care_workflow_events e JOIN users u ON u.id=e.actor_id WHERE e.organization_id=? AND e.action LIKE 'ward.%' ORDER BY e.created_at DESC LIMIT 200",
        [org],
      )
    ).filter((e) =>
      canConfigureManagement(actor)
        ? branches.some((b) => b.id === JSON.parse(e.payload).branch_id)
        : ids.has(JSON.parse(e.payload).area_id),
    );
    return {
      canConfigure: canConfigureManagement(actor),
      branches,
      departments,
      areas,
      units,
      staff,
      assignments,
      admissions,
      grants,
      history,
    };
  }
  if (path === "/ward-management/departments" && method === "POST") {
    const b = await branch(body.branch_id);
    if (!canManageLocation(actor, b.id, null, "areas")) {
      fail(
        403,
        "Only a branch manager with area controls or an administrator can create departments.",
      );
    }
    const name = text(body.name, "department name", 100, true);
    if (
      await tx.get(
        "SELECT id FROM facility_departments WHERE branch_id=? AND LOWER(name)=LOWER(?)",
        [b.id, name],
      )
    ) {
      fail(409, "This department already exists.");
    }
    const id = randomUUID();
    const stamp = new Date().toISOString();
    await tx.run(
      "INSERT INTO facility_departments(id,organization_id,branch_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [id, org, b.id, name, stamp, stamp],
    );
    await event({ id }, "ward.department_created", { branch_id: b.id, name });
    return { id };
  }
  if (path === "/ward-management/grants" && method === "POST") {
    admin();
    const b = await branch(body.branch_id);
    await member(body.user_id, b.id);
    if (body.user_id === actor.id) {
      fail(400, "Another administrator must configure your management assignment.");
    }
    if (body.department_id && (await department(body.department_id)).branch_id !== b.id) {
      fail(400, "Department belongs to another branch.");
    }
    if (
      !Array.isArray(body.capabilities) ||
      !body.capabilities.length ||
      body.capabilities.some((c) => !managementCapabilities.includes(c))
    ) {
      fail(400, "Choose supported management controls.");
    }
    if (
      await tx.get(
        "SELECT id FROM management_grants WHERE organization_id=? AND user_id=? AND branch_id=? AND COALESCE(department_id,'')=? AND active=1",
        [org, body.user_id, b.id, body.department_id || ""],
      )
    ) {
      fail(409, "This management assignment already exists. Edit its controls instead.");
    }
    const id = randomUUID();
    const stamp = new Date().toISOString();
    await tx.run(
      "INSERT INTO management_grants(id,organization_id,branch_id,department_id,user_id,capabilities,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        id,
        org,
        b.id,
        body.department_id || null,
        body.user_id,
        JSON.stringify([...new Set(body.capabilities)]),
        stamp,
        stamp,
      ],
    );
    await event({ id }, "ward.manager_assigned", {
      branch_id: b.id,
      department_id: body.department_id || null,
      user_id: body.user_id,
      capabilities: body.capabilities,
      reason: reason(),
    });
    return { id };
  }
  const editGrant = path.match(/^\/ward-management\/grants\/([^/]+)$/);
  if (editGrant && method === "PATCH") {
    admin();
    const grant = await tx.get(
      "SELECT * FROM management_grants WHERE id=? AND organization_id=? AND active=1",
      [editGrant[1], org],
    );
    if (!grant) {
      fail(404, "Management assignment unavailable.");
    }
    await branch(grant.branch_id);
    version(grant);
    if (grant.user_id === actor.id) {
      fail(400, "Another administrator must review your management controls.");
    }
    if (
      !Array.isArray(body.capabilities) ||
      !body.capabilities.length ||
      body.capabilities.some((c) => !managementCapabilities.includes(c))
    ) {
      fail(400, "Choose supported management controls.");
    }
    await tx.run(
      "UPDATE management_grants SET capabilities=?,version=version+1,updated_at=? WHERE id=?",
      [JSON.stringify([...new Set(body.capabilities)]), new Date().toISOString(), grant.id],
    );
    await event(grant, "ward.manager_controls_changed", {
      branch_id: grant.branch_id,
      user_id: grant.user_id,
      before: JSON.parse(grant.capabilities),
      after: body.capabilities,
      reason: reason(),
    });
    return { updated: true };
  }
  const grantMatch = path.match(/^\/ward-management\/grants\/([^/]+)\/revoke$/);
  if (grantMatch && method === "POST") {
    admin();
    const g = await tx.get(
      "SELECT * FROM management_grants WHERE id=? AND organization_id=? AND active=1",
      [grantMatch[1], org],
    );
    if (!g) {
      fail(404, "Assignment unavailable.");
    }
    await branch(g.branch_id);
    version(g);
    if (g.user_id === actor.id) {
      fail(400, "Another administrator must review your assignment.");
    }
    await tx.run(
      "UPDATE management_grants SET active=0,version=version+1,updated_at=? WHERE id=?",
      [new Date().toISOString(), g.id],
    );
    await event(g, "ward.manager_removed", {
      branch_id: g.branch_id,
      user_id: g.user_id,
      reason: reason(),
    });
    return { updated: true };
  }
  if (path === "/ward-management/areas" && method === "POST") {
    const d = await department(body.department_id);
    if (!canManageLocation(actor, d.branch_id, d.id, "areas")) {
      fail(403, "Area creation is not delegated here.");
    }
    const name = text(body.name, "ward name", 100, true);
    if (!["ward", "observation", "outpatient"].includes(body.kind)) {
      fail(400, "Choose a care-area type.");
    }
    if (
      await tx.get("SELECT id FROM care_areas WHERE branch_id=? AND LOWER(name)=LOWER(?)", [
        d.branch_id,
        name,
      ])
    ) {
      fail(409, "Area name already exists in this branch.");
    }
    const id = randomUUID();
    const stamp = new Date().toISOString();
    await tx.run(
      "INSERT INTO care_areas(id,organization_id,branch_id,department_id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [id, org, d.branch_id, d.id, name, body.kind, stamp, stamp],
    );
    await event({ id }, "ward.area_created", { area_id: id, branch_id: d.branch_id, name });
    const quantity = Number(body.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100) {
      fail(400, "Choose zero to 100 initial units.");
    }
    if (quantity > 0) {
      await handleWardManagement(tx, {
        ...context,
        path: "/ward-management/units",
        body: {
          care_area_id: id,
          kind: body.unit_kind,
          quantity,
          prefix: body.unit_kind === "bed" ? "Bed" : "Room",
        },
      });
    }
    return { id };
  }
  const linkMatch = path.match(/^\/ward-management\/areas\/([^/]+)\/department$/);
  if (linkMatch && method === "POST") {
    admin();
    const a = await area(linkMatch[1], "areas");
    const d = await department(body.department_id);
    if (d.branch_id !== a.branch_id) {
      fail(400, "Use a department in the same branch.");
    }
    await tx.run("UPDATE care_areas SET department_id=?,updated_at=? WHERE id=?", [
      d.id,
      new Date().toISOString(),
      a.id,
    ]);
    await event(a, "ward.department_linked", {
      area_id: a.id,
      branch_id: a.branch_id,
      from: a.department_id,
      to: d.id,
      reason: reason(),
    });
    return { updated: true };
  }
  if (path === "/ward-management/units" && method === "POST") {
    const a = await area(body.care_area_id, "areas");
    if (a.kind === "outpatient") {
      fail(400, "Rooms and beds are for wards or observation areas.");
    }
    const quantity = Number(body.quantity);
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 100 ||
      !["room", "bed"].includes(body.kind)
    ) {
      fail(400, "Choose 1–100 rooms or beds.");
    }
    const prefix = text(body.prefix, "unit name prefix", 80, true);
    if (body.parent_id) {
      const parent = await tx.get(
        "SELECT * FROM ward_units WHERE id=? AND care_area_id=? AND active=1 AND kind='room'",
        [body.parent_id, a.id],
      );
      if (!parent || body.kind !== "bed") {
        fail(400, "Beds can only belong to an active room in this ward.");
      }
      if (
        await tx.get("SELECT id FROM care_admissions WHERE unit_id=? AND status='active'", [
          parent.id,
        ])
      ) {
        fail(409, "Move the occupant before adding beds to this room.");
      }
    }
    for (let i = 1; i <= quantity; i++) {
      const name = `${prefix} ${i}`;
      if (
        await tx.get("SELECT id FROM ward_units WHERE care_area_id=? AND LOWER(name)=LOWER(?)", [
          a.id,
          name,
        ])
      ) {
        fail(409, "A unit with this name already exists. Choose another prefix.");
      }
      const stamp = new Date().toISOString();
      await tx.run(
        "INSERT INTO ward_units(id,care_area_id,parent_id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        [randomUUID(), a.id, body.parent_id || null, body.kind, name, stamp, stamp],
      );
    }
    await event(a, "ward.units_created", {
      area_id: a.id,
      branch_id: a.branch_id,
      quantity,
      kind: body.kind,
      prefix,
      parent_id: body.parent_id || null,
    });
    return { created: quantity };
  }
  const unitMatch = path.match(/^\/ward-management\/units\/([^/]+)$/);
  if (unitMatch && method === "PATCH") {
    const u = await tx.get("SELECT * FROM ward_units WHERE id=?", [unitMatch[1]]);
    if (!u) {
      fail(404, "Unit unavailable.");
    }
    const a = await area(u.care_area_id, "areas");
    version(u);
    const name = text(body.name, "unit name", 100, true);
    if (typeof body.active !== "boolean") {
      fail(400, "Choose whether this unit is open.");
    }
    if (
      await tx.get(
        "SELECT id FROM ward_units WHERE care_area_id=? AND LOWER(name)=LOWER(?) AND id<>?",
        [a.id, name, u.id],
      )
    ) {
      fail(409, "This unit name is already used.");
    }
    if (
      !body.active &&
      ((await tx.get(
        "SELECT id FROM care_admissions WHERE status='active' AND (unit_id=? OR unit_id IN (SELECT id FROM ward_units WHERE parent_id=?))",
        [u.id, u.id],
      )) ||
        (await tx.get("SELECT id FROM ward_units WHERE parent_id=? AND active=1", [u.id])))
    ) {
      fail(409, "Move occupants and close child beds before closing this unit.");
    }
    if (
      body.active &&
      u.parent_id &&
      !(await tx.get("SELECT id FROM ward_units WHERE id=? AND active=1", [u.parent_id]))
    ) {
      fail(409, "Reopen the parent room first.");
    }
    await tx.run(
      "UPDATE ward_units SET name=?,active=?,version=version+1,updated_at=? WHERE id=?",
      [name, body.active ? 1 : 0, new Date().toISOString(), u.id],
    );
    await event(u, "ward.unit_updated", {
      area_id: a.id,
      branch_id: a.branch_id,
      before: { name: u.name, active: u.active },
      after: { name, active: body.active },
      reason: reason(),
    });
    return { updated: true };
  }
  if (path === "/ward-management/staff" && method === "POST") {
    const a = await area(body.care_area_id, "staff");
    const m = await member(body.user_id, a.branch_id);
    if (m.is_owner || body.user_id === actor.id) {
      fail(400, "An administrator must manage coverage for another non-owner professional.");
    }
    const target = await careProfessional(tx, body.user_id, org, a.branch_id);
    const scope = body.duty === "doctor" ? "general" : body.duty === "nurse" ? "nursing" : null;
    if (
      !target ||
      !scope ||
      !target.clinicalScopes.includes(scope) ||
      !hasPermission(target, "records.view") ||
      !careAreaAllows(target, a.id)
    ) {
      fail(403, "Choose a reviewed doctor or nurse whose existing permissions cover this ward.");
    }
    if (
      body.unit_id &&
      !(await tx.get("SELECT id FROM ward_units WHERE id=? AND care_area_id=? AND active=1", [
        body.unit_id,
        a.id,
      ]))
    ) {
      fail(400, "Unit unavailable in this ward.");
    }
    if (
      await tx.get(
        "SELECT id FROM ward_staff_assignments WHERE user_id=? AND care_area_id=? AND COALESCE(unit_id,'')=? AND active=1",
        [body.user_id, a.id, body.unit_id || ""],
      )
    ) {
      fail(409, "This coverage is already assigned.");
    }
    const id = randomUUID();
    const stamp = new Date().toISOString();
    await tx.run(
      "INSERT INTO ward_staff_assignments(id,organization_id,care_area_id,unit_id,user_id,duty,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [id, org, a.id, body.unit_id || null, body.user_id, body.duty, stamp, stamp],
    );
    await tx.run(
      "UPDATE memberships SET ward_assignment_required=1,access_policy_version=access_policy_version+1 WHERE id=?",
      [m.id],
    );
    await event({ id }, "ward.staff_assigned", {
      area_id: a.id,
      branch_id: a.branch_id,
      user_id: body.user_id,
      unit_id: body.unit_id || null,
      duty: body.duty,
      reason: reason(),
    });
    return { id };
  }
  const staffMatch = path.match(/^\/ward-management\/staff\/([^/]+)\/remove$/);
  if (staffMatch && method === "POST") {
    const s = await tx.get(
      "SELECT * FROM ward_staff_assignments WHERE id=? AND organization_id=? AND active=1",
      [staffMatch[1], org],
    );
    if (!s) {
      fail(404, "Coverage unavailable.");
    }
    const a = await area(s.care_area_id, "staff");
    version(s);
    if (s.user_id === actor.id) {
      fail(400, "Another manager must review your coverage.");
    }
    await tx.run(
      "UPDATE ward_staff_assignments SET active=0,version=version+1,updated_at=? WHERE id=?",
      [new Date().toISOString(), s.id],
    );
    await event(s, "ward.staff_removed", {
      area_id: a.id,
      branch_id: a.branch_id,
      user_id: s.user_id,
      reason: reason(),
    });
    return { updated: true };
  }
  const unrestrictedMatch = path.match(/^\/ward-management\/staff\/([^/]+)\/unrestrict$/);
  if (unrestrictedMatch && method === "POST") {
    admin();
    const m = await tx.get(
      "SELECT * FROM memberships WHERE user_id=? AND organization_id=? AND active=1",
      [unrestrictedMatch[1], org],
    );
    if (!m || (actor.branch_id && m.branch_id !== actor.branch_id)) {
      fail(404, "Member unavailable.");
    }
    if (m.user_id === actor.id) {
      fail(400, "Another administrator must review your coverage.");
    }
    await tx.run(
      "UPDATE memberships SET ward_assignment_required=0,access_policy_version=access_policy_version+1 WHERE id=?",
      [m.id],
    );
    await event(m, "ward.coverage_restriction_removed", {
      branch_id: m.branch_id,
      reason: reason(),
    });
    return { updated: true };
  }
  const placementMatch = path.match(/^\/ward-management\/admissions\/([^/]+)\/(place|team)$/);
  if (placementMatch && method === "POST") {
    const r = await tx.get(
      "SELECT * FROM care_admissions WHERE id=? AND organization_id=? AND status='active'",
      [placementMatch[1], org],
    );
    if (!r) {
      fail(404, "Active admission unavailable.");
    }
    const capability = placementMatch[2] === "team" ? "teams" : "placement";
    const source = await area(r.care_area_id, capability);
    version(r);
    if (placementMatch[2] === "team") {
      const scoped = {
        ...actor,
        permissions: [...actor.permissions, "admissions.manage"],
        careAreaRestricted: true,
        careAreaIds: [source.id],
      };
      return handleCareOperations(tx, {
        ...context,
        actor: scoped,
        path: `/admissions/${r.id}/team`,
      });
    }
    const target = await area(body.care_area_id, "placement");
    if (target.branch_id !== r.branch_id || target.kind === "outpatient") {
      fail(400, "Use a ward in the same branch.");
    }
    await tx.run("UPDATE patients SET id=id WHERE id=?", [r.patient_id]);
    const fresh = await tx.get("SELECT * FROM care_admissions WHERE id=?", [r.id]);
    if (fresh.status !== "active" || fresh.version !== body.version) {
      fail(409, "Admission changed. Refresh before placement.");
    }
    if (
      target.id !== source.id &&
      (await tx.get(
        "SELECT id FROM care_visits WHERE patient_id=? AND organization_id=? AND care_area_id=? AND status IN ('waiting','in-progress')",
        [r.patient_id, org, source.id],
      ))
    ) {
      fail(409, "Complete or cancel active ward visits before transferring.");
    }
    if (body.unit_id) {
      const u = await tx.get(
        "SELECT * FROM ward_units WHERE id=? AND care_area_id=? AND active=1",
        [body.unit_id, target.id],
      );
      if (!u) {
        fail(400, "Choose an open unit in the target ward.");
      }
      if (await tx.get("SELECT id FROM ward_units WHERE parent_id=? AND active=1", [u.id])) {
        fail(400, "Choose a bed within this room.");
      }
      if (
        u.parent_id &&
        !(await tx.get("SELECT id FROM ward_units WHERE id=? AND active=1", [u.parent_id]))
      ) {
        fail(409, "The parent room is closed.");
      }
      if (
        await tx.get(
          "SELECT id FROM care_admissions WHERE unit_id=? AND status='active' AND id<>?",
          [u.id, r.id],
        )
      ) {
        fail(409, "This unit is occupied.");
      }
    }
    await tx.run(
      "UPDATE care_admissions SET unit_id=?,care_area_id=?,kind=?,version=version+1 WHERE id=?",
      [
        body.unit_id || null,
        target.id,
        target.kind === "observation" ? "observation" : "inpatient",
        r.id,
      ],
    );
    await event(r, "ward.patient_placed", {
      area_id: target.id,
      branch_id: r.branch_id,
      from_area: source.id,
      from_unit: r.unit_id,
      to_unit: body.unit_id || null,
      reason: reason(),
    });
    return { updated: true };
  }
  fail(404, "Management action unavailable.");
}
