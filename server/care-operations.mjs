import { randomUUID } from "node:crypto";
import { hash } from "./security.mjs";
import { hasPermission, resolveMembership, permissionCatalog, ownerPermissions } from "./roles.mjs";
import { careAreaAllows, careAreaPatientPredicate } from "./care-area-access.mjs";
const now = () => new Date().toISOString();
export async function careProfessional(tx, id, org, branch) {
  const user = await tx.get(
    "SELECT * FROM users WHERE id=? AND active=1 AND verified=1 AND patient_id IS NULL",
    [id],
  );
  const membership =
    user &&
    (await tx.get("SELECT * FROM memberships WHERE user_id=? AND organization_id=? AND active=1", [
      id,
      org,
    ]));
  if (!membership || (membership.branch_id && membership.branch_id !== branch)) return null;
  user.organization_id = org;
  user.branch_id = membership.branch_id;
  await resolveMembership(tx, membership, user);
  return user.supportAccess || user.accessExpired ? null : user;
}
export async function workflowEvent(tx, c, row, action, payload) {
  await tx.run(
    "INSERT INTO care_workflow_events(id,organization_id,patient_id,object_id,actor_id,action,payload,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      randomUUID(),
      row.organization_id,
      row.patient_id ?? null,
      row.id,
      c.actor.id,
      action,
      JSON.stringify(payload),
      now(),
    ],
  );
  await c.audit(tx, c.actor, action, "allow", row.patient_id ?? null, row.id, c.correlation);
}
export async function handleCareOperations(tx, c) {
  const { actor, path, method, body, permit, strong, fail, text, careAuthority } = c;
  if (
    !path.startsWith("/care-areas") &&
    !path.startsWith("/admissions") &&
    !/^\/workspace\/members\/[^/]+\/restrictions$/.test(path)
  )
    return undefined;
  strong(actor);
  const org = actor.organization_id,
    patient = !org && !!actor.patient_id;
  const branch = async (id) => {
    id = text(id ?? actor.branch_id, "branch ID", 100, true);
    const b = await tx.get("SELECT * FROM branches WHERE id=? AND organization_id=? AND active=1", [
      id ?? actor.branch_id,
      org,
    ]);
    if (!b || (actor.branch_id && b.id !== actor.branch_id))
      fail(403, "Choose an active branch within your workspace access.");
    return b;
  };
  const area = async (id, lock = false) => {
    id = text(id, "care-area ID", 100, true);
    let a = await tx.get("SELECT * FROM care_areas WHERE id=? AND organization_id=? AND active=1", [
      id,
      org,
    ]);
    if (!a || !careAreaAllows(actor, a.id))
      fail(403, "Care area unavailable within your assigned scope.");
    await branch(a.branch_id);
    if (lock) {
      await tx.run("UPDATE care_areas SET id=id WHERE id=?", [a.id]);
      a = await tx.get("SELECT * FROM care_areas WHERE id=? AND active=1", [a.id]);
      if (!a) fail(409, "This care area was archived. Refresh before continuing.");
    }
    return a;
  };
  const registered = async (id, branchId) => {
    if (
      !(await tx.get(
        "SELECT p.id FROM patients p JOIN branch_patient_links l ON l.patient_id=p.id JOIN branches b ON b.id=l.branch_id WHERE p.id=? AND b.organization_id=? AND l.branch_id=?",
        [id, org, branchId],
      ))
    )
      fail(404, "Patient is not registered in this branch.");
  };
  const policyMatch = path.match(/^\/workspace\/members\/([^/]+)\/restrictions$/);
  if (policyMatch && method === "PATCH") {
    permit(actor, "staff.manage");
    const member = await tx.get("SELECT * FROM memberships WHERE id=? AND organization_id=?", [
      policyMatch[1],
      org,
    ]);
    if (!member) fail(404, "Membership unavailable.");
    if (member.user_id === actor.id)
      fail(400, "Another administrator must review your own restrictions.");
    if (actor.branch_id && member.branch_id !== actor.branch_id)
      fail(403, "Membership is outside your branch.");
    if (
      !Array.isArray(body.denied_permissions) ||
      body.denied_permissions.some((p) => !permissionCatalog.some((v) => v.key === p))
    )
      fail(400, "Choose supported individual permission restrictions.");
    const denied = [...new Set(body.denied_permissions)].sort();
    if (member.is_owner && denied.some((p) => ownerPermissions.includes(p)))
      fail(400, "The workspace creator retains administration access.");
    if (
      typeof body.care_area_restricted !== "boolean" ||
      !Array.isArray(body.care_area_ids) ||
      body.care_area_ids.length > 100
    )
      fail(400, "Choose a valid care-area scope.");
    const ids = [...new Set(body.care_area_ids)].sort();
    if (body.care_area_restricted && !ids.length)
      fail(400, "Select at least one assigned care area.");
    for (const id of ids) {
      const a = await area(id);
      if (member.branch_id && a.branch_id !== member.branch_id)
        fail(400, "Care areas must belong to this member’s branch.");
    }
    if (!Number.isInteger(body.version) || body.version < 1)
      fail(400, "Provide the current restriction version.");
    const reason = text(body.reason, "restriction change reason", 500, true);
    const result = await tx.run(
      "UPDATE memberships SET denied_permissions=?,care_area_restricted=?,care_area_ids=?,access_policy_version=access_policy_version+1 WHERE id=? AND access_policy_version=?",
      [
        JSON.stringify(denied),
        body.care_area_restricted ? 1 : 0,
        JSON.stringify(ids),
        member.id,
        body.version,
      ],
    );
    if (!(result.changes ?? result.rowCount))
      fail(409, "Staff restrictions changed. Refresh before saving.");
    await workflowEvent(
      tx,
      c,
      { id: member.id, organization_id: org },
      "membership.restrictions_changed",
      {
        before: {
          denied: JSON.parse(member.denied_permissions),
          areas: JSON.parse(member.care_area_ids),
          restricted: !!member.care_area_restricted,
        },
        after: { denied, areas: ids, restricted: body.care_area_restricted },
        reason,
      },
    );
    return { updated: true, version: member.access_policy_version + 1 };
  }
  if (path === "/care-areas" && method === "GET") {
    if (
      !["workspace.view", "admissions.view", "admissions.manage", "visits.view"].some((p) =>
        hasPermission(actor, p),
      )
    )
      fail(403, "Care-area directory is not permitted.");
    const rows = await tx.all(
      "SELECT a.*,b.name AS branch_name FROM care_areas a JOIN branches b ON b.id=a.branch_id WHERE a.organization_id=? AND (CAST(? AS TEXT) IS NULL OR a.branch_id=?) ORDER BY a.name LIMIT 200",
      [org, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    return { areas: rows.filter((a) => careAreaAllows(actor, a.id)) };
  }
  if (path === "/care-areas" && method === "POST") {
    permit(actor, "areas.manage");
    const b = await branch(body.branch_id);
    if (!["outpatient", "ward", "observation"].includes(body.kind))
      fail(400, "Choose outpatient, ward or observation.");
    const name = text(body.name, "care-area name", 100, true);
    if (
      await tx.get("SELECT id FROM care_areas WHERE branch_id=? AND LOWER(name)=LOWER(?)", [
        b.id,
        name,
      ])
    )
      fail(409, "A care area with this name already exists in this branch.");
    const row = { id: randomUUID(), organization_id: org };
    await tx.run(
      "INSERT INTO care_areas(id,organization_id,branch_id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [row.id, org, b.id, name, body.kind, now(), now()],
    );
    await workflowEvent(tx, c, row, "care_area.created", {
      branch_id: b.id,
      name,
      kind: body.kind,
    });
    return { id: row.id };
  }
  const areaMatch = path.match(/^\/care-areas\/([^/]+)$/);
  if (areaMatch && method === "PATCH") {
    permit(actor, "areas.manage");
    const current = await tx.get("SELECT * FROM care_areas WHERE id=? AND organization_id=?", [
      areaMatch[1],
      org,
    ]);
    if (!current) fail(404, "Care area unavailable.");
    await branch(current.branch_id);
    const name = text(body.name, "care-area name", 100, true);
    if (
      await tx.get(
        "SELECT id FROM care_areas WHERE branch_id=? AND LOWER(name)=LOWER(?) AND id<>?",
        [current.branch_id, name, current.id],
      )
    )
      fail(409, "A care area with this name already exists.");
    if (body.kind && body.kind !== current.kind)
      fail(400, "Care-area type cannot be redefined after creation. Create a new area instead.");
    if (
      body.active === false &&
      ((await tx.get("SELECT id FROM care_admissions WHERE care_area_id=? AND status='active'", [
        current.id,
      ])) ||
        (await tx.get(
          "SELECT id FROM care_visits WHERE care_area_id=? AND status IN ('waiting','in-progress')",
          [current.id],
        )))
    )
      fail(
        409,
        "Move or end active care episodes and resolve active visits before archiving this area.",
      );
    await tx.run("UPDATE care_areas SET name=?,active=?,updated_at=? WHERE id=?", [
      name,
      body.active === false ? 0 : 1,
      now(),
      current.id,
    ]);
    await workflowEvent(tx, c, current, "care_area.updated", {
      before: { name: current.name, active: current.active },
      after: { name, active: body.active !== false },
    });
    return { updated: true };
  }
  if (path === "/admissions/options" && method === "GET") {
    permit(actor, "admissions.manage");
    const patients = await tx.all(
      "SELECT p.id,p.name,p.healthpass_id,l.branch_id FROM patients p JOIN branch_patient_links l ON l.patient_id=p.id JOIN branches b ON b.id=l.branch_id WHERE b.organization_id=? AND (CAST(? AS TEXT) IS NULL OR l.branch_id=?) ORDER BY p.name LIMIT 100",
      [org, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    const members = await tx.all(
      "SELECT u.id,u.name,m.branch_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=? AND m.active=1 AND u.active=1 AND u.verified=1 AND (CAST(? AS TEXT) IS NULL OR m.branch_id IS NULL OR m.branch_id=?) ORDER BY u.name LIMIT 100",
      [org, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    const professionals = [];
    for (const m of members) {
      const u = await careProfessional(tx, m.id, org, actor.branch_id ?? m.branch_id);
      if (u?.clinicalScopes.length && hasPermission(u, "records.view"))
        professionals.push({
          ...m,
          clinicalScopes: u.clinicalScopes,
          careAreaRestricted: u.careAreaRestricted,
          careAreaIds: u.careAreaIds,
        });
    }
    return { patients, professionals };
  }
  if (path === "/admissions" && method === "GET") {
    if (!patient && !hasPermission(actor, "admissions.manage")) permit(actor, "admissions.view");
    const predicate = careAreaPatientPredicate(actor);
    const rows = await tx.all(
      `SELECT a.*,p.name AS patient_name,p.healthpass_id,ar.name AS area_name,b.name AS branch_name FROM care_admissions a JOIN patients p ON p.id=a.patient_id JOIN care_areas ar ON ar.id=a.care_area_id JOIN branches b ON b.id=a.branch_id WHERE ${patient ? "a.patient_id=?" : `a.organization_id=? AND (CAST(? AS TEXT) IS NULL OR a.branch_id=?) AND (${predicate.sql})`} ORDER BY a.created_at DESC LIMIT 100`,
      patient
        ? [actor.patient_id]
        : [org, actor.branch_id ?? null, actor.branch_id ?? null, ...predicate.args],
    );
    for (const row of rows) {
      delete row.request_key;
      delete row.request_payload;
      row.team = await tx.all(
        "SELECT t.id,t.user_id,t.duty,t.active,t.version,u.name FROM admission_team_members t JOIN users u ON u.id=t.user_id WHERE t.admission_id=? ORDER BY t.active DESC,u.name LIMIT 100",
        [row.id],
      );
      row.consultant =
        (await tx.get(
          "SELECT r.id,r.version,r.consultant_id,r.service,r.specialty_review_reference,u.name FROM care_responsibilities r JOIN users u ON u.id=r.consultant_id WHERE r.admission_id=? AND r.status='active'",
          [row.id],
        )) ?? null;
      if (row.consultant) delete row.consultant.specialty_review_reference;
      row.history = await tx.all(
        "SELECT e.action,e.payload,e.created_at,u.name AS actor_name FROM care_workflow_events e JOIN users u ON u.id=e.actor_id WHERE e.object_id=? ORDER BY e.created_at DESC LIMIT 30",
        [row.id],
      );
    }
    return { admissions: rows };
  }
  if (path === "/admissions" && method === "POST") {
    permit(actor, "admissions.manage");
    const a = await area(body.care_area_id);
    if (a.kind === "outpatient") fail(400, "Admission requires a ward or observation area.");
    const patientId = text(body.patient_id, "patient ID", 100, true);
    await registered(patientId, a.branch_id);
    const kind = a.kind === "observation" ? "observation" : "inpatient";
    const payload = JSON.stringify({ patientId, area: a.id, kind });
    const request = hash(
      org + ":" + actor.id + ":" + text(body.client_request_id, "request ID", 100, true),
    );
    await tx.run("UPDATE patients SET id=id WHERE id=?", [patientId]);
    await area(a.id, true);
    const previous = await tx.get(
      "SELECT id,version,request_payload FROM care_admissions WHERE request_key=?",
      [request],
    );
    if (previous) {
      if (previous.request_payload !== payload)
        fail(409, "This request ID belongs to another admission.");
      return { id: previous.id, version: previous.version, replayed: true };
    }
    if (
      await tx.get(
        "SELECT id FROM care_admissions WHERE patient_id=? AND organization_id=? AND status='active'",
        [patientId, org],
      )
    )
      fail(409, "This patient already has an active admission or observation episode.");
    const row = { id: randomUUID(), organization_id: org, patient_id: patientId };
    await tx.run(
      "INSERT INTO care_admissions(id,patient_id,organization_id,branch_id,care_area_id,kind,active_key,created_by,created_at,request_key,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        row.id,
        patientId,
        org,
        a.branch_id,
        a.id,
        kind,
        org + ":" + patientId,
        actor.id,
        now(),
        request,
        payload,
      ],
    );
    await workflowEvent(tx, c, row, "admission.opened", { area_id: a.id, kind });
    return { id: row.id, version: 1 };
  }
  const match = path.match(/^\/admissions\/([^/]+)\/(team|end|move)$/);
  if (match && method === "POST") {
    permit(actor, "admissions.manage");
    let row = await tx.get("SELECT * FROM care_admissions WHERE id=? AND organization_id=?", [
      match[1],
      org,
    ]);
    if (!row) fail(404, "Admission unavailable.");
    await branch(row.branch_id);
    await area(row.care_area_id);
    await tx.run("UPDATE patients SET id=id WHERE id=?", [row.patient_id]);
    row = await tx.get("SELECT * FROM care_admissions WHERE id=?", [row.id]);
    if (row.status !== "active" || row.version !== body.version)
      fail(409, "Admission changed or ended. Refresh before continuing.");
    const reason = text(body.reason, "care-team change reason", 500, true);
    if (
      ["end", "move"].includes(match[2]) &&
      (await tx.get(
        "SELECT id FROM care_visits WHERE patient_id=? AND organization_id=? AND care_area_id=? AND status IN ('waiting','in-progress')",
        [row.patient_id, org, row.care_area_id],
      ))
    )
      fail(
        409,
        "Resolve active ward visits before moving or ending this episode. The responsible professional can finish care, or an authorised visit manager can cancel the visit.",
      );
    if (match[2] === "move") {
      const targetArea = await area(body.care_area_id, true);
      if (targetArea.branch_id !== row.branch_id || targetArea.kind === "outpatient")
        fail(400, "Move only within this admission’s branch to a ward or observation area.");
      await tx.run(
        "UPDATE care_admissions SET care_area_id=?,kind=?,version=version+1 WHERE id=?",
        [targetArea.id, targetArea.kind === "observation" ? "observation" : "inpatient", row.id],
      );
      await workflowEvent(tx, c, row, "admission.moved", {
        from_area: row.care_area_id,
        to_area: targetArea.id,
        reason,
      });
    } else if (match[2] === "end") {
      if (
        (await tx.get(
          "SELECT id FROM clinical_admission_decisions WHERE admission_id=? AND kind='admit'",
          [row.id],
        )) &&
        !(await tx.get(
          "SELECT id FROM clinical_admission_decisions WHERE admission_id=? AND kind='discharge'",
          [row.id],
        ))
      )
        fail(
          409,
          "The physician must record a clinical discharge decision before this admitted episode can end.",
        );
      const orders = await tx.all(
        "SELECT id FROM medication_orders WHERE admission_id=? AND status='active'",
        [row.id],
      );
      for (const order of orders) {
        const stopReason =
          "Inpatient episode ended; this ward order does not authorize outpatient medication.";
        await tx.run(
          "UPDATE medication_orders SET status='stopped',version=version+1,stopped_at=?,stop_reason=? WHERE id=?",
          [now(), stopReason, order.id],
        );
        await tx.run(
          "INSERT INTO treatment_events(id,patient_id,organization_id,object_id,actor_id,action,reason,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [
            randomUUID(),
            row.patient_id,
            org,
            order.id,
            actor.id,
            "medication.episode_ended",
            stopReason,
            now(),
          ],
        );
      }
      if (!body.confirm_episode_end)
        fail(400, "Confirm this admission or observation episode has ended.");
      await tx.run(
        "UPDATE care_admissions SET status='ended',active_key=NULL,version=version+1,ended_at=?,end_reason=? WHERE id=?",
        [now(), reason, row.id],
      );
      await tx.run(
        "UPDATE admission_team_members SET active=0,version=version+1 WHERE admission_id=? AND active=1",
        [row.id],
      );
      const lead = await tx.get(
        "SELECT r.*,u.name AS consultant_name FROM care_responsibilities r JOIN users u ON u.id=r.consultant_id WHERE admission_id=? AND status='active'",
        [row.id],
      );
      if (lead) {
        await tx.run(
          "UPDATE care_responsibilities SET status='ended',active_key=NULL,version=version+1,updated_at=? WHERE id=?",
          [now(), lead.id],
        );
        await tx.run(
          "INSERT INTO care_responsibility_events(id,responsibility_id,actor_id,version,action,reason,payload,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [
            randomUUID(),
            lead.id,
            actor.id,
            lead.version + 1,
            "ended",
            reason,
            JSON.stringify({
              consultant_id: lead.consultant_id,
              consultant_name: lead.consultant_name,
              service: lead.service,
              ward: lead.ward,
              care_setting: lead.care_setting,
              status: "ended",
              admission_id: row.id,
            }),
            now(),
          ],
        );
      }
      await workflowEvent(tx, c, row, "admission.ended", { reason });
    } else {
      const target = await careProfessional(tx, body.user_id, org, row.branch_id);
      const remove = body.action === "remove";
      if (remove) {
        const result = await tx.run(
          "UPDATE admission_team_members SET active=0,version=version+1 WHERE admission_id=? AND user_id=? AND active=1",
          [row.id, body.user_id],
        );
        if (!(result.changes ?? result.rowCount))
          fail(409, "This professional is not an active team member.");
      } else {
        const existingMember = await tx.get(
          "SELECT id FROM admission_team_members WHERE admission_id=? AND user_id=? AND active=1",
          [row.id, body.user_id],
        );
        const count = await tx.get(
          "SELECT COUNT(*) AS total FROM admission_team_members WHERE admission_id=? AND active=1",
          [row.id],
        );
        if (!existingMember && Number(count.total) >= 50)
          fail(400, "This episode already has fifty active team members.");
        const scope =
          body.duty === "nurse"
            ? "nursing"
            : body.duty === "doctor"
              ? "general"
              : body.duty === "medication"
                ? "medication"
                : null;
        if (
          !scope ||
          !target ||
          !target.clinicalScopes.includes(scope) ||
          !hasPermission(target, "records.view") ||
          !careAreaAllows(target, row.care_area_id)
        )
          fail(
            403,
            "Choose a reviewed professional whose permissions and care-area scope cover this duty.",
          );
        const auth = await careAuthority(tx, target, row.patient_id, false);
        if (!auth.accessPolicy.scopes.includes(scope))
          fail(403, "The patient has not shared this record category with that professional.");
        await tx.run(
          "INSERT INTO admission_team_members(id,admission_id,user_id,duty,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(admission_id,user_id) DO UPDATE SET duty=excluded.duty,active=1,version=admission_team_members.version+1,updated_at=excluded.updated_at",
          [randomUUID(), row.id, target.id, body.duty, now(), now()],
        );
      }
      await tx.run("UPDATE care_admissions SET version=version+1 WHERE id=?", [row.id]);
      await workflowEvent(
        tx,
        c,
        row,
        remove ? "admission.member_removed" : "admission.member_assigned",
        { user_id: body.user_id, duty: body.duty ?? null, reason },
      );
    }
    return { updated: true, version: row.version + 1 };
  }
  fail(404, "Care workflow action unavailable.");
}
