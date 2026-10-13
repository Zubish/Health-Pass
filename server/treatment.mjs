import { randomUUID } from "node:crypto";
import { hash } from "./security.mjs";
import { hasPermission } from "./roles.mjs";
const now = () => new Date().toISOString();
export const vitalLimits = {
  systolic: [40, 300],
  diastolic: [20, 200],
  pulse: [10, 300],
  temperature: [25, 45],
  spo2: [50, 100],
  respiratory_rate: [2, 100],
  weight: [0.1, 700],
};
export function validateVitals(values, fail) {
  if (!values || typeof values !== "object" || Array.isArray(values))
    fail(400, "Enter measured vital values.");
  for (const [key, value] of Object.entries(values)) {
    const bounds = vitalLimits[key];
    if (
      !bounds ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < bounds[0] ||
      value > bounds[1]
    )
      fail(400, "Enter a supported vital within its measurement range.");
  }
  if (!Object.keys(values).length) fail(400, "Enter at least one measurement.");
  return values;
}
export async function handleTreatment(tx, c) {
  const { actor, path, method, body, strong, permit, fail, text, careAuthority } = c;
  const m = path.match(
    /^\/treatment\/patients\/([^/]+)(?:\/(decisions|orders|observations)(?:\/([^/]+)(?:\/(stop|administrations))?)?)?$/,
  );
  if (!m) return;
  strong(actor);
  const pid = m[1];
  const policy = (await careAuthority(tx, actor, pid, method !== "GET")).accessPolicy;
  const org = actor.organization_id;
  const scope = (category, write = false) => {
    if (
      !policy.scopes.includes(category) ||
      (write &&
        (!actor.clinicalScopes?.includes(category) ||
          !policy.contributionScopes.includes(category) ||
          !policy.canContribute))
    )
      fail(
        403,
        "Your current patient sharing and reviewed clinical scope do not allow this action.",
      );
  };
  const date = (value, label, future = true) => {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || (!future && time > Date.now() + 300000))
      fail(400, "Enter a valid " + label + ".");
    return new Date(time).toISOString();
  };
  const admission = async (id, active = true) => {
    const row = await tx.get(
      "SELECT * FROM care_admissions WHERE id=? AND patient_id=? AND organization_id=?",
      [id, pid, org],
    );
    if (!row || (actor.branch_id && row.branch_id !== actor.branch_id))
      fail(404, "Care episode unavailable.");
    if (active && row.status !== "active") fail(409, "This care episode has ended.");
    await tx.run("UPDATE patients SET id=id WHERE id=?", [pid]);
    const current = await tx.get("SELECT * FROM care_admissions WHERE id=?", [id]);
    if (active && current.status !== "active") fail(409, "This care episode has ended.");
    return current;
  };
  const retry = async (table, payload) => {
    const key = hash(
      org +
        ":" +
        actor.id +
        ":" +
        m[2] +
        ":" +
        text(body.client_request_id, "request ID", 100, true),
    );
    const previous = await tx.get(`SELECT id,request_payload FROM ${table} WHERE request_key=?`, [
      key,
    ]);
    if (previous) {
      if (previous.request_payload !== payload)
        fail(409, "This request ID was already used with different information.");
      return { key, result: { id: previous.id, replayed: true } };
    }
    return { key };
  };
  const event = async (id, action, reason) => {
    await tx.run(
      "INSERT INTO treatment_events(id,patient_id,organization_id,object_id,actor_id,action,reason,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [randomUUID(), pid, org, id, actor.id, action, reason, now()],
    );
    await c.audit(tx, actor, action, "allow", pid, id, c.correlation);
  };
  if (!m[2] && method === "GET") {
    const own = actor.patient_id === pid;
    const args = own ? [pid] : [pid, org];
    const where = own ? "patient_id=?" : "patient_id=? AND organization_id=?";
    const orders = policy.scopes.includes("medication")
      ? await tx.all(
          `SELECT o.id,o.patient_id,o.organization_id,o.branch_id,o.admission_id,o.prescriber_id,u.name AS prescriber_name,org.name AS facility_name,o.medicine,o.dose,o.route,o.frequency,o.interval_hours,o.prn,o.indication,o.instructions,o.starts_at,o.ends_at,o.status,o.version,o.created_at,o.stopped_at,o.stop_reason FROM medication_orders o JOIN users u ON u.id=o.prescriber_id JOIN organizations org ON org.id=o.organization_id WHERE ${where.replaceAll("patient_id", "o.patient_id").replaceAll("organization_id", "o.organization_id")} ORDER BY o.created_at DESC LIMIT 100`,
          args,
        )
      : [];
    for (const order of orders)
      order.administrations = await tx.all(
        "SELECT a.id,a.author_id,u.name AS author_name,a.due_at,a.administered_at,a.outcome,a.dose,a.reason,a.observations,a.created_at FROM medication_administrations a JOIN users u ON u.id=a.author_id WHERE order_id=? ORDER BY administered_at DESC LIMIT 200",
        [order.id],
      );
    const decisions = policy.scopes.includes("general")
      ? await tx.all(
          `SELECT d.id,d.admission_id,d.kind,d.reason,d.observations,d.decided_at,d.created_at,u.name AS physician_name FROM clinical_admission_decisions d JOIN users u ON u.id=d.physician_id WHERE ${where.replaceAll("patient_id", "d.patient_id").replaceAll("organization_id", "d.organization_id")} ORDER BY d.decided_at DESC LIMIT 100`,
          args,
        )
      : [];
    const observations = await tx.all(
      `SELECT o.id,o.admission_id,o.discipline,o.values_json,o.observations,o.observed_at,o.created_at,u.name AS author_name FROM ward_observations o JOIN users u ON u.id=o.author_id WHERE ${where.replaceAll("patient_id", "o.patient_id").replaceAll("organization_id", "o.organization_id")} ORDER BY observed_at DESC LIMIT 200`,
      args,
    );
    const episodes = await tx.all(
      `SELECT a.id,a.kind,a.status,a.branch_id,ar.name AS area_name,a.created_at,a.ended_at FROM care_admissions a JOIN care_areas ar ON ar.id=a.care_area_id WHERE ${where.replaceAll("patient_id", "a.patient_id").replaceAll("organization_id", "a.organization_id")} ORDER BY a.created_at DESC LIMIT 100`,
      args,
    );
    const history = await tx.all(
      `SELECT e.id,e.action,e.object_id,e.reason,e.created_at,u.name AS actor_name FROM treatment_events e JOIN users u ON u.id=e.actor_id WHERE ${where.replaceAll("patient_id", "e.patient_id").replaceAll("organization_id", "e.organization_id")} ORDER BY e.created_at DESC LIMIT 100`,
      args,
    );
    const visible = new Set(
      [
        ...orders,
        ...decisions,
        ...observations.filter((o) => policy.scopes.includes(o.discipline)),
      ].map((o) => o.id),
    );
    return {
      orders,
      decisions,
      episodes,
      observations: observations
        .filter((o) => policy.scopes.includes(o.discipline))
        .map(({ values_json, ...o }) => ({ ...o, values: JSON.parse(values_json) })),
      history: history.filter((e) => visible.has(e.object_id)),
      scopes: policy.scopes,
    };
  }
  if (method !== "POST") fail(404, "Treatment action unavailable.");
  if (actor.patient_id) fail(403, "Patients cannot author professional treatment records.");
  if (m[2] === "decisions" && !m[3]) {
    permit(actor, "admissions.decide");
    scope("general", true);
    const a = await admission(body.admission_id);
    if (!["admit", "discharge"].includes(body.kind)) fail(400, "Choose admission or discharge.");
    const reason = text(body.reason, "clinical decision reason", 2000, true),
      observations = text(body.observations ?? "", "observations", 2000),
      decided = date(body.decided_at || now(), "decision time", false);
    if (Date.parse(decided) < Date.parse(a.created_at))
      fail(400, "Decision time cannot precede this episode.");
    const payload = JSON.stringify({
      admission: a.id,
      kind: body.kind,
      reason,
      observations,
      decided: body.decided_at ?? null,
    });
    const r = await retry("clinical_admission_decisions", payload);
    if (r.result) return r.result;
    if (
      await tx.get("SELECT id FROM clinical_admission_decisions WHERE admission_id=? AND kind=?", [
        a.id,
        body.kind,
      ])
    )
      fail(409, "This clinical decision has already been recorded.");
    if (
      body.kind === "discharge" &&
      !(await tx.get(
        "SELECT id FROM clinical_admission_decisions WHERE admission_id=? AND kind='admit'",
        [a.id],
      ))
    )
      fail(409, "Record the admitting physician decision first.");
    if (body.confirm_physician !== "confirmed")
      fail(400, "Confirm you are the physician making this decision.");
    const id = randomUUID();
    await tx.run(
      "INSERT INTO clinical_admission_decisions(id,admission_id,patient_id,organization_id,physician_id,kind,reason,observations,decided_at,created_at,request_key,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        a.id,
        pid,
        org,
        actor.id,
        body.kind,
        reason,
        observations,
        decided,
        now(),
        r.key,
        payload,
      ],
    );
    await event(id, "clinical." + body.kind, reason);
    return { id };
  }
  if (m[2] === "observations" && !m[3]) {
    permit(actor, "ward.observations");
    const discipline = body.discipline;
    if (!["general", "nursing"].includes(discipline))
      fail(400, "Choose your reviewed observation discipline.");
    scope(discipline, true);
    const a = await admission(body.admission_id),
      values = validateVitals(body.values, fail),
      observations = text(body.observations ?? "", "observations", 2000),
      observed = date(body.observed_at || now(), "observation time", false);
    if (Date.parse(observed) < Date.parse(a.created_at))
      fail(400, "Observation cannot precede this episode.");
    const payload = JSON.stringify({
        admission: a.id,
        discipline,
        values,
        observations,
        observed: body.observed_at ?? null,
      }),
      r = await retry("ward_observations", payload);
    if (r.result) return r.result;
    const id = randomUUID();
    await tx.run(
      "INSERT INTO ward_observations(id,admission_id,patient_id,organization_id,author_id,discipline,values_json,observations,observed_at,created_at,request_key,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        a.id,
        pid,
        org,
        actor.id,
        discipline,
        JSON.stringify(values),
        observations,
        observed,
        now(),
        r.key,
        payload,
      ],
    );
    await event(id, "ward.observation", "Recorded measured observations");
    return { id };
  }
  if (m[2] === "orders" && !m[3]) {
    permit(actor, "prescriptions.create");
    scope("general", true);
    scope("medication");
    const a = body.admission_id ? await admission(body.admission_id) : null;
    if (
      !a &&
      (await tx.get(
        "SELECT id FROM care_admissions WHERE patient_id=? AND organization_id=? AND status='active'",
        [pid, org],
      ))
    )
      fail(400, "Link inpatient prescribing to the active care episode.");
    const branch = a?.branch_id || actor.branch_id || body.branch_id;
    if (
      !(await tx.get(
        "SELECT b.id FROM branches b JOIN branch_patient_links l ON l.branch_id=b.id WHERE b.id=? AND b.organization_id=? AND b.active=1 AND l.patient_id=?",
        [branch, org, pid],
      ))
    )
      fail(404, "Registered patient branch unavailable.");
    const medicine = text(body.medicine, "medicine and strength", 200, true),
      dose = text(body.dose, "dose", 120, true),
      route = text(body.route, "route", 80, true),
      frequency = text(body.frequency, "frequency", 150, true),
      indication = text(body.indication, "indication", 500, true),
      instructions = text(body.instructions ?? "", "instructions", 1000),
      starts = date(body.starts_at || now(), "start time"),
      ends = date(body.ends_at, "end time");
    if (
      Date.parse(ends) <= Date.parse(starts) ||
      Date.parse(ends) - Date.parse(starts) > 366 * 86400000
    )
      fail(400, "Choose a medication course ending after its start, within one year.");
    if (typeof body.prn !== "boolean") fail(400, "Choose scheduled or as-needed treatment.");
    const interval = body.prn || !a ? null : Number(body.interval_hours);
    if (a && !body.prn && (!Number.isFinite(interval) || interval < 0.25 || interval > 168))
      fail(400, "Scheduled ward medication requires an interval of 0.25 to 168 hours.");
    if (body.confirm_prescription !== "confirmed")
      fail(400, "Review allergies, medication details and clinical suitability before signing.");
    const payload = JSON.stringify({
        admission: a?.id ?? null,
        branch,
        medicine,
        dose,
        route,
        frequency,
        indication,
        instructions,
        starts: body.starts_at ?? null,
        ends,
        prn: body.prn,
        interval,
      }),
      r = await retry("medication_orders", payload);
    if (r.result) return r.result;
    const id = randomUUID();
    await tx.run(
      "INSERT INTO medication_orders(id,patient_id,organization_id,branch_id,admission_id,prescriber_id,medicine,dose,route,frequency,interval_hours,prn,indication,instructions,starts_at,ends_at,created_at,request_key,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        pid,
        org,
        branch,
        a?.id ?? null,
        actor.id,
        medicine,
        dose,
        route,
        frequency,
        interval,
        Number(body.prn),
        indication,
        instructions,
        starts,
        ends,
        now(),
        r.key,
        payload,
      ],
    );
    await event(id, "medication.prescribed", "Signed prescription");
    return { id, version: 1 };
  }
  if (m[2] === "orders" && m[3]) {
    scope("medication");
    const order = await tx.get(
      "SELECT * FROM medication_orders WHERE id=? AND patient_id=? AND organization_id=?",
      [m[3], pid, org],
    );
    if (!order || (actor.branch_id && actor.branch_id !== order.branch_id))
      fail(404, "Medication order unavailable.");
    await tx.run("UPDATE medication_orders SET id=id WHERE id=?", [order.id]);
    const current = await tx.get("SELECT * FROM medication_orders WHERE id=?", [order.id]);
    if (m[4] === "stop") {
      permit(actor, "prescriptions.create");
      scope("general", true);
      if (current.status !== "active" || body.version !== current.version)
        fail(409, "Medication order changed or stopped. Refresh it.");
      const reason = text(body.reason, "stop reason", 1000, true);
      await tx.run(
        "UPDATE medication_orders SET status='stopped',version=version+1,stopped_at=?,stop_reason=? WHERE id=?",
        [now(), reason, order.id],
      );
      await event(order.id, "medication.stopped", reason);
      return { id: order.id, version: current.version + 1 };
    }
    if (m[4] === "administrations") {
      permit(actor, "medication.administer");
      scope("nursing", true);
      if (!current.admission_id)
        fail(400, "Medication administration charting requires an inpatient prescription.");
      const a = await admission(current.admission_id);
      if (!["given", "omitted", "refused", "held"].includes(body.outcome))
        fail(400, "Choose given, omitted, refused or held.");
      const actual = date(body.administered_at || now(), "administration time", false),
        due = current.prn ? null : date(body.due_at, "scheduled dose time");
      if (
        Date.parse(actual) < Date.parse(a.created_at) ||
        Date.parse(actual) < Date.parse(current.starts_at) ||
        Date.parse(actual) > Date.parse(current.ends_at)
      )
        fail(400, "Administration must fall within the episode and prescribed course.");
      if (due) {
        const delta = Date.parse(due) - Date.parse(current.starts_at),
          step = current.interval_hours * 3600000;
        if (
          delta < 0 ||
          Date.parse(due) >= Date.parse(current.ends_at) ||
          Math.abs(delta / step - Math.round(delta / step)) > 0.000001
        )
          fail(400, "Choose a scheduled dose from this prescription.");
        if (Date.parse(due) > Date.now() + 300000)
          fail(400, "A future dose cannot be recorded as administered or omitted.");
      }
      const dose = body.outcome === "given" ? text(body.dose, "administered dose", 120, true) : "",
        reason = text(
          body.reason ?? "",
          "reason",
          1000,
          body.outcome !== "given" || current.prn === 1 || dose !== current.dose,
        ),
        observations = text(body.observations ?? "", "observations", 2000);
      const payload = JSON.stringify({
          order: order.id,
          outcome: body.outcome,
          dose,
          reason,
          observations,
          due,
          actual: body.administered_at ?? null,
        }),
        r = await retry("medication_administrations", payload);
      if (r.result) return r.result;
      if (current.status !== "active") fail(409, "This prescription has been stopped.");
      const slot = current.prn ? r.key : order.id + ":" + due;
      if (await tx.get("SELECT id FROM medication_administrations WHERE slot_key=?", [slot]))
        fail(409, "This scheduled dose already has a recorded outcome.");
      const id = randomUUID();
      await tx.run(
        "INSERT INTO medication_administrations(id,order_id,author_id,due_at,administered_at,outcome,dose,reason,observations,created_at,slot_key,request_key,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          order.id,
          actor.id,
          due,
          actual,
          body.outcome,
          dose,
          reason,
          observations,
          now(),
          slot,
          r.key,
          payload,
        ],
      );
      await event(id, "medication." + body.outcome, reason || "Recorded prescribed dose");
      return { id };
    }
  }
  fail(404, "Treatment action unavailable.");
}
