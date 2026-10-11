import { randomUUID } from "node:crypto";
import { hasPermission, resolveMembership } from "./roles.mjs";

const timestamp = () => new Date().toISOString();
const operationalSelect = `SELECT v.id,v.patient_id,p.name AS patient_name,p.healthpass_id,v.branch_id,b.name AS branch_name,v.assigned_user_id,u.name AS assigned_name,v.status,v.version,v.checked_in_at,v.started_at,v.completed_at,v.updated_at FROM care_visits v JOIN patients p ON p.id=v.patient_id JOIN branches b ON b.id=v.branch_id JOIN users u ON u.id=v.assigned_user_id`;
const activeStatuses = new Set(["waiting", "in-progress"]);
const vitalLimits = {
  systolic: [40, 300],
  diastolic: [20, 200],
  pulse: [10, 300],
  temperature: [25, 45],
  spo2: [50, 100],
  respiratory_rate: [2, 100],
  weight: [0.1, 700],
};

async function scopedVisit(tx, actor, id, fail) {
  const visit = await tx.get("SELECT * FROM care_visits WHERE id=? AND organization_id=?", [
    id,
    actor.organization_id,
  ]);
  if (!visit || (actor.branch_id && visit.branch_id !== actor.branch_id))
    fail(404, "Visit unavailable in this workspace and branch.");
  return visit;
}

async function scopedBranch(tx, actor, value, fail, text) {
  const id = text(value ?? actor.branch_id, "branch ID", 100, true);
  const branch = await tx.get(
    "SELECT id,name FROM branches WHERE id=? AND organization_id=? AND active=1",
    [id, actor.organization_id],
  );
  if (!branch || (actor.branch_id && actor.branch_id !== id))
    fail(403, "Choose an active branch within your workspace access.");
  return branch;
}

async function eligibleProfessional(tx, actor, userId, branchId) {
  const user = await tx.get("SELECT * FROM users WHERE id=? AND active=1 AND verified=1", [userId]);
  if (!user) return null;
  const membership = await tx.get(
    "SELECT * FROM memberships WHERE user_id=? AND organization_id=? AND active=1",
    [userId, actor.organization_id],
  );
  if (!membership || (membership.branch_id && membership.branch_id !== branchId)) return null;
  user.organization_id = actor.organization_id;
  await resolveMembership(tx, membership, user);
  if (
    !hasPermission(user, "visits.document") ||
    !hasPermission(user, "records.view") ||
    !user.clinicalScopes.length
  )
    return null;
  return { id: user.id, name: user.name, clinicalScopes: user.clinicalScopes };
}

async function recordEvent(tx, actor, visit, action, nextStatus, audit, correlation) {
  await tx.run(
    "INSERT INTO visit_events(id,visit_id,actor_id,action,from_status,to_status,assigned_user_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      randomUUID(),
      visit.id,
      actor.id,
      action,
      action === "visit.check_in" ? null : visit.status,
      nextStatus,
      visit.assigned_user_id,
      timestamp(),
    ],
  );
  await audit(
    tx,
    actor,
    action,
    "allow",
    visit.patient_id,
    visit.id,
    correlation,
    null,
    JSON.stringify({ from_status: visit.status, to_status: nextStatus }),
  );
}

async function clinicalAccess(
  tx,
  actor,
  visit,
  permission,
  { permit, access, fail },
  { write = true } = {},
) {
  permit(actor, permission);
  if (visit.assigned_user_id !== actor.id)
    fail(403, "Clinical visit work is limited to the assigned professional.");
  // Operational routing never establishes consent or clinical chart authority.
  return access(tx, actor, visit.patient_id, write);
}

function visitAccessScope(result, actor) {
  const policy = result?.accessPolicy;
  return {
    restricted: policy?.restricted ?? false,
    scopes: policy?.scopes ?? ["general", "nursing", "medication"],
    includeProfile: policy?.includeProfile ?? true,
    canContribute: policy?.canContribute ?? true,
    contributionScopes: policy?.contributionScopes ?? actor.clinicalScopes ?? [],
  };
}

