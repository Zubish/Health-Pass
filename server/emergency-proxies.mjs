import { emergencySummaries } from "./emergency-records.mjs";
import { createHash, randomUUID } from "node:crypto";
import { hasPermission, resolveMembership } from "./roles.mjs";

export const proxyPolicyVersion = "emergency-sharing-v1";
export const proxyCategories = ["general", "nursing", "medication", "laboratory", "radiology"];
const now = () => new Date().toISOString();
const parseScopes = (row) => JSON.parse(row.scopes_json);
export const proxyPolicy =
  "Emergency sharing only: when you cannot consent and waiting could jeopardise care, your accepted proxy may approve the selected record categories for the named requesting professional for one hour. A primary care facility may approve when treating you itself, but a different authorised clinician must decide. No response gives no access. Proxies cannot read records through this appointment. Selected notes may contain sensitive information; line-by-line redaction is not available. You can revoke the appointment and active emergency access at any time. Requests, decisions and record views remain in your history. There is no single-person emergency override.";

export function verifyProxyEvidence(events, head) {
  let previous = "";
  let sequence = 0;
  for (const row of events) {
    const event = {
      id: row.id,
      patient_id: row.patient_id,
      sequence: row.sequence,
      resource_id: row.resource_id,
      actor_id: row.actor_id,
      organization_id: row.organization_id,
      action: row.action,
      details: row.details,
      created_at: row.created_at,
      previous_hash: row.previous_hash,
    };
    if (
      row.sequence !== ++sequence ||
      row.previous_hash !== previous ||
      createHash("sha256").update(JSON.stringify(event)).digest("hex") !== row.hash
    ) {
      return false;
    }
    previous = row.hash;
  }
  return sequence === head.sequence && previous === head.hash;
}

