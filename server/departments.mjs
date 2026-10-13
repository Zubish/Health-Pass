import { randomUUID } from "node:crypto";
import { hash } from "./security.mjs";
import { hasPermission } from "./roles.mjs";
const now = () => new Date().toISOString();
const departments = ["laboratory", "radiology", "pharmacy"];
const scopeOf = (d) => (d === "pharmacy" ? "medication" : d);
const workPermission = (d) => (d === "pharmacy" ? "pharmacy.review" : d + ".work");
const releasePermission = (d) => (d === "pharmacy" ? "pharmacy.fulfil" : d + ".release");
export async function handleDepartments(tx, c) {
  const { actor, path, method, body, fail, text, permit, strong } = c;
  const match = path.match(
    /^\/departments(?:\/orders(?:\/([^/]+)(?:\/(accept|start|report|release|decline|cancel|amend|acknowledge|clarify|respond|schedule|complete|take-report))?)?)?$/,
  );
  if (!match) return;
  strong(actor);
  const own = !!actor.patient_id;
  const worker = (d) =>
    hasPermission(actor, workPermission(d)) && actor.clinicalScopes?.includes(scopeOf(d));
  const authority = async (row, write = false, ordering = false) => {
    if (own) {
      if (write || row.patient_id !== actor.patient_id) fail(403, "This order is unavailable.");
    } else if (
      row.organization_id !== actor.organization_id ||
      (actor.branch_id && row.branch_id !== actor.branch_id)
    )
      fail(404, "This order is unavailable in your workspace and branch.");
    // An explicit department order is the work assignment. It never authorizes other ward care.
    const result = await (ordering ? c.careAuthority : c.assignmentAuthority)(
      tx,
      actor,
      row.patient_id,
      write,
    );
    const policy = result.accessPolicy;
    if (
      !own &&
      !policy.scopes.includes(scopeOf(row.department)) &&
      !(row.requested_by === actor.id && policy.scopes.includes("general"))
    )
      fail(403, "Patient sharing does not include this department.");
    if (
      write &&
      !ordering &&
      (!policy.canContribute || !policy.contributionScopes.includes(scopeOf(row.department)))
    )
      fail(403, "Patient sharing does not permit contributions in this department.");
    return result;
  };
  const view = async (row) => {
    const { accessPolicy, patient } = await authority(row);
    const reports =
      (!own || row.status === "released") && accessPolicy.scopes.includes(scopeOf(row.department))
        ? await tx.all(
            "SELECT r.*,u.name AS author_name FROM department_reports r JOIN users u ON u.id=r.author_id WHERE r.order_id=? ORDER BY r.signed_at,r.id LIMIT 100",
            [row.id],
          )
        : [];
    const events = own
      ? await tx.all(
          "SELECT action,created_at,payload FROM department_events WHERE order_id=? ORDER BY version LIMIT 200",
          [row.id],
        )
      : await tx.all(
          "SELECT e.id,e.action,e.reason,e.created_at,e.version,e.payload,u.name AS actor_name FROM department_events e JOIN users u ON u.id=e.actor_id WHERE e.order_id=? ORDER BY e.version LIMIT 200",
          [row.id],
        );
    const { request_key, request_payload, ...safe } = row;
    const permitted = !own && worker(row.department);
    const reportShared = accessPolicy.scopes.includes(scopeOf(row.department));
    const facility = await tx.get("SELECT name FROM organizations WHERE id=?", [
      row.organization_id,
    ]);
    const requester = await tx.get("SELECT name FROM users WHERE id=?", [row.requested_by]);
    const assigned = row.assigned_to
      ? await tx.get("SELECT name FROM users WHERE id=?", [row.assigned_to])
      : null;
    const prescription =
      row.medication_order_id && accessPolicy.scopes.includes("medication")
        ? await tx.get(
            "SELECT medicine,dose,route,frequency,indication,instructions,starts_at,ends_at,status FROM medication_orders WHERE id=?",
            [row.medication_order_id],
          )
        : null;
    return {
      ...safe,
      facility_name: facility.name,
      requested_by_name: requester.name,
      assigned_to_name: assigned?.name ?? null,
      prescription,
      allergy_context:
        row.department === "pharmacy" && accessPolicy.includeProfile
          ? { status: patient.allergy_status, details: patient.allergies }
          : null,
      can_take_report:
        permitted &&
        row.status === "awaiting-report" &&
        hasPermission(actor, row.department + ".report"),
      can_report:
        permitted &&
        (row.department === "pharmacy" || hasPermission(actor, row.department + ".report")) &&
        row.assigned_to === actor.id,
      patient_name: patient.name,
      healthpass_id: patient.healthpass_id,
      reports,
      events: events.map((e) => ({
        ...e,
        reason:
          !reportShared && !["requested", "cancel", "respond", "acknowledge"].includes(e.action)
            ? undefined
            : e.reason,
        payload:
          !reportShared || (own && !["release", "schedule"].includes(e.action)) ? "{}" : e.payload,
      })),
      can_work: permitted && (!row.assigned_to || row.assigned_to === actor.id),
      can_release:
        permitted &&
        hasPermission(actor, releasePermission(row.department)) &&
        row.assigned_to === actor.id,
      can_cancel: !own && row.requested_by === actor.id,
      can_acknowledge:
        !own &&
        hasPermission(actor, "diagnostics.order") &&
        actor.clinicalScopes?.includes("general") &&
        accessPolicy.scopes.includes(scopeOf(row.department)),
    };
  };
  if (method === "GET") {
    if (match[2]) fail(404, "Action unavailable.");
    if (match[1]) {
      const row = await tx.get("SELECT * FROM department_orders WHERE id=?", [match[1]]);
      if (!row) fail(404, "Order unavailable.");
      return { order: await view(row) };
    }
    const department = c.searchParams.get("department");
    if (department && !departments.includes(department)) fail(400, "Choose a department.");
    if (
      !own &&
      !hasPermission(actor, "diagnostics.order") &&
      !hasPermission(actor, "prescriptions.create") &&
      !departments.some(worker)
    )
      fail(403, "Your role has no department work queue.");
    const patientId = own ? actor.patient_id : c.searchParams.get("patient_id");
    const cursor = c.searchParams.get("before") || "9999";
    const args = own ? [actor.patient_id] : [actor.organization_id];
    let where = own ? "patient_id=?" : "organization_id=?";
    if (!own && actor.branch_id) {
      where += " AND branch_id=?";
      args.push(actor.branch_id);
    }
    if (!own && patientId) {
      where += " AND patient_id=?";
      args.push(patientId);
    }
    if (department) {
      where += " AND department=?";
      args.push(department);
    }
    where += " AND (created_at || '|' || id)<?";
    args.push(cursor);
    const rows = await tx.all(
      `SELECT * FROM department_orders WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 50`,
      args,
    );
    const orders = [];
    for (const row of rows) {
      if (
        !own &&
        !worker(row.department) &&
        row.requested_by !== actor.id &&
        !hasPermission(actor, "diagnostics.order")
      )
        continue;
      try {
        orders.push(await view(row));
      } catch (e) {
        if (![403, 404].includes(e.status)) throw e;
      }
    }
    return {
      orders,
      next: rows.length === 50 ? rows.at(-1).created_at + "|" + rows.at(-1).id : null,
    };
  }
  if (method !== "POST" || own) fail(403, "Professional department access required.");
  const requestId = text(body.client_request_id, "request ID", 100, true);
  const key = hash(actor.organization_id + ":" + actor.id + ":" + path + ":" + requestId);
  const payload = JSON.stringify(body);
  if (!match[1]) {
    const d = body.department;
    if (!departments.includes(d)) fail(400, "Choose a department.");
    permit(actor, d === "pharmacy" ? "prescriptions.create" : "diagnostics.order");
    if (!actor.clinicalScopes?.includes("general"))
      fail(403, "Reviewed general clinical scope required to request care.");
    const pid = text(body.patient_id, "patient", 100, true);
    const branch = actor.branch_id || text(body.branch_id, "branch", 100, true);
    if (
      !(await tx.get("SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1", [
        branch,
        actor.organization_id,
      ])) ||
      !(await tx.get(
        "SELECT patient_id FROM branch_patient_links WHERE patient_id=? AND branch_id=?",
        [pid, branch],
      ))
    )
      fail(403, "Patient must be registered in the selected branch.");
    const row = {
      patient_id: pid,
      organization_id: actor.organization_id,
      branch_id: branch,
      department: d,
      requested_by: actor.id,
    };
    const { accessPolicy } = await authority(row, true, true);
    if (!accessPolicy.contributionScopes.includes("general"))
      fail(403, "General care contribution is required.");
    let service = text(body.service ?? "", "requested service", 200, d !== "pharmacy"),
      medicationId = null;
    if (d === "pharmacy") {
      medicationId = text(body.medication_order_id, "prescription", 100, true);
      const med = await tx.get(
        "SELECT * FROM medication_orders WHERE id=? AND patient_id=? AND organization_id=? AND branch_id=?",
        [medicationId, pid, actor.organization_id, branch],
      );
      if (!med || med.status !== "active" || med.ends_at <= now())
        fail(409, "Choose a current prescription in this branch.");
      if (!accessPolicy.scopes.includes("medication")) fail(403, "Medication sharing is required.");
      service = `${med.medicine} — ${med.dose} — ${med.route}`;
    }
    const indication = text(body.indication, "clinical reason", 2000, true);
    if (!["routine", "urgent"].includes(body.priority))
      fail(400, "Choose routine or urgent priority.");
    await tx.run("UPDATE patients SET id=id WHERE id=?", [pid]);
    const existing = await tx.get(
      "SELECT id,request_payload FROM department_orders WHERE request_key=?",
      [key],
    );
    if (existing) {
      if (existing.request_payload !== payload)
        fail(409, "Request ID already used with different details.");
      return { id: existing.id, replayed: true };
    }
    if (
      medicationId &&
      (await tx.get(
        "SELECT id FROM department_orders WHERE medication_order_id=? AND status NOT IN ('cancelled','declined')",
        [medicationId],
      ))
    )
      fail(409, "This prescription already has a pharmacy request.");
    const id = randomUUID(),
      at = now();
    await tx.run(
      "INSERT INTO department_orders(id,patient_id,organization_id,branch_id,department,requested_by,medication_order_id,service,indication,priority,created_at,updated_at,request_key,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        pid,
        actor.organization_id,
        branch,
        d,
        actor.id,
        medicationId,
        service,
        indication,
        body.priority,
        at,
        at,
        key,
        payload,
      ],
    );
    await tx.run(
      "INSERT INTO department_events(id,order_id,actor_id,action,reason,payload,created_at,version,request_key,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [randomUUID(), id, actor.id, "requested", indication, "{}", at, 1, key, payload],
    );
    await c.audit(tx, actor, "department.requested", "allow", pid, id, c.correlation);
    return { id };
  }
  const action = match[2];
  if (!action) fail(404, "Choose an order action.");
  const found = await tx.get("SELECT * FROM department_orders WHERE id=?", [match[1]]);
  if (!found) fail(404, "Order unavailable.");
  await authority(found);
  await tx.run("UPDATE patients SET id=id WHERE id=?", [found.patient_id]);
  const row = await tx.get("SELECT * FROM department_orders WHERE id=?", [found.id]);
  const d = row.department;
  if (["cancel", "acknowledge", "respond"].includes(action)) {
    permit(actor, d === "pharmacy" ? "prescriptions.create" : "diagnostics.order");
    const { accessPolicy } = await c.careAuthority(tx, actor, row.patient_id, true);
    if (!accessPolicy.contributionScopes.includes("general"))
      fail(403, "General care contribution required.");
    if (action === "cancel" && row.requested_by !== actor.id)
      fail(403, "Only the requesting clinician can cancel this request.");
    if (action === "acknowledge" && !accessPolicy.scopes.includes(scopeOf(d)))
      fail(403, "Report sharing required to acknowledge results.");
  } else {
    permit(
      actor,
      ["release"].includes(action)
        ? releasePermission(d)
        : ["report", "amend", "take-report"].includes(action) && d !== "pharmacy"
          ? d + ".report"
          : workPermission(d),
    );
    if (!worker(d)) fail(403, "Reviewed department clinical scope required.");
    await authority(row, true);
    if (action !== "take-report" && row.assigned_to && row.assigned_to !== actor.id)
      fail(403, "This request is assigned to another professional.");
  }
  const prior = await tx.get("SELECT request_payload FROM department_events WHERE request_key=?", [
    key,
  ]);
  if (prior) {
    if (prior.request_payload !== payload)
      fail(409, "Request ID already used with different details.");
    return { id: row.id, replayed: true };
  }
  if (body.version !== row.version) fail(409, "This order changed. Refresh before continuing.");
  const transitions = {
    accept: ["requested"],
    start: ["accepted"],
    report: d === "radiology" ? ["awaiting-report"] : ["in-progress"],
    complete: d === "radiology" ? ["in-progress"] : [],
    "take-report": d === "radiology" ? ["awaiting-report"] : [],
    release: ["reported"],
    decline: ["requested", "accepted"],
    cancel: ["requested", "accepted"],
    amend: ["reported", "released"],
    acknowledge: ["released"],
    clarify: ["accepted", "in-progress"],
    respond: ["accepted", "in-progress"],
    schedule: ["accepted"],
  };
  if (!transitions[action]?.includes(row.status))
    fail(409, "This action is not available at the current stage.");
  const reason = text(
    body.reason ?? "",
    "reason / observations",
    3000,
    ["decline", "cancel", "amend", "clarify", "respond", "acknowledge", "complete"].includes(
      action,
    ),
  );
  const details = {};
  if (action === "schedule") {
    const scheduled = Date.parse(body.scheduled_at);
    if (!Number.isFinite(scheduled) || scheduled <= Date.now())
      fail(400, "Choose a future appointment time.");
    details.scheduled_at = new Date(scheduled).toISOString();
  }
  if (action === "start") {
    details.reference = text(
      body.reference,
      "specimen / examination / review reference",
      200,
      true,
    );
    details.observations = reason;
  }
  if (["report", "amend"].includes(action)) {
    const report = text(body.report, "signed report / pharmacy review", 12000, true);
    if (body.confirmed !== true) fail(400, "Confirm the report is complete before signing.");
    const previous = await tx.get(
      "SELECT id FROM department_reports WHERE order_id=? ORDER BY signed_at DESC,id DESC LIMIT 1",
      [row.id],
    );
    details.critical = body.critical === true;
    details.critical_communication = text(
      body.critical_communication ?? "",
      "critical result communication",
      2000,
      details.critical,
    );
    details.method = text(body.reference ?? "", "method / report reference", 500, true);
    await tx.run(
      "INSERT INTO department_reports(id,order_id,author_id,report,details,signed_at,amendment_reason,previous_id) VALUES (?,?,?,?,?,?,?,?)",
      [
        randomUUID(),
        row.id,
        actor.id,
        report,
        JSON.stringify(details),
        now(),
        action === "amend" ? reason : "",
        previous?.id ?? null,
      ],
    );
  }
  const alreadySupplied =
    d === "pharmacy" &&
    (await tx.get("SELECT id FROM department_events WHERE order_id=? AND action='release'", [
      row.id,
    ]));
  if (action === "release" && alreadySupplied) details.correction_only = true;
  if (action === "release" && d === "pharmacy" && !alreadySupplied) {
    const med = await tx.get("SELECT status,ends_at FROM medication_orders WHERE id=?", [
      row.medication_order_id,
    ]);
    if (!med || med.status !== "active" || med.ends_at <= now())
      fail(409, "This prescription is no longer active. Contact the prescriber.");
    if (
      typeof body.quantity !== "number" ||
      !Number.isFinite(body.quantity) ||
      body.quantity <= 0 ||
      body.quantity > 100000
    )
      fail(400, "Enter the actual quantity supplied.");
    details.quantity = body.quantity;
    details.unit = text(body.unit, "supply unit", 60, true);
    details.reference = text(body.reference, "dispensing system / fulfilment reference", 300, true);
    details.counselling = text(body.counselling, "counselling / instructions", 3000, true);
  }
  const status =
    {
      accept: "accepted",
      complete: "awaiting-report",
      start: "in-progress",
      report: "reported",
      release: "released",
      decline: "declined",
      cancel: "cancelled",
      amend: "reported",
    }[action] ?? row.status;
  const at = now(),
    version = row.version + 1;
  await tx.run(
    "UPDATE department_orders SET status=?,assigned_to=?,version=?,updated_at=? WHERE id=? AND version=?",
    [
      status,
      ["accept", "take-report"].includes(action) ? actor.id : row.assigned_to,
      version,
      at,
      row.id,
      row.version,
    ],
  );
  await tx.run(
    "INSERT INTO department_events(id,order_id,actor_id,action,reason,payload,created_at,version,request_key,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      randomUUID(),
      row.id,
      actor.id,
      action,
      reason,
      JSON.stringify(details),
      at,
      version,
      key,
      payload,
    ],
  );
  await c.audit(tx, actor, "department." + action, "allow", row.patient_id, row.id, c.correlation);
  return { id: row.id, status, version };
}
