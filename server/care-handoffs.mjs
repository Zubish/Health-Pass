import { randomUUID } from "node:crypto";
import { hasPermission, resolveMembership } from "./roles.mjs";

const now = () => new Date().toISOString();
const live = (h) => h.status === "pending" && h.expires_at > now();
const participantSql = `SELECT v.id FROM care_visits v WHERE v.organization_id=?
 AND (CAST(? AS TEXT) IS NULL OR v.branch_id=?) AND
 (v.assigned_user_id=? OR EXISTS(SELECT 1 FROM visit_handoffs h WHERE h.visit_id=v.id
 AND h.organization_id=v.organization_id AND h.branch_id=v.branch_id AND
 ((h.status='accepted' AND (h.from_user_id=? OR h.to_user_id=?))
 OR (h.status='pending' AND h.to_user_id=? AND h.expires_at>?))))`;
const participantArgs = (actor) => [
  actor.organization_id,
  actor.branch_id ?? null,
  actor.branch_id ?? null,
  actor.id,
  actor.id,
  actor.id,
  actor.id,
  now(),
];
export async function visitParticipation(tx, actor, visitId) {
  if (!actor?.organization_id) return false;
  return !!(await tx.get(`${participantSql} AND v.id=?`, [...participantArgs(actor), visitId]));
}
export async function participatingVisitIds(tx, actor, patientId) {
  if (!actor?.organization_id) return [];
  return (
    await tx.all(
      `${participantSql} AND v.patient_id=? ORDER BY v.checked_in_at DESC,v.id LIMIT 100`,
      [...participantArgs(actor), patientId],
    )
  ).map((row) => row.id);
}

async function professional(tx, userId, visit) {
  const user = await tx.get(
    "SELECT id,name,patient_id,verified,active,provider_support_verified FROM users WHERE id=? AND active=1 AND verified=1 AND patient_id IS NULL",
    [userId],
  );
  if (!user) return null;
  const member = await tx.get(
    "SELECT * FROM memberships WHERE user_id=? AND organization_id=? AND active=1",
    [userId, visit.organization_id],
  );
  if (!member || (member.branch_id && member.branch_id !== visit.branch_id)) return null;
  if (
    !(await tx.get("SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1", [
      visit.branch_id,
      visit.organization_id,
    ]))
  )
    return null;
  user.organization_id = visit.organization_id;
  user.branch_id = member.branch_id ?? null;
  await resolveMembership(tx, member, user);
  if (
    !hasPermission(user, "visits.document") ||
    !hasPermission(user, "records.view") ||
    !hasPermission(user, "notes.create") ||
    !user.clinicalScopes.length ||
    user.accessExpired ||
    user.supportAccess
  )
    return null;
  return user;
}