async function lockPatient(tx, patientId) {
  await tx.run(
    "INSERT INTO proxy_event_heads(patient_id) VALUES (?) ON CONFLICT(patient_id) DO NOTHING",
    [patientId],
  );
  await tx.run("UPDATE proxy_event_heads SET sequence=sequence WHERE patient_id=?", [patientId]);
}
export async function appendProxyEvent(tx, actor, patientId, resourceId, action, details = {}) {
  await lockPatient(tx, patientId);
  const head = await tx.get("SELECT * FROM proxy_event_heads WHERE patient_id=?", [patientId]);
  const event = {
    id: randomUUID(),
    patient_id: patientId,
    sequence: head.sequence + 1,
    resource_id: resourceId,
    actor_id: actor.id,
    organization_id: actor.organization_id ?? null,
    action,
    details: JSON.stringify(details),
    created_at: now(),
    previous_hash: head.hash,
  };
  const hash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  await tx.run(
    "INSERT INTO proxy_events(id,patient_id,sequence,resource_id,actor_id,organization_id,action,details,created_at,previous_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [...Object.values(event), hash],
  );
  await tx.run("UPDATE proxy_event_heads SET sequence=?,hash=? WHERE patient_id=?", [
    event.sequence,
    hash,
    patientId,
  ]);
}
async function currentAppointment(tx, row) {
  if (!row || row.status !== "accepted" || row.policy_version !== proxyPolicyVersion) {
    return false;
  }
  if (row.proxy_user_id) {
    return !!(await tx.get("SELECT id FROM users WHERE id=? AND active=1", [row.proxy_user_id]));
  }
  return !!(await tx.get(
    "SELECT patient_id FROM primary_care WHERE patient_id=? AND organization_id=?",
    [row.patient_id, row.proxy_organization_id],
  ));
}
function qualified(actor, permission) {
  return (
    !!actor.organization_id &&
    !actor.supportAccess &&
    !actor.accessExpired &&
    hasPermission(actor, permission) &&
    hasPermission(actor, "records.view") &&
    !!actor.clinicalScopes?.length
  );
}
async function canRespond(tx, actor, appointment, request = null) {
  if (request?.requester_id === actor.id) {
    return false;
  }
  if (appointment.proxy_user_id) {
    return appointment.proxy_user_id === actor.id;
  }
  return (
    appointment.proxy_organization_id === actor.organization_id &&
    qualified(actor, "emergency.approve") &&
    !!(await tx.get(
      "SELECT patient_id FROM primary_care WHERE patient_id=? AND organization_id=?",
      [appointment.patient_id, appointment.proxy_organization_id],
    ))
  );
}
const appointmentSelect = `SELECT p.*,pt.name AS patient_name,pt.healthpass_id,u.name AS proxy_name,o.name AS proxy_facility FROM patient_proxies p JOIN patients pt ON pt.id=p.patient_id LEFT JOIN users u ON u.id=p.proxy_user_id LEFT JOIN organizations o ON o.id=p.proxy_organization_id`;
const requestSelect = `SELECT r.*,pt.name AS patient_name,pt.healthpass_id,u.name AS requester_name,o.name AS facility_name,b.name AS branch_name,d.name AS decision_by_name FROM emergency_requests r JOIN patients pt ON pt.id=r.patient_id JOIN users u ON u.id=r.requester_id JOIN organizations o ON o.id=r.organization_id LEFT JOIN branches b ON b.id=r.branch_id LEFT JOIN users d ON d.id=r.decided_by`;
export async function proxyTasks(tx, actor) {
  const appointments = await tx.all(
    "SELECT * FROM patient_proxies WHERE status IN ('pending','accepted') AND (proxy_user_id=? OR proxy_organization_id=?)",
    [actor.id, actor.organization_id ?? ""],
  );
  let count = 0;
  for (const p of appointments) {
    if (!(await canRespond(tx, actor, p))) {
      continue;
    }
    if (p.status === "pending") {
      count++;
    }
    if (!(await currentAppointment(tx, p))) {
      continue;
    }
    const requests = await tx.all(
      "SELECT requester_id FROM emergency_requests WHERE appointment_id=? AND status='pending' AND expires_at>?",
      [p.id, now()],
    );
    count += requests.filter((r) => r.requester_id !== actor.id).length;
  }
  if (actor.patient_id) {
    count += Number(
      (
        await tx.get(
          "SELECT COUNT(*) AS count FROM proxy_events e WHERE e.patient_id=? AND e.actor_id<>? AND NOT EXISTS(SELECT 1 FROM proxy_event_receipts r WHERE r.event_id=e.id AND r.user_id=?)",
          [actor.patient_id, actor.id, actor.id],
        )
      ).count,
    );
  }
  if (actor.organization_id) {
    count += Number(
      (
        await tx.get(
          "SELECT COUNT(*) AS count FROM emergency_requests WHERE requester_id=? AND organization_id=? AND status='approved' AND access_until>?",
          [actor.id, actor.organization_id, now()],
        )
      ).count,
    );
  }
  return count;
}