function contributionDiscipline(result, actor, requested, allowed, fail) {
  const scope = visitAccessScope(result, actor);
  const eligible = (actor.clinicalScopes ?? []).filter(
    (discipline) => allowed.includes(discipline) && scope.contributionScopes.includes(discipline),
  );
  const discipline = requested ?? eligible[0];
  if (!scope.canContribute || !eligible.includes(discipline))
    fail(
      403,
      "Your reviewed scope and the patient's sharing choice do not permit this contribution.",
    );
  return discipline;
}

async function replayClinicalRequest(tx, table, visit, actor, requestId, payload, fail) {
  if (!requestId) return null;
  const replay = await tx.get(
    `SELECT id,request_payload,discipline${table === "visit_followups" ? ",version" : ""} FROM ${table} WHERE visit_id=? AND author_id=? AND client_request_id=?`,
    [visit.id, actor.id, requestId],
  );
  let replayPayload = replay?.request_payload;
  if (replayPayload) {
    const original = JSON.parse(replayPayload);
    if (original.length === 2) replayPayload = JSON.stringify([...original, replay.discipline]);
  }
  if (replay && replayPayload !== payload)
    fail(409, "This request was already used for different clinical details.");
  return replay
    ? { id: replay.id, ...(replay.version ? { version: replay.version } : {}), existing: true }
    : null;
}

/** Validate optional linkage without creating a new care relationship. */
export async function validateEncounterVisit(
  tx,
  context,
  visitId,
  patientId,
  { allowCompleted = false } = {},
) {
  const { actor, fail, permit, access } = context;
  if (!visitId) return null;
  const visit = await scopedVisit(tx, actor, visitId, fail);
  await clinicalAccess(tx, actor, visit, "visits.document", { permit, access, fail });
  if (visit.patient_id !== patientId)
    fail(400, "The note and visit must belong to the same patient.");
  if (visit.status !== "in-progress" && !(allowCompleted && visit.status === "completed"))
    fail(409, "Start the visit before adding or changing a linked note.");
  return visit;
}