export async function handleCareHandoffs(tx, context) {
  const {
    actor,
    path,
    method,
    body,
    permit,
    strong,
    fail,
    text,
    audit,
    correlation,
    careAuthority,
  } = context;
  const route = path.match(
    /^\/visits\/([^/]+)\/handoffs(?:\/([^/]+)\/(accept|decline|withdraw))?$/,
  );
  if (!route) return undefined;
  strong(actor);
  permit(actor, "visits.view");
  let visit = await tx.get("SELECT * FROM care_visits WHERE id=? AND organization_id=?", [
    route[1],
    actor.organization_id,
  ]);
  if (!visit || (actor.branch_id && actor.branch_id !== visit.branch_id))
    fail(404, "Visit unavailable in this workspace and branch.");
  // All linked clinical mutations take this same lock before encounter/task locks.
  // Refresh after waiting: a concurrent acceptance may have changed the assignee/version.
  if (method === "POST") {
    visit = await tx.get(
      "UPDATE care_visits SET version=version WHERE id=? AND organization_id=? RETURNING *",
      [visit.id, actor.organization_id],
    );
    if (!visit || (actor.branch_id && actor.branch_id !== visit.branch_id))
      fail(404, "Visit unavailable in this workspace and branch.");
  }
  const checkVersion = () => {
    if (!Number.isInteger(body.version) || body.version < 1)
      fail(400, "Use the current visit version.");
    if (body.version !== visit.version) fail(409, "The visit changed. Refresh before continuing.");
  };
  const authority = async (userId, sourceKind = null) => {
    const user = await professional(tx, userId, visit);
    if (!user) return null;
    try {
      const result = await careAuthority(tx, user, visit.patient_id, true);
      const policy = result?.accessPolicy ?? result;
      const contributions = (policy?.contributionScopes ?? user.clinicalScopes).filter((s) =>
        user.clinicalScopes.includes(s),
      );
      if (
        !contributions.length ||
        policy?.canContribute === false ||
        (sourceKind &&
          !(policy?.scopes ?? ["general", "nursing", "medication"]).includes(sourceKind))
      )
        return null;
      return { user, policy, contributions };
    } catch (error) {
      if (error.status === 403 || error.status === 404) return null;
      throw error;
    }
  };
  const sourceFor = async (sourceId, fromId) =>
    tx.get(
      "SELECT id,version,note_kind,created_at,status FROM encounters WHERE id=? AND visit_id=? AND patient_id=? AND organization_id=? AND branch_id=? AND author_id=? AND status IN ('signed','amended')",
      [sourceId, visit.id, visit.patient_id, visit.organization_id, visit.branch_id, fromId],
    );
  const hasDraft = async (fromId) =>
    !!(await tx.get(
      "SELECT id FROM encounters WHERE visit_id=? AND author_id=? AND status='draft' LIMIT 1",
      [visit.id, fromId],
    ));
  const event = async (action, assignee) => {
    await tx.run(
      "INSERT INTO visit_events(id,visit_id,actor_id,action,from_status,to_status,assigned_user_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [randomUUID(), visit.id, actor.id, action, visit.status, visit.status, assignee, now()],
    );
    await audit(tx, actor, action, "allow", visit.patient_id, visit.id, correlation);
  };
  const bumpVisit = async (assignee = visit.assigned_user_id) => {
    const row = await tx.get(
      "UPDATE care_visits SET assigned_user_id=?,version=version+1,updated_at=? WHERE id=? AND version=? RETURNING version",
      [assignee, now(), visit.id, visit.version],
    );
    if (!row) fail(409, "The visit changed. Refresh before continuing.");
    return row.version;
  };
  const handoffs = await tx.all(
    `SELECT h.*,f.name AS from_name,t.name AS to_name,e.note_kind AS source_note_kind
    FROM visit_handoffs h JOIN users f ON f.id=h.from_user_id JOIN users t ON t.id=h.to_user_id
    JOIN encounters e ON e.id=h.source_encounter_id WHERE h.visit_id=? ORDER BY h.created_at DESC,h.id LIMIT 50`,
    [visit.id],
  );

  if (method === "GET" && !route[2]) {
    const current = visit.assigned_user_id === actor.id ? await authority(actor.id) : null;
    const drafts = current ? await hasDraft(actor.id) : false;
    const pending = handoffs.some(live);
    let sourceNotes = [];
    const professionals = [];
    if (current && visit.status === "in-progress" && !drafts && !pending) {
      const candidates = await tx.all(
        "SELECT id,version,note_kind,created_at FROM encounters WHERE visit_id=? AND author_id=? AND status IN ('signed','amended') ORDER BY created_at DESC,id LIMIT 50",
        [visit.id, actor.id],
      );
      sourceNotes = candidates.filter((n) => current.contributions.includes(n.note_kind));
      const members = await tx.all(
        "SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=? AND m.active=1 AND m.clinical_verified=1 AND u.active=1 AND u.verified=1 AND u.id<>? ORDER BY u.name,u.id LIMIT 100",
        [visit.organization_id, actor.id],
      );
      for (const member of members) {
        const eligible = await authority(member.id);
        if (
          eligible &&
          sourceNotes.some((note) =>
            (eligible.policy?.scopes ?? ["general", "nursing", "medication"]).includes(
              note.note_kind,
            ),
          )
        )
          professionals.push({
            id: eligible.user.id,
            name: eligible.user.name,
            clinicalScopes: eligible.user.clinicalScopes,
            allowed_source_note_ids: sourceNotes
              .filter((note) =>
                (eligible.policy?.scopes ?? ["general", "nursing", "medication"]).includes(
                  note.note_kind,
                ),
              )
              .map((note) => note.id),
          });
        if (professionals.length >= 50) break;
      }
    }
    const display = [];
    for (const row of handoffs) {
      let canAccept = false,
        canDecline = false,
        canWithdraw = false,
        reason = null;
      if (row.status === "pending") {
        if (visit.status !== "in-progress" || visit.assigned_user_id !== row.from_user_id)
          reason = "The visit responsibility changed.";
        else if (actor.id === row.to_user_id || actor.id === row.from_user_id) {
          const source = await sourceFor(row.source_encounter_id, row.from_user_id);
          const from = await authority(row.from_user_id, source?.note_kind),
            to = await authority(row.to_user_id, source?.note_kind);
          const sourceUnchanged =
            source && source.version === row.source_version && !(await hasDraft(row.from_user_id));
          canWithdraw = actor.id === row.from_user_id;
          canDecline = actor.id === row.to_user_id && live(row);
          canAccept =
            canDecline &&
            !!to &&
            !!from &&
            sourceUnchanged &&
            from.contributions.includes(source.note_kind);
          if (!live(row))
            reason = "This request expired. The sender may withdraw it or create a new request.";
          else if (!from || !to)
            reason = "Current roles or patient sharing no longer permit this handoff.";
          else if (!sourceUnchanged)
            reason = "The signed source changed or an outgoing draft remains unfinished.";
        }
      }
      display.push({
        id: row.id,
        visit_id: row.visit_id,
        from_user_id: row.from_user_id,
        to_user_id: row.to_user_id,
        from_name: row.from_name,
        to_name: row.to_name,
        source_encounter_id: row.source_encounter_id,
        source_version: row.source_version,
        source_note_kind: row.source_note_kind,
        status: row.status,
        pending_live: live(row),
        created_at: row.created_at,
        expires_at: row.expires_at,
        resolved_at: row.resolved_at,
        version: row.version,
        can_accept: canAccept,
        can_decline: canDecline,
        can_withdraw: canWithdraw,
        unavailable_reason: reason,
      });
    }
    return {
      handoffs: display,
      canRequest:
        !!current &&
        visit.status === "in-progress" &&
        !drafts &&
        !pending &&
        sourceNotes.length > 0 &&
        professionals.length > 0,
      canAccept: display.some((h) => h.can_accept),
      canWithdraw: display.some((h) => h.can_withdraw),
      sourceNotes,
      professionals,
    };
  }
  if (method === "POST" && !route[2]) {
    permit(actor, "visits.document");
    const requestId = text(body.client_request_id, "request ID", 100, true);
    const toId = text(body.to_user_id, "receiving professional", 100, true);
    const sourceId = text(body.source_encounter_id, "signed source note", 100, true);
    if (!Number.isInteger(body.version) || body.version < 1)
      fail(400, "Use the current visit version.");
    if (
      Object.keys(body).some(
        (key) =>
          !["version", "client_request_id", "to_user_id", "source_encounter_id"].includes(key),
      )
    )
      fail(400, "Unsupported handoff field.");
    const payload = JSON.stringify({
      version: body.version,
      to_user_id: toId,
      source_encounter_id: sourceId,
    });
    const prior = await tx.get(
      "SELECT * FROM visit_handoffs WHERE visit_id=? AND from_user_id=? AND client_request_id=?",
      [visit.id, actor.id, requestId],
    );
    if (prior) {
      if (prior.request_payload !== payload)
        fail(409, "This request ID was already used for a different handoff.");
      if (!(await authority(actor.id))) fail(403, "Current clinical authority is required.");
      return { id: prior.id, version: visit.version };
    }
    checkVersion();
    if (visit.status !== "in-progress" || visit.assigned_user_id !== actor.id)
      fail(403, "Only the currently assigned professional can hand off an in-progress visit.");
    if (toId === actor.id) fail(400, "Choose another professional.");
    const source = await sourceFor(sourceId, actor.id);
    if (!source || (await hasDraft(actor.id)))
      fail(409, "Sign your linked note and finish outgoing drafts before requesting handoff.");
    const from = await authority(actor.id, source.note_kind),
      to = await authority(toId, source.note_kind);
    if (!from || !from.contributions.includes(source.note_kind) || !to)
      fail(403, "Current roles, branch or patient sharing do not permit this handoff.");
    if (handoffs.some(live)) fail(409, "Resolve the pending handoff before requesting another.");
    await tx.run(
      "UPDATE visit_handoffs SET status='cancelled',pending_key=NULL,resolved_at=?,version=version+1 WHERE visit_id=? AND status='pending' AND expires_at<=?",
      [now(), visit.id, now()],
    );
    for (const expired of handoffs.filter((h) => h.status === "pending" && !live(h)))
      await event("visit.handoff_expired", visit.assigned_user_id);
    const version = await bumpVisit(),
      id = randomUUID();
    const inserted = await tx.get(
      `INSERT INTO visit_handoffs(id,visit_id,organization_id,branch_id,from_user_id,to_user_id,source_encounter_id,source_version,pending_key,requested_visit_version,created_at,expires_at,client_request_id,request_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`,
      [
        id,
        visit.id,
        visit.organization_id,
        visit.branch_id,
        actor.id,
        toId,
        source.id,
        source.version,
        visit.id,
        version,
        now(),
        new Date(Date.now() + 86400000).toISOString(),
        requestId,
        payload,
      ],
    );
    if (!inserted) fail(409, "The handoff changed. Refresh before continuing.");
    await event("visit.handoff_requested", visit.assigned_user_id);
    return { id, version };
  }
  if (method === "POST" && route[2]) {
    const handoff = await tx.get("SELECT * FROM visit_handoffs WHERE id=? AND visit_id=?", [
      route[2],
      visit.id,
    ]);
    if (!handoff) fail(404, "Handoff unavailable.");
    const action = route[3];
    if (action === "accept") permit(actor, "visits.document");
    if (
      (action === "withdraw" && actor.id !== handoff.from_user_id) ||
      (action !== "withdraw" && actor.id !== handoff.to_user_id)
    )
      fail(403, "This handoff action belongs to its sender or recipient.");
    if (Object.keys(body).some((key) => key !== "version"))
      fail(400, "Unsupported handoff action field.");
    if (!Number.isInteger(body.version) || body.version < 1)
      fail(400, "Use the current visit version.");
    if (action === "accept" && handoff.status === "accepted") {
      if (!(await authority(actor.id))) fail(403, "Current clinical authority is required.");
      return { id: handoff.id, version: visit.version };
    }
    checkVersion();
    if (
      handoff.status !== "pending" ||
      visit.status !== "in-progress" ||
      visit.assigned_user_id !== handoff.from_user_id
    )
      fail(409, "This handoff is no longer pending for the current visit.");
    if (action !== "withdraw" && !live(handoff)) fail(409, "This handoff request expired.");
    const source = await sourceFor(handoff.source_encounter_id, handoff.from_user_id);
    if (action === "accept") {
      const actingAuthority = await authority(actor.id, source?.note_kind);
      if (!actingAuthority)
        fail(403, "Current roles, branch or patient sharing do not permit this action.");
      const from = await authority(handoff.from_user_id, source?.note_kind);
      if (
        !source ||
        source.version !== handoff.source_version ||
        (await hasDraft(handoff.from_user_id))
      )
        fail(
          409,
          "The signed source changed or outgoing drafts are unfinished. Request a new handoff.",
        );
      if (!from || !from.contributions.includes(source.note_kind))
        fail(
          403,
          "The outgoing professional no longer has current clinical contribution authority.",
        );
    }
    const assigned = action === "accept" ? handoff.to_user_id : visit.assigned_user_id;
    const version = await bumpVisit(assigned);
    const status =
      action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled";
    const changed = await tx.get(
      "UPDATE visit_handoffs SET status=?,pending_key=NULL,resolved_at=?,version=version+1 WHERE id=? AND status='pending' AND version=? RETURNING id",
      [status, now(), handoff.id, handoff.version],
    );
    if (!changed) fail(409, "This handoff changed. Refresh before continuing.");
    await event(
      `visit.handoff_${action === "withdraw" ? "withdrawn" : action === "accept" ? "accepted" : "declined"}`,
      assigned,
    );
    return { id: handoff.id, version };
  }
  return undefined;
}