export async function handleEmergencyProxies(tx, context) {
  const { path, method, actor, body, searchParams, strong, fail, text, permit, limit } = context;
  if (!path.startsWith("/proxies") && !path.startsWith("/emergency")) {
    return;
  }
  strong(actor);
  const patientOnly = () => {
    if (!actor.patient_id || actor.organization_id) {
      fail(403, "Use your patient account to appoint a proxy.");
    }
  };
  const scopesInput = () => {
    if (
      !Array.isArray(body.scopes) ||
      !body.scopes.length ||
      body.scopes.length > 5 ||
      new Set(body.scopes).size !== body.scopes.length ||
      body.scopes.some((s) => !proxyCategories.includes(s)) ||
      typeof body.include_profile !== "boolean"
    ) {
      fail(400, "Choose record categories and whether to share allergies explicitly.");
    }
    return [...body.scopes].sort();
  };
  if (path === "/proxies" && method === "GET") {
    const candidates = await tx.all(
      `${appointmentSelect} WHERE p.patient_id=? OR p.proxy_user_id=? OR p.proxy_organization_id=? ORDER BY p.created_at DESC`,
      [actor.patient_id ?? "", actor.id, actor.organization_id ?? ""],
    );
    const appointments = [];
    for (const p of candidates) {
      const owner = actor.patient_id === p.patient_id;
      const respond = await canRespond(tx, actor, p);
      if (!owner && !respond) {
        continue;
      }
      appointments.push({
        ...p,
        scopes: parseScopes(p),
        effective: await currentAppointment(tx, p),
        can_revoke: owner && ["pending", "accepted"].includes(p.status),
        can_respond: respond && p.status === "pending",
      });
    }
    const primary = actor.patient_id
      ? await tx.get(
          "SELECT o.id,o.name FROM primary_care p JOIN organizations o ON o.id=p.organization_id WHERE p.patient_id=?",
          [actor.patient_id],
        )
      : null;
    return {
      appointments,
      primary,
      policy: proxyPolicy,
      policyVersion: proxyPolicyVersion,
      categories: proxyCategories,
    };
  }
  if (path === "/proxies" && method === "POST") {
    patientOnly();
    limit("proxy-invite", 20);
    const scopes = scopesInput();
    if (body.accept_policy !== true || body.policy_version !== proxyPolicyVersion) {
      fail(400, "Read and accept the current emergency-sharing policy.");
    }
    let userId = null;
    let orgId = null;
    if (body.kind === "facility") {
      const primary = await tx.get("SELECT organization_id FROM primary_care WHERE patient_id=?", [
        actor.patient_id,
      ]);
      if (!primary?.organization_id) {
        fail(400, "Choose an accepted primary care facility first.");
      }
      orgId = primary.organization_id;
    } else if (body.kind === "person") {
      const email = context.emailValue(body.email);
      let scope = "patient";
      if (body.workspace_code) {
        const org = await tx.get("SELECT id FROM organizations WHERE workspace_code=?", [
          text(body.workspace_code, "workspace code", 80, true).toUpperCase(),
        ]);
        if (!org) {
          fail(400, "No eligible account matches those details.");
        }
        scope = org.id;
      }
      const user = await tx.get(
        "SELECT id FROM users WHERE COALESCE(login_email,email)=? AND account_scope=? AND active=1",
        [email, scope],
      );
      if (!user || user.id === actor.id) {
        fail(
          400,
          "No eligible account matches those details. Choose another existing HealthPass user.",
        );
      }
      userId = user.id;
    } else {
      fail(400, "Choose a person or your primary care facility.");
    }
    await lockPatient(tx, actor.patient_id);
    if (
      await tx.get(
        "SELECT id FROM patient_proxies WHERE patient_id=? AND status IN ('pending','accepted') AND (proxy_user_id=? OR proxy_organization_id=?)",
        [actor.patient_id, userId, orgId],
      )
    ) {
      fail(409, "This proxy already has an active appointment or invitation.");
    }
    const id = randomUUID();
    await tx.run(
      "INSERT INTO patient_proxies(id,patient_id,proxy_user_id,proxy_organization_id,scopes_json,include_profile,policy_version,consented_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?)",
      [
        id,
        actor.patient_id,
        userId,
        orgId,
        JSON.stringify(scopes),
        Number(body.include_profile),
        proxyPolicyVersion,
        now(),
        now(),
      ],
    );
    await appendProxyEvent(tx, actor, actor.patient_id, id, "Proxy invited", {
      scopes,
      include_profile: body.include_profile,
      policy_version: proxyPolicyVersion,
      proxy_user_id: userId,
      proxy_organization_id: orgId,
    });
    return { id };
  }
  let match = path.match(/^\/proxies\/([^/]+)\/(accept|decline|revoke)$/);
  if (match && method === "POST") {
    let p = await tx.get("SELECT * FROM patient_proxies WHERE id=?", [match[1]]);
    if (!p) {
      fail(404, "Proxy appointment unavailable.");
    }
    await lockPatient(tx, p.patient_id);
    p = await tx.get("SELECT * FROM patient_proxies WHERE id=?", [p.id]);
    if (match[2] === "revoke") {
      if (actor.patient_id !== p.patient_id) {
        fail(403, "Only the patient can revoke this appointment.");
      }
      if (!["accepted", "pending"].includes(p.status)) {
        fail(409, "This appointment is already closed.");
      }
    } else {
      if (!(await canRespond(tx, actor, p))) {
        fail(403, "This invitation is not available to this account.");
      }
      if (p.status !== "pending") {
        fail(409, "This invitation has already been answered.");
      }
    }
    const status = { accept: "accepted", decline: "declined", revoke: "revoked" }[match[2]];
    await tx.run("UPDATE patient_proxies SET status=?,decided_at=? WHERE id=?", [
      status,
      now(),
      p.id,
    ]);
    await appendProxyEvent(tx, actor, p.patient_id, p.id, `Proxy ${status}`);
    return { status };
  }
  if (path === "/emergency" && method === "GET") {
    const rows = await tx.all(
      `${requestSelect} WHERE r.patient_id=? OR (r.requester_id=? AND r.organization_id=?) OR r.appointment_id IN (SELECT id FROM patient_proxies WHERE proxy_user_id=? OR proxy_organization_id=?) ORDER BY r.created_at DESC`,
      [
        actor.patient_id ?? "",
        actor.id,
        actor.organization_id ?? "",
        actor.id,
        actor.organization_id ?? "",
      ],
    );
    const requests = [];
    for (const r of rows) {
      const p = await tx.get("SELECT * FROM patient_proxies WHERE id=?", [r.appointment_id]);
      const respond = await canRespond(tx, actor, p, r);
      const requester = r.requester_id === actor.id && r.organization_id === actor.organization_id;
      if (actor.patient_id !== r.patient_id && !respond && !requester) {
        continue;
      }
      const effective = await currentAppointment(tx, p);
      requests.push({
        ...r,
        scopes: parseScopes(r),
        can_respond: respond && effective && r.status === "pending" && r.expires_at > now(),
        can_read:
          requester &&
          qualified(actor, "emergency.request") &&
          effective &&
          r.status === "approved" &&
          r.access_until > now() &&
          (actor.branch_id ?? null) === (r.branch_id ?? null),
        can_cancel:
          (requester || actor.patient_id === r.patient_id) &&
          ["pending", "approved"].includes(r.status),
        effective,
      });
    }
    return { requests };
  }
  if (path === "/emergency/options" && method === "GET") {
    permit(actor, "emergency.request");
    if (!qualified(actor, "emergency.request")) {
      fail(403, "Reviewed clinical authority is required.");
    }
    limit("emergency-lookup", 20);
    const patient = await tx.get(
      "SELECT id,name,healthpass_id FROM patients WHERE healthpass_id=?",
      [text(searchParams.get("healthpass_id"), "HealthPass ID", 100, true).toUpperCase()],
    );
    if (!patient) {
      fail(404, "No available proxy arrangement for this HealthPass ID.");
    }
    const rows = await tx.all(`${appointmentSelect} WHERE p.patient_id=? AND p.status='accepted'`, [
      patient.id,
    ]);
    const proxies = [];
    for (const p of rows) {
      if (p.proxy_user_id !== actor.id && (await currentAppointment(tx, p))) {
        proxies.push({
          id: p.id,
          name: p.proxy_name || p.proxy_facility,
          scopes: parseScopes(p),
          include_profile: !!p.include_profile,
        });
      }
    }
    if (!proxies.length) {
      fail(404, "No available proxy arrangement for this HealthPass ID.");
    }
    await appendProxyEvent(tx, actor, patient.id, patient.id, "Emergency proxy lookup");
    return { patient, proxies };
  }
  if (path === "/emergency" && method === "POST") {
    permit(actor, "emergency.request");
    if (!qualified(actor, "emergency.request")) {
      fail(403, "Reviewed clinical authority is required.");
    }
    limit("emergency-request", 20);
    const scopes = scopesInput();
    const reason = text(body.reason, "emergency reason", 1000, true);
    if (body.patient_unable_to_consent !== true) {
      fail(400, "Confirm that the patient cannot consent and waiting could jeopardise care.");
    }
    let p = await tx.get("SELECT * FROM patient_proxies WHERE id=?", [
      text(body.appointment_id, "proxy", 100, true),
    ]);
    if (!p) {
      fail(404, "Proxy unavailable.");
    }
    await lockPatient(tx, p.patient_id);
    p = await tx.get("SELECT * FROM patient_proxies WHERE id=?", [p.id]);
    if (!(await currentAppointment(tx, p)) || p.proxy_user_id === actor.id) {
      fail(403, "This proxy cannot authorise your request.");
    }
    if (
      scopes.some((s) => !parseScopes(p).includes(s)) ||
      (body.include_profile && !p.include_profile)
    ) {
      fail(403, "The request exceeds the patient’s chosen proxy authority.");
    }
    if (
      await tx.get(
        "SELECT id FROM emergency_requests WHERE appointment_id=? AND requester_id=? AND status='pending' AND expires_at>?",
        [p.id, actor.id, now()],
      )
    ) {
      fail(409, "A request is already awaiting this proxy’s response.");
    }
    const id = randomUUID();
    await tx.run(
      "INSERT INTO emergency_requests(id,appointment_id,patient_id,requester_id,organization_id,branch_id,scopes_json,include_profile,reason,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)",
      [
        id,
        p.id,
        p.patient_id,
        actor.id,
        actor.organization_id,
        actor.branch_id ?? null,
        JSON.stringify(scopes),
        Number(body.include_profile),
        reason,
        now(),
        new Date(Date.now() + 86400000).toISOString(),
      ],
    );
    await appendProxyEvent(tx, actor, p.patient_id, id, "Emergency access requested", {
      reason,
      scopes,
      include_profile: body.include_profile,
      appointment_id: p.id,
      patient_unable_to_consent: true,
    });
    return { id };
  }
  match = path.match(/^\/emergency\/([^/]+)\/(approve|decline|cancel|records)$/);
  if (match) {
    let r = await tx.get("SELECT * FROM emergency_requests WHERE id=?", [match[1]]);
    if (!r) {
      fail(404, "Emergency request unavailable.");
    }
    await lockPatient(tx, r.patient_id);
    r = await tx.get("SELECT * FROM emergency_requests WHERE id=?", [r.id]);
    const p = await tx.get("SELECT * FROM patient_proxies WHERE id=?", [r.appointment_id]);
    const action = match[2];
    if (action === "records" && method === "GET") {
      if (
        r.requester_id !== actor.id ||
        r.organization_id !== actor.organization_id ||
        (r.branch_id ?? null) !== (actor.branch_id ?? null) ||
        !qualified(actor, "emergency.request") ||
        r.status !== "approved" ||
        r.access_until <= now() ||
        !(await currentAppointment(tx, p))
      ) {
        fail(403, "No active emergency access for this account and workspace.");
      }
      // Recheck the approver's authority on every read, including staff suspension and role changes.
      const approver = await tx.get("SELECT * FROM users WHERE id=? AND active=1", [r.decided_by]);
      if (!approver) {
        fail(403, "Proxy authority is no longer available.");
      }
      if (p.proxy_organization_id) {
        const membership = await tx.get(
          "SELECT * FROM memberships WHERE user_id=? AND organization_id=? AND active=1",
          [approver.id, p.proxy_organization_id],
        );
        if (!membership) {
          fail(403, "Proxy authority is no longer available.");
        }
        approver.organization_id = p.proxy_organization_id;
        await resolveMembership(tx, membership, approver);
        if (!(await canRespond(tx, approver, p, r))) {
          fail(403, "Proxy authority is no longer available.");
        }
      }
      const scopes = parseScopes(r);
      const notes = await tx.all(
        "SELECT e.id,e.note_kind,o.name AS facility_name,n.id AS version_id,n.payload,n.signed_at,u.name AS author_name FROM encounters e JOIN note_versions n ON n.encounter_id=e.id JOIN organizations o ON o.id=e.organization_id JOIN users u ON u.id=n.author_id WHERE e.patient_id=? AND e.status<>'draft' AND n.version=(SELECT MAX(v.version) FROM note_versions v WHERE v.encounter_id=e.id) ORDER BY n.signed_at DESC",
        [r.patient_id],
      );
      const records = notes
        .filter((n) => scopes.includes(n.note_kind ?? "general"))
        .map((n) => ({ ...n, payload: JSON.parse(n.payload) }));
      const summaries = await emergencySummaries(tx, r.patient_id, scopes);
      const profile = r.include_profile
        ? await tx.get("SELECT allergy_status,allergies FROM patients WHERE id=?", [r.patient_id])
        : null;
      await appendProxyEvent(tx, actor, r.patient_id, r.id, "Emergency records viewed", {
        version_ids: records.map((n) => n.version_id),
        structured_record_ids: summaries.map((r) => r.id),
        scopes,
        include_profile: !!r.include_profile,
      });
      return { records, summaries, profile, accessUntil: r.access_until };
    }
    if (method !== "POST" || action === "records") {
      fail(405, "Method not allowed.");
    }
    if (action === "cancel") {
      if (
        actor.patient_id !== r.patient_id &&
        !(r.requester_id === actor.id && r.organization_id === actor.organization_id)
      ) {
        fail(403, "You cannot cancel this request.");
      }
      if (!["pending", "approved"].includes(r.status)) {
        fail(409, "This request is already closed.");
      }
    } else {
      if (!(await canRespond(tx, actor, p, r)) || !(await currentAppointment(tx, p))) {
        fail(403, "A different authorised proxy decision-maker must respond.");
      }
      if (r.status !== "pending" || r.expires_at <= now()) {
        fail(409, "This request is no longer awaiting a decision.");
      }
    }
    const reason = text(body.reason, "decision reason", 1000, true);
    const status = { approve: "approved", decline: "declined", cancel: "cancelled" }[action];
    const until = action === "approve" ? new Date(Date.now() + 3600000).toISOString() : null;
    await tx.run(
      "UPDATE emergency_requests SET status=?,decided_by=?,decision_reason=?,decided_at=?,access_until=? WHERE id=?",
      [status, actor.id, reason, now(), until, r.id],
    );
    await appendProxyEvent(tx, actor, r.patient_id, r.id, `Emergency access ${status}`, {
      reason,
      access_until: until,
    });
    return { status, accessUntil: until };
  }
  if (path === "/proxies/history" && method === "GET") {
    patientOnly();
    await lockPatient(tx, actor.patient_id);
    const evidence = await tx.all(
      "SELECT * FROM proxy_events WHERE patient_id=? ORDER BY sequence",
      [actor.patient_id],
    );
    const head = await tx.get("SELECT sequence,hash FROM proxy_event_heads WHERE patient_id=?", [
      actor.patient_id,
    ]);
    if (!verifyProxyEvidence(evidence, head)) {
      fail(503, "Emergency history integrity could not be verified. Contact HealthPass support.");
    }
    const before = Number(searchParams.get("before") || 2147483647);
    if (!Number.isSafeInteger(before) || before < 1) {
      fail(400, "Invalid history cursor.");
    }
    const events = await tx.all(
      "SELECT e.*,u.name AS actor_name,o.name AS facility_name FROM proxy_events e JOIN users u ON u.id=e.actor_id LEFT JOIN organizations o ON o.id=e.organization_id WHERE e.patient_id=? AND e.sequence<? ORDER BY e.sequence DESC LIMIT 100",
      [actor.patient_id, before],
    );
    return { events, nextBefore: events.length === 100 ? events.at(-1).sequence : null };
  }
  if (path === "/proxies/history/seen" && method === "POST") {
    patientOnly();
    const ids = body.event_ids;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== "string")) {
      fail(400, "Choose displayed events.");
    }
    for (const id of ids) {
      await tx.run(
        "INSERT INTO proxy_event_receipts(user_id,event_id) SELECT ?,id FROM proxy_events WHERE id=? AND patient_id=? ON CONFLICT(user_id,event_id) DO NOTHING",
        [actor.id, id, actor.patient_id],
      );
    }
    return { saved: true };
  }
  fail(404, "Endpoint unavailable.");
}