/** Returns undefined for routes outside this domain. All writes share the API transaction. */
export async function handleVisits(tx, context) {
  const {
    actor,
    path,
    method,
    body,
    searchParams,
    permit,
    access,
    fail,
    text,
    audit,
    correlation,
  } = context;
  if (!path.startsWith("/visits")) return undefined;
  if (path === "/visits/patients" && method === "GET") {
    permit(actor, "visits.manage");
    const branch = await scopedBranch(tx, actor, searchParams.get("branch_id"), fail, text);
    const search = text(searchParams.get("search") ?? "", "patient search", 160);
    const limit = Number(searchParams.get("limit") ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      fail(400, "Patient search page size must be between 1 and 50.");
    const pattern = "%" + search.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%";
    return {
      patients: await tx.all(
        "SELECT p.id,p.name,p.healthpass_id,p.dob FROM patients p JOIN patient_links pl ON pl.patient_id=p.id JOIN branch_patient_links bp ON bp.patient_id=p.id WHERE pl.organization_id=? AND bp.branch_id=? AND (LOWER(p.name) LIKE ? ESCAPE '\\' OR LOWER(p.healthpass_id) LIKE ? ESCAPE '\\') ORDER BY p.name,p.id LIMIT ?",
        [actor.organization_id, branch.id, pattern, pattern, limit],
      ),
    };
  }
  if (path === "/visits/team" && method === "GET") {
    permit(actor, "visits.view");
    const branches = await tx.all(
      `SELECT id,name FROM branches WHERE organization_id=? AND active=1${actor.branch_id ? " AND id=?" : ""} ORDER BY name`,
      actor.branch_id ? [actor.organization_id, actor.branch_id] : [actor.organization_id],
    );
    const branchId = searchParams.get("branch_id") ?? actor.branch_id ?? branches[0]?.id;
    if (!branchId) return { professionals: [], branches };
    await scopedBranch(tx, actor, branchId, fail, text);
    const rows = await tx.all(
      "SELECT user_id FROM memberships WHERE organization_id=? AND active=1 AND (branch_id IS NULL OR branch_id=?) ORDER BY user_id",
      [actor.organization_id, branchId],
    );
    const professionals = [];
    for (const row of rows) {
      const professional = await eligibleProfessional(tx, actor, row.user_id, branchId);
      if (professional) professionals.push(professional);
    }
    professionals.sort((a, b) => a.name.localeCompare(b.name));
    return { professionals, branches };
  }

  if (path === "/visits" && method === "GET") {
    permit(actor, "visits.view");
    const params = searchParams;
    const where = ["v.organization_id=?"];
    const args = [actor.organization_id];
    const branchId = params.get("branch_id") ?? actor.branch_id;
    if (branchId) {
      await scopedBranch(tx, actor, branchId, fail, text);
      where.push("v.branch_id=?");
      args.push(branchId);
    }
    const status = params.get("status") ?? "active";
    if (status === "active") where.push("v.status IN ('waiting','in-progress')");
    else if (["waiting", "in-progress", "completed", "cancelled"].includes(status)) {
      where.push("v.status=?");
      args.push(status);
    } else if (status !== "all") fail(400, "Choose a valid visit status.");
    const limit = Number(params.get("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail(400, "Visit page size must be between 1 and 100.");
    const cursor = params.get("cursor");
    if (cursor) {
      const previous = await scopedVisit(tx, actor, text(cursor, "visit cursor", 100, true), fail);
      if (branchId && previous.branch_id !== branchId)
        fail(400, "Visit cursor is outside this branch.");
      where.push("(v.checked_in_at<? OR (v.checked_in_at=? AND v.id<?))");
      args.push(previous.checked_in_at, previous.checked_in_at, previous.id);
    }
    const rows = await tx.all(
      `${operationalSelect} WHERE ${where.join(" AND ")} ORDER BY v.checked_in_at DESC,v.id DESC LIMIT ?`,
      [...args, limit + 1],
    );
    return {
      visits: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  if (path === "/visits" && method === "POST") {
    permit(actor, "visits.manage");
    const branch = await scopedBranch(tx, actor, body.branch_id, fail, text);
    const patientId = text(body.patient_id, "patient ID", 100, true);
    const assignee = text(body.assigned_user_id, "assigned professional", 100, true);
    const requestId = text(body.client_request_id, "check-in request ID", 100, true);
    const requestPayload = JSON.stringify([patientId, branch.id, assignee]);
    const existing = await tx.get(
      "SELECT * FROM care_visits WHERE organization_id=? AND created_by=? AND client_request_id=?",
      [actor.organization_id, actor.id, requestId],
    );
    if (existing) {
      if (existing.request_payload !== requestPayload)
        fail(409, "This check-in request was already used for different details.");
      return { id: existing.id, version: existing.version, existing: true };
    }
    const patient = await tx.get(
      "SELECT p.id FROM patients p JOIN patient_links pl ON pl.patient_id=p.id JOIN branch_patient_links bp ON bp.patient_id=p.id WHERE p.id=? AND pl.organization_id=? AND bp.branch_id=?",
      [patientId, actor.organization_id, branch.id],
    );
    if (!patient) fail(403, "Register or verify-link this patient in the selected branch first.");
    if (!(await eligibleProfessional(tx, actor, assignee, branch.id)))
      fail(403, "Choose an approved professional with reviewed clinical access in this branch.");
    const activeKey = branch.id + ":" + patientId;
    if (
      await tx.get("SELECT id FROM care_visits WHERE organization_id=? AND active_key=?", [
        actor.organization_id,
        activeKey,
      ])
    )
      fail(409, "This patient already has an active visit in this branch.");
    const id = randomUUID(),
      date = timestamp();
    const inserted = await tx.run(
      "INSERT INTO care_visits(id,patient_id,organization_id,branch_id,assigned_user_id,created_by,client_request_id,request_payload,active_key,status,checked_in_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'waiting',?,?) ON CONFLICT DO NOTHING",
      [
        id,
        patientId,
        actor.organization_id,
        branch.id,
        assignee,
        actor.id,
        requestId,
        requestPayload,
        activeKey,
        date,
        date,
      ],
    );
    if ((inserted.rowCount ?? inserted.changes) !== 1) {
      const replay = await tx.get(
        "SELECT id,version,request_payload FROM care_visits WHERE organization_id=? AND created_by=? AND client_request_id=?",
        [actor.organization_id, actor.id, requestId],
      );
      if (replay?.request_payload === requestPayload)
        return { id: replay.id, version: replay.version, existing: true };
      fail(409, "An active visit or check-in request already exists. Refresh the queue.");
    }
    await recordEvent(
      tx,
      actor,
      { id, patient_id: patientId, assigned_user_id: assignee, status: "waiting" },
      "visit.check_in",
      "waiting",
      audit,
      correlation,
    );
    return { id, version: 1, existing: false };
  }

  const match = path.match(/^\/visits\/([^/]+)(?:\/(observations|follow-ups)(?:\/([^/]+))?)?$/);
  if (!match) return undefined;
  const visit = await scopedVisit(tx, actor, match[1], fail);
  if (!match[2] && method === "GET") {
    permit(actor, "visits.view");
    let clinicalAllowed = false;
    let accessScope = null;
    let clinicalPolicy = null;
    if (visit.assigned_user_id === actor.id && hasPermission(actor, "visits.document")) {
      try {
        const result = await clinicalAccess(tx, actor, visit, "visits.document", context, {
          write: false,
        });
        accessScope = visitAccessScope(result, actor);
        clinicalPolicy = result.accessPolicy ?? null;
        clinicalAllowed = true;
      } catch (error) {
        if (error.status !== 403 && error.statusCode !== 403) throw error;
      }
    }
    const summary = await tx.get(`${operationalSelect} WHERE v.id=?`, [visit.id]);
    const scopedParameters = accessScope?.scopes ?? [];
    const categoryFilter = scopedParameters.map(() => "?").join(",");
    const followUpScopes = clinicalPolicy?.restricted
      ? scopedParameters
      : [...scopedParameters, "unknown"];
    const followUpCategoryFilter = followUpScopes.map(() => "?").join(",");
    if (clinicalAllowed)
      await audit(
        tx,
        actor,
        "visit.clinical.read",
        "allow",
        visit.patient_id,
        visit.id,
        correlation,
        null,
        JSON.stringify({
          active_professional_grant_ids: clinicalPolicy?.grants?.map((grant) => grant.id) ?? [],
          scopes: scopedParameters,
        }),
      );
    const observations =
      clinicalAllowed && scopedParameters.length
        ? await tx.all(
            `SELECT id,author_id,discipline,values_json,observed_at,created_at FROM visit_observations WHERE visit_id=? AND discipline IN (${categoryFilter}) ORDER BY observed_at DESC,id DESC LIMIT 100`,
            [visit.id, ...scopedParameters],
          )
        : [];
    return {
      visit: summary,
      clinicalAllowed,
      accessScope,
      observations: observations.map(({ values_json, ...row }) => ({
        ...row,
        values: JSON.parse(values_json),
      })),
      followUps:
        clinicalAllowed && followUpScopes.length
          ? await tx.all(
              `SELECT id,author_id,discipline,title,due_at,status,version,created_at,updated_at FROM visit_followups WHERE visit_id=? AND author_id=? AND discipline IN (${followUpCategoryFilter}) ORDER BY due_at,id LIMIT 100`,
              [visit.id, actor.id, ...followUpScopes],
            )
          : [],
    };
  }

  if (!match[2] && method === "PATCH") {
    if (!Number.isInteger(body.version) || body.version !== visit.version)
      fail(409, "This visit changed. Refresh it before continuing.");
    const assigning = Object.hasOwn(body, "assigned_user_id");
    if (assigning && Object.hasOwn(body, "status"))
      fail(400, "Change the assignment or status in one action, not both.");
    let status = visit.status,
      assignee = visit.assigned_user_id,
      action;
    if (assigning) {
      permit(actor, "visits.manage");
      if (visit.status !== "waiting") fail(409, "Only a waiting visit can be reassigned.");
      assignee = text(body.assigned_user_id, "assigned professional", 100, true);
      if (!(await eligibleProfessional(tx, actor, assignee, visit.branch_id)))
        fail(403, "Choose an approved professional with reviewed clinical access in this branch.");
      action = "visit.assign";
    } else {
      status = body.status;
      if (status === "cancelled") {
        permit(actor, "visits.manage");
        if (!activeStatuses.has(visit.status)) fail(409, "Only an active visit can be cancelled.");
      } else if (status === "in-progress" && visit.status === "waiting") {
        const result = await clinicalAccess(tx, actor, visit, "visits.document", context);
        contributionDiscipline(
          result,
          actor,
          undefined,
          ["general", "nursing", "medication"],
          fail,
        );
      } else if (status === "completed" && visit.status === "in-progress") {
        const result = await clinicalAccess(tx, actor, visit, "visits.document", context);
        contributionDiscipline(
          result,
          actor,
          undefined,
          ["general", "nursing", "medication"],
          fail,
        );
        const scopes = visitAccessScope(result, actor).contributionScopes.filter((scope) =>
          actor.clinicalScopes.includes(scope),
        );
        const signed = await tx.get(
          `SELECT e.id FROM encounters e JOIN note_versions n ON n.encounter_id=e.id WHERE e.visit_id=? AND e.patient_id=? AND e.organization_id=? AND e.branch_id=? AND e.author_id=? AND e.note_kind IN (${scopes.map(() => "?").join(",")}) AND e.status IN ('signed','amended') LIMIT 1`,
          [visit.id, visit.patient_id, actor.organization_id, visit.branch_id, actor.id, ...scopes],
        );
        if (!signed) fail(409, "Sign a clinical note linked to this visit before completing it.");
      } else fail(409, "This visit status transition is not available.");
      action = "visit." + status;
    }
    const date = timestamp();
    const result = await tx.run(
      "UPDATE care_visits SET assigned_user_id=?,status=?,version=version+1,started_at=?,completed_at=?,active_key=?,updated_at=? WHERE id=? AND version=?",
      [
        assignee,
        status,
        status === "in-progress" && !visit.started_at ? date : visit.started_at,
        status === "completed" ? date : visit.completed_at,
        activeStatuses.has(status) ? visit.active_key : null,
        date,
        visit.id,
        body.version,
      ],
    );
    if ((result.rowCount ?? result.changes) !== 1)
      fail(409, "This visit changed. Refresh it before continuing.");
    await recordEvent(
      tx,
      actor,
      { ...visit, assigned_user_id: assignee },
      action,
      status,
      audit,
      correlation,
    );
    return { id: visit.id, version: body.version + 1 };
  }

  if (match[2] === "observations" && !match[3] && method === "POST") {
    const result = await clinicalAccess(tx, actor, visit, "observations.create", context);
    const discipline = contributionDiscipline(
      result,
      actor,
      body.discipline,
      ["general", "nursing"],
      fail,
    );
    if (!body.values || typeof body.values !== "object" || Array.isArray(body.values))
      fail(400, "Enter structured observation values.");
    const values = {};
    for (const [key, value] of Object.entries(body.values).sort(([a], [b]) => a.localeCompare(b))) {
      const bounds = vitalLimits[key];
      if (
        !bounds ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < bounds[0] ||
        value > bounds[1]
      )
        fail(400, "Choose a supported vital and enter a value within its measurement range.");
      values[key] = value;
    }
    if (!Object.keys(values).length) fail(400, "Enter at least one observation.");
    if (
      values.systolic !== undefined &&
      values.diastolic !== undefined &&
      values.systolic <= values.diastolic
    )
      fail(400, "Systolic pressure must exceed diastolic pressure.");
    const date = timestamp();
    const observedTime = body.observed_at === undefined ? Date.now() : Date.parse(body.observed_at);
    if (!Number.isFinite(observedTime)) fail(400, "Enter a valid observation time.");
    const observedAt = new Date(observedTime).toISOString();
    const requestId =
      body.client_request_id === undefined
        ? null
        : text(body.client_request_id, "observation request ID", 100, true);
    const payload = JSON.stringify([
      values,
      body.observed_at === undefined ? null : observedAt,
      discipline,
    ]);
    const replay = await replayClinicalRequest(
      tx,
      "visit_observations",
      visit,
      actor,
      requestId,
      payload,
      fail,
    );
    if (replay) return replay;
    if (visit.status !== "in-progress")
      fail(409, "Record observations during an in-progress visit.");
    if (Date.parse(observedAt) > Date.now() + 60000 || observedAt < visit.checked_in_at)
      fail(400, "Observation time must fall within this visit and not in the future.");
    const id = randomUUID();
    const inserted = await tx.run(
      "INSERT INTO visit_observations(id,visit_id,author_id,client_request_id,request_payload,discipline,values_json,observed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      [
        id,
        visit.id,
        actor.id,
        requestId,
        payload,
        discipline,
        JSON.stringify(values),
        observedAt,
        date,
      ],
    );
    if ((inserted.rowCount ?? inserted.changes) !== 1) {
      const concurrent = await replayClinicalRequest(
        tx,
        "visit_observations",
        visit,
        actor,
        requestId,
        payload,
        fail,
      );
      if (concurrent) return concurrent;
      fail(409, "This observation request changed. Refresh the visit.");
    }
    await audit(tx, actor, "visit.observation", "allow", visit.patient_id, id, correlation);
    return { id };
  }

  if (match[2] === "follow-ups" && method === "POST" && !match[3]) {
    const result = await clinicalAccess(tx, actor, visit, "followups.manage", context);
    const discipline = contributionDiscipline(
      result,
      actor,
      body.discipline,
      ["general", "nursing", "medication"],
      fail,
    );
    const title = text(body.title, "follow-up task", 500, true);
    const due = Date.parse(body.due_at);
    if (!Number.isFinite(due)) fail(400, "Choose a valid future follow-up date.");
    const requestId =
      body.client_request_id === undefined
        ? null
        : text(body.client_request_id, "follow-up request ID", 100, true);
    const payload = JSON.stringify([title, new Date(due).toISOString(), discipline]);
    const replay = await replayClinicalRequest(
      tx,
      "visit_followups",
      visit,
      actor,
      requestId,
      payload,
      fail,
    );
    if (replay) return replay;
    if (due < Date.now()) fail(400, "Choose a valid future follow-up date.");
    if (visit.status === "waiting" || visit.status === "cancelled")
      fail(409, "Create follow-up work during or after the clinical visit.");
    const id = randomUUID(),
      date = timestamp();
    const inserted = await tx.run(
      "INSERT INTO visit_followups(id,visit_id,author_id,client_request_id,request_payload,discipline,title,due_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'open',?,?) ON CONFLICT DO NOTHING",
      [
        id,
        visit.id,
        actor.id,
        requestId,
        payload,
        discipline,
        title,
        new Date(due).toISOString(),
        date,
        date,
      ],
    );
    if ((inserted.rowCount ?? inserted.changes) !== 1) {
      const concurrent = await replayClinicalRequest(
        tx,
        "visit_followups",
        visit,
        actor,
        requestId,
        payload,
        fail,
      );
      if (concurrent) return concurrent;
      fail(409, "This follow-up request changed. Refresh the visit.");
    }
    await audit(tx, actor, "visit.followup.create", "allow", visit.patient_id, id, correlation);
    return { id, version: 1 };
  }

  if (match[2] === "follow-ups" && method === "PATCH" && match[3]) {
    const accessResult = await clinicalAccess(tx, actor, visit, "followups.manage", context);
    const task = await tx.get(
      "SELECT * FROM visit_followups WHERE id=? AND visit_id=? AND author_id=?",
      [match[3], visit.id, actor.id],
    );
    if (!task) fail(404, "Follow-up task unavailable.");
    if (task.discipline === "unknown" && accessResult.accessPolicy?.restricted)
      fail(
        403,
        "This historical follow-up has no confirmed category and cannot be changed through a scoped grant.",
      );
    contributionDiscipline(
      accessResult,
      actor,
      task.discipline === "unknown" ? undefined : task.discipline,
      ["general", "nursing", "medication"],
      fail,
    );
    if (!Number.isInteger(body.version) || body.version !== task.version || task.status !== "open")
      fail(409, "This follow-up changed. Refresh it before continuing.");
    if (!["completed", "cancelled"].includes(body.status))
      fail(400, "Choose completed or cancelled.");
    const result = await tx.run(
      "UPDATE visit_followups SET status=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='open'",
      [body.status, timestamp(), task.id, body.version],
    );
    if ((result.rowCount ?? result.changes) !== 1)
      fail(409, "This follow-up changed. Refresh it before continuing.");
    await audit(
      tx,
      actor,
      "visit.followup." + body.status,
      "allow",
      visit.patient_id,
      task.id,
      correlation,
    );
    return { id: task.id, version: body.version + 1 };
  }
  return undefined;
}
