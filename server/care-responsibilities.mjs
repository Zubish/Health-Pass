import { randomUUID } from "node:crypto";
import { hash } from "./security.mjs";
import { hasPermission, resolveMembership } from "./roles.mjs";
const now = () => new Date().toISOString();
async function candidate(tx, userId, organizationId, branchId) {
  const user = await tx.get(
    "SELECT id,name,verified,active,patient_id,provider_support_verified FROM users WHERE id=? AND verified=1 AND active=1 AND patient_id IS NULL",
    [userId],
  );
  const membership =
    user &&
    (await tx.get("SELECT * FROM memberships WHERE user_id=? AND organization_id=? AND active=1", [
      userId,
      organizationId,
    ]));
  if (!membership || (membership.branch_id && membership.branch_id !== branchId)) return null;
  if (
    membership.branch_id &&
    !(await tx.get("SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1", [
      membership.branch_id,
      organizationId,
    ]))
  )
    return null;
  user.organization_id = organizationId;
  user.branch_id = membership.branch_id ?? null;
  await resolveMembership(tx, membership, user);
  if (
    user.supportAccess ||
    user.accessExpired ||
    !user.clinicalScopes.includes("general") ||
    ["careteam.view", "records.view", "notes.create", "notes.sign"].some(
      (p) => !hasPermission(user, p),
    )
  )
    return null;
  return user;
}
export async function handleCareResponsibilities(tx, c) {
  const {
    actor,
    path,
    method,
    body,
    searchParams,
    strong,
    permit,
    fail,
    text,
    careAuthority,
    audit,
    correlation,
    limit,
  } = c;
  if (!path.startsWith("/care-responsibilities")) return undefined;
  strong(actor);
  const patient = !!actor.patient_id && !actor.organization_id;
  const manage = () => {
    permit(actor, "careteam.manage");
    if (actor.supportAccess) fail(403, "Support access does not manage clinical responsibility.");
  };
  const view = () => {
    if (!patient && !hasPermission(actor, "careteam.manage")) permit(actor, "careteam.view");
  };
  if (
    !patient &&
    actor.branch_id &&
    !(await tx.get("SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1", [
      actor.branch_id,
      actor.organization_id,
    ]))
  )
    fail(403, "Your branch is unavailable. Contact your administrator.");
  const authority = async (consultant, patientId) => {
    if (!consultant) return false;
    try {
      const result = await careAuthority(tx, consultant, patientId, true);
      return result.accessPolicy.contributionScopes.includes("general");
    } catch (error) {
      if ([403, 404].includes(error.status)) return false;
      throw error;
    }
  };
  const permittedLead = async (patientId, branchId) => {
    const consultant = await candidate(
      tx,
      text(body.consultant_id, "consultant", 100, true),
      actor.organization_id,
      branchId,
    );
    if (!consultant)
      fail(
        409,
        "Choose an active consultant with reviewed general medical scope and care-team, documentation and signing permissions in this branch.",
      );
    if (!(await authority(consultant, patientId)))
      fail(
        409,
        "The consultant needs current patient permission to contribute before assignment. Assignment cannot grant record access.",
      );
    if (body.specialty_confirmed !== true)
      fail(400, "Confirm the consultant’s reviewed credentials cover the selected service.");
    return consultant;
  };
  const fields = (defaults = {}) => {
    const setting = body.care_setting ?? defaults.care_setting ?? "inpatient";
    if (!["inpatient", "ongoing"].includes(setting)) fail(400, "Choose inpatient or ongoing care.");
    return {
      service: text(body.service ?? defaults.service, "service", 80, true),
      ward: text(body.ward ?? defaults.ward ?? "", "ward", 100),
      care_setting: setting,
      specialty_review_reference: text(
        body.specialty_review_reference,
        "specialty review reference",
        500,
        true,
      ),
    };
  };
  const resultFor = (row) => ({ id: row.id, version: row.version, status: row.status });
  const recordEvent = async (row, consultant, action, reason) => {
    await tx.run(
      "INSERT INTO care_responsibility_events(id,responsibility_id,actor_id,version,action,reason,payload,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        randomUUID(),
        row.id,
        actor.id,
        row.version,
        action,
        reason,
        JSON.stringify({
          consultant_id: row.consultant_id,
          consultant_name: consultant?.name ?? null,
          service: row.service,
          ward: row.ward,
          care_setting: row.care_setting,
          version: row.version,
          specialty_review_reference: row.specialty_review_reference,
        }),
        now(),
      ],
    );
    await audit(
      tx,
      actor,
      `care.responsibility_${action}`,
      "allow",
      row.patient_id,
      row.id,
      correlation,
    );
  };
  if (path === "/care-responsibilities/options" && method === "GET") {
    manage();
    const branches = await tx.all(
      "SELECT id,name FROM branches WHERE organization_id=? AND active=1 AND (CAST(? AS TEXT) IS NULL OR id=?) ORDER BY name,id",
      [actor.organization_id, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    const patients = await tx.all(
      "SELECT p.id,p.name,p.healthpass_id,b.id AS branch_id FROM patients p JOIN patient_links l ON l.patient_id=p.id JOIN branch_patient_links bp ON bp.patient_id=p.id JOIN branches b ON b.id=bp.branch_id AND b.organization_id=l.organization_id WHERE l.organization_id=? AND b.active=1 AND (CAST(? AS TEXT) IS NULL OR b.id=?) ORDER BY p.name,p.id,b.id LIMIT 100",
      [actor.organization_id, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    const members = await tx.all(
      "SELECT user_id,branch_id FROM memberships WHERE organization_id=? AND active=1 ORDER BY user_id LIMIT 100",
      [actor.organization_id],
    );
    const consultants = [];
    for (const m of members) {
      const branch = branches.find((b) => !m.branch_id || m.branch_id === b.id);
      if (!branch) continue;
      const user = await candidate(tx, m.user_id, actor.organization_id, branch.id);
      if (user)
        consultants.push({
          id: user.id,
          name: user.name,
          branch_id: user.branch_id,
          role_names: user.jobRoles.map((r) => r.name),
        });
    }
    return { branches, patients, consultants };
  }
  if (path === "/care-responsibilities" && method === "GET") {
    view();
    const requested = searchParams.get("patient_id");
    const offset = Number(searchParams.get("offset") ?? 0),
      status = searchParams.get("status");
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      (status && !["active", "ended"].includes(status))
    )
      fail(400, "Invalid responsibility page or status.");
    const rows = await tx.all(
      `SELECT r.*,p.name AS patient_name,p.healthpass_id,u.name AS consultant_name,o.name AS facility_name,b.name AS branch_name FROM care_responsibilities r JOIN patients p ON p.id=r.patient_id JOIN users u ON u.id=r.consultant_id JOIN organizations o ON o.id=r.organization_id JOIN branches b ON b.id=r.branch_id WHERE ${patient ? "r.patient_id=?" : "r.organization_id=? AND (CAST(? AS TEXT) IS NULL OR r.branch_id=?)"} AND (CAST(? AS TEXT) IS NULL OR r.patient_id=?) AND (CAST(? AS TEXT) IS NULL OR r.status=?) ORDER BY r.updated_at DESC,r.id LIMIT 51 OFFSET ?`,
      patient
        ? [actor.patient_id, requested, requested, status, status, offset]
        : [
            actor.organization_id,
            actor.branch_id ?? null,
            actor.branch_id ?? null,
            requested,
            requested,
            status,
            status,
            offset,
          ],
    );
    const responsibilities = [];
    for (const row of rows.slice(0, 50)) {
      const lead = await candidate(tx, row.consultant_id, row.organization_id, row.branch_id);
      const accessAvailable = row.status === "active" && (await authority(lead, row.patient_id));
      const events = await tx.all(
        "SELECT e.id,e.action,e.reason,e.payload,e.created_at,u.name AS actor_name FROM care_responsibility_events e JOIN users u ON u.id=e.actor_id WHERE e.responsibility_id=? ORDER BY e.version DESC LIMIT 100",
        [row.id],
      );
      const {
        request_key,
        request_payload_hash,
        specialty_review_reference,
        created_by,
        active_key,
        ...released
      } = row;
      responsibilities.push({
        ...released,
        access_available: accessAvailable,
        history: events.reverse().map(({ payload, ...event }) => {
          const { specialty_review_reference, ...snapshot } = JSON.parse(payload);
          return { ...event, ...snapshot };
        }),
      });
    }
    return { responsibilities, has_more: rows.length > 50, next_offset: offset + 50 };
  }
  if (path === "/care-responsibilities" && method === "POST") {
    manage();
    limit(`care-responsibility:${actor.id}`, 30);
    const patientId = text(body.patient_id, "patient", 100, true),
      branchId = text(body.branch_id, "branch", 100, true),
      requestKey = hash(
        actor.id + ":" + text(body.client_request_id, "request identifier", 100, true),
      );
    if (actor.branch_id && actor.branch_id !== branchId)
      fail(403, "Assign care only within your current branch.");
    if (
      !(await tx.get(
        "SELECT p.patient_id FROM patient_links p JOIN branch_patient_links bp ON bp.patient_id=p.patient_id JOIN branches b ON b.id=bp.branch_id WHERE p.patient_id=? AND p.organization_id=? AND b.organization_id=? AND b.id=? AND b.active=1",
        [patientId, actor.organization_id, actor.organization_id, branchId],
      ))
    )
      fail(404, "Choose a patient registered at this facility branch.");
    // Authorise local registration before serialising responsibility changes on the patient.
    await tx.run("UPDATE patients SET name=name WHERE id=?", [patientId]);
    if (
      !(await tx.get("SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1", [
        branchId,
        actor.organization_id,
      ]))
    )
      fail(409, "This branch changed. Refresh before assigning.");
    const values = fields(),
      payloadHash = hash(
        JSON.stringify({ patientId, branchId, consultant_id: body.consultant_id, ...values }),
      ),
      previous = await tx.get("SELECT * FROM care_responsibilities WHERE request_key=?", [
        requestKey,
      ]);
    if (previous) {
      if (previous.request_payload_hash !== payloadHash)
        fail(409, "The assignment details changed. Use a new request identifier.");
      return { ...resultFor(previous), replayed: true };
    }
    if (
      await tx.get("SELECT id FROM care_responsibilities WHERE active_key=?", [
        actor.organization_id + ":" + patientId,
      ])
    )
      fail(
        409,
        "This patient already has a responsible consultant in this facility. Reassign the existing responsibility.",
      );
    const consultant = await permittedLead(patientId, branchId),
      id = randomUUID(),
      created = now();
    await tx.run(
      "INSERT INTO care_responsibilities(id,patient_id,organization_id,branch_id,consultant_id,service,ward,care_setting,specialty_review_reference,active_key,request_key,request_payload_hash,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        patientId,
        actor.organization_id,
        branchId,
        consultant.id,
        values.service,
        values.ward,
        values.care_setting,
        values.specialty_review_reference,
        actor.organization_id + ":" + patientId,
        requestKey,
        payloadHash,
        actor.id,
        created,
        created,
      ],
    );
    const row = await tx.get("SELECT * FROM care_responsibilities WHERE id=?", [id]);
    await recordEvent(row, consultant, "assigned", "Initial administrator assignment");
    return resultFor(row);
  }
  const match = path.match(/^\/care-responsibilities\/([^/]+)$/);
  if (match && method === "PATCH") {
    manage();
    const preliminary = await tx.get(
      "SELECT patient_id,branch_id FROM care_responsibilities WHERE id=? AND organization_id=?",
      [match[1], actor.organization_id],
    );
    if (!preliminary || (actor.branch_id && preliminary.branch_id !== actor.branch_id))
      fail(404, "Responsibility unavailable.");
    await tx.run("UPDATE patients SET name=name WHERE id=?", [preliminary.patient_id]);
    const row = await tx.get(
      "SELECT * FROM care_responsibilities WHERE id=? AND organization_id=?",
      [match[1], actor.organization_id],
    );
    if (actor.branch_id && row.branch_id !== actor.branch_id)
      fail(404, "Responsibility unavailable in your branch.");
    if (row.status !== "active" || !Number.isInteger(body.version) || body.version !== row.version)
      fail(409, "Responsibility changed. Refresh before trying again.");
    const reason = text(body.reason, "change reason", 500, true);
    let lead;
    if (body.action === "end") {
      lead = await tx.get("SELECT name FROM users WHERE id=?", [row.consultant_id]);
      await tx.run(
        "UPDATE care_responsibilities SET status='ended',active_key=NULL,version=version+1,updated_at=? WHERE id=?",
        [now(), row.id],
      );
    } else if (body.action === "reassign") {
      if (
        !(await tx.get("SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1", [
          row.branch_id,
          actor.organization_id,
        ]))
      )
        fail(409, "This branch is inactive. End the responsibility instead of reassigning.");
      lead = await permittedLead(row.patient_id, row.branch_id);
      const values = fields(row);
      await tx.run(
        "UPDATE care_responsibilities SET consultant_id=?,service=?,ward=?,care_setting=?,specialty_review_reference=?,version=version+1,updated_at=? WHERE id=?",
        [
          lead.id,
          values.service,
          values.ward,
          values.care_setting,
          values.specialty_review_reference,
          now(),
          row.id,
        ],
      );
    } else fail(400, "Choose reassign or end.");
    const updated = await tx.get("SELECT * FROM care_responsibilities WHERE id=?", [row.id]);
    await recordEvent(updated, lead, body.action === "end" ? "ended" : "reassigned", reason);
    return resultFor(updated);
  }
  return undefined;
}
