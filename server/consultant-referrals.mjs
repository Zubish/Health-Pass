import { randomUUID } from "node:crypto";
import { hash } from "./security.mjs";
import { hasPermission } from "./roles.mjs";
import { careProfessional, workflowEvent } from "./care-operations.mjs";
import { careAreaAllowsPatient } from "./care-area-access.mjs";
const now = () => new Date().toISOString();
export async function handleConsultantReferrals(tx, c) {
  const { actor, path, method, body, permit, strong, fail, text, careAuthority, searchParams } = c;
  if (!path.startsWith("/consultant-referrals")) return undefined;
  strong(actor);
  const org = actor.organization_id,
    patient = !org && !!actor.patient_id;
  const authority = async (user, id, write = true, scope = "general") => {
    if (!user || !user.clinicalScopes?.includes(scope) || !hasPermission(user, "records.view"))
      fail(403, "Reviewed clinical scope and current record permission are required.");
    const result = await careAuthority(tx, user, id, write);
    if (
      !(write ? result.accessPolicy.contributionScopes : result.accessPolicy.scopes).includes(scope)
    )
      fail(403, "Current patient sharing does not permit this consultation.");
  };
  const outpatient = async (id) => {
    if (
      await tx.get(
        "SELECT id FROM care_admissions WHERE patient_id=? AND organization_id=? AND status='active'",
        [id, org],
      )
    )
      fail(
        409,
        "This patient is under inpatient or observation care. Use their admission care team.",
      );
  };
  const sourceValid = async (row) => {
    const source = await tx.get("SELECT * FROM encounters WHERE id=?", [row.source_encounter_id]);
    if (!source || source.status === "draft" || source.version !== row.source_version)
      fail(
        409,
        "The referral source changed. Withdraw and issue a new referral using the current signed record.",
      );
    return source;
  };
  const recipient = async (row, sourceRead = true) => {
    const user = await careProfessional(tx, row.consultant_id, org, row.branch_id);
    if (
      !user ||
      ["referrals.respond", "notes.create", "notes.sign"].some((p) => !hasPermission(user, p))
    )
      fail(403, "Consultant permissions or reviewed credentials no longer permit this referral.");
    await authority(user, row.patient_id);
    if (row.source_scope && sourceRead) {
      const preview = await careAuthority(tx, user, row.patient_id, false);
      if (!preview.accessPolicy.scopes.includes(row.source_scope))
        fail(403, "The consultant needs patient permission to read the referral source category.");
    }
    return user;
  };
  if (path === "/consultant-referrals/options" && method === "GET") {
    permit(actor, "referrals.create");
    if (!actor.clinicalScopes.length) fail(403, "Referral requires reviewed clinical scope.");
    const patientId = text(searchParams.get("patient_id"), "patient ID", 100, true);
    const accessResult = await careAuthority(tx, actor, patientId, true);
    const allowedScopes = actor.clinicalScopes.filter((s) =>
      accessResult.accessPolicy.contributionScopes.includes(s),
    );
    if (!allowedScopes.length)
      fail(
        403,
        "Current patient sharing does not permit a referral source in your reviewed scope.",
      );
    await outpatient(patientId);
    const sources = await tx.all(
      "SELECT id,version,visit_id,complaint,created_at,note_kind FROM encounters WHERE patient_id=? AND organization_id=? AND author_id=? AND status<>'draft' AND (CAST(? AS TEXT) IS NULL OR branch_id=?) ORDER BY created_at DESC LIMIT 50",
      [patientId, org, actor.id, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    const eligibleSources = sources.filter((s) => allowedScopes.includes(s.note_kind));
    const members = await tx.all(
      "SELECT u.id,u.name,m.branch_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=? AND u.active=1 AND u.verified=1 AND m.active=1 AND u.id<>? AND (CAST(? AS TEXT) IS NULL OR m.branch_id IS NULL OR m.branch_id=?) ORDER BY u.name LIMIT 100",
      [org, actor.id, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    const consultants = [];
    for (const member of members) {
      const user = await careProfessional(tx, member.id, org, actor.branch_id ?? member.branch_id);
      if (
        user?.clinicalScopes.includes("general") &&
        ["referrals.respond", "records.view", "notes.create", "notes.sign"].every((p) =>
          hasPermission(user, p),
        ) &&
        (await careAreaAllowsPatient(tx, user, patientId))
      )
        consultants.push(member);
    }
    return { sources: eligibleSources, consultants };
  }
  if (path === "/consultant-referrals" && method === "GET") {
    if (!patient && !["referrals.create", "referrals.respond"].some((p) => hasPermission(actor, p)))
      fail(403, "Referral inbox is not permitted.");
    const rows = await tx.all(
      `SELECT r.id,r.patient_id,p.name AS patient_name,p.healthpass_id,r.branch_id,b.name AS branch_name,r.from_user_id,s.name AS from_name,r.consultant_id,u.name AS consultant_name,r.kind,r.source_scope,r.status,r.scheduled_at,r.accepted_at,r.decline_reason,r.version,r.source_encounter_id,r.source_version,r.visit_id,r.created_at,r.updated_at FROM consultant_referrals r JOIN patients p ON p.id=r.patient_id JOIN users s ON s.id=r.from_user_id JOIN users u ON u.id=r.consultant_id JOIN branches b ON b.id=r.branch_id WHERE ${patient ? "r.patient_id=?" : "r.organization_id=? AND (r.from_user_id=? OR r.consultant_id=?) AND (CAST(? AS TEXT) IS NULL OR r.branch_id=?)"} ORDER BY r.created_at DESC LIMIT 100`,
      patient
        ? [actor.patient_id]
        : [org, actor.id, actor.id, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    if (!patient)
      for (const row of rows)
        if (row.decline_reason) {
          try {
            const result = await careAuthority(tx, actor, row.patient_id, false);
            if (!result.accessPolicy.scopes.includes("general"))
              throw Object.assign(new Error("Reason sharing unavailable"), { status: 403 });
          } catch (error) {
            if (![403, 404].includes(error.status)) throw error;
            row.decline_reason = null;
            row.reason_hidden = true;
          }
        }
    return { referrals: rows };
  }
  if (path === "/consultant-referrals" && method === "POST") {
    permit(actor, "referrals.create");
    if (!["advice", "transfer"].includes(body.kind))
      fail(400, "Choose specialist advice or transfer of care.");
    const source = await tx.get(
      "SELECT * FROM encounters WHERE id=? AND author_id=? AND organization_id=? AND status<>'draft'",
      [body.source_encounter_id, actor.id, org],
    );
    if (!source || (actor.branch_id && source.branch_id !== actor.branch_id))
      fail(404, "Choose your own signed referral source note in this branch.");
    const visit = source.visit_id
      ? await tx.get("SELECT * FROM care_visits WHERE id=? AND organization_id=?", [
          source.visit_id,
          org,
        ])
      : null;
    if (visit) await tx.run("UPDATE care_visits SET id=id WHERE id=?", [visit.id]);
    await tx.run("UPDATE patients SET id=id WHERE id=?", [source.patient_id]);
    await outpatient(source.patient_id);
    await authority(actor, source.patient_id, true, source.note_kind);
    const row = {
      id: randomUUID(),
      organization_id: org,
      patient_id: source.patient_id,
      branch_id: source.branch_id,
      consultant_id: text(body.consultant_id, "consultant ID", 100, true),
      source_encounter_id: source.id,
      source_version: source.version,
      source_scope: source.note_kind,
    };
    if (row.consultant_id === actor.id) fail(400, "Choose another professional for this referral.");
    await recipient(row);
    if (body.kind === "transfer") {
      const current = visit && (await tx.get("SELECT * FROM care_visits WHERE id=?", [visit.id]));
      if (!current || current.status !== "in-progress" || current.assigned_user_id !== actor.id)
        fail(409, "Transfer requires your current in-progress outpatient visit.");
      if (
        await tx.get(
          "SELECT id FROM visit_handoffs WHERE visit_id=? AND status='pending' AND pending_key=?",
          [current.id, current.id],
        )
      )
        fail(409, "Resolve the existing visit handoff before referring a transfer.");
      if (
        await tx.get(
          "SELECT id FROM encounters WHERE visit_id=? AND author_id=? AND status='draft'",
          [current.id, actor.id],
        )
      )
        fail(409, "Finish your visit drafts before requesting a transfer.");
    }
    const request = hash(
      org + ":" + actor.id + ":" + text(body.client_request_id, "request ID", 100, true),
    );
    const payload = JSON.stringify({
      source: source.id,
      version: source.version,
      consultant: row.consultant_id,
      kind: body.kind,
    });
    const previous = await tx.get(
      "SELECT id,version,request_payload FROM consultant_referrals WHERE request_key=?",
      [request],
    );
    if (previous) {
      if (previous.request_payload !== payload)
        fail(409, "This request ID belongs to another referral.");
      return { id: previous.id, version: previous.version, replayed: true };
    }
    if (
      body.kind === "transfer" &&
      (await tx.get(
        "SELECT id FROM consultant_referrals WHERE visit_id=? AND kind='transfer' AND status IN ('pending','scheduled')",
        [source.visit_id],
      ))
    )
      fail(409, "Resolve or withdraw the current consultant transfer before requesting another.");
    const pending = org + ":" + source.patient_id + ":" + row.consultant_id + ":" + body.kind;
    if (await tx.get("SELECT id FROM consultant_referrals WHERE pending_key=?", [pending]))
      fail(409, "An open referral of this type already exists for this consultant and patient.");
    await tx.run(
      "INSERT INTO consultant_referrals(id,patient_id,organization_id,branch_id,from_user_id,consultant_id,source_encounter_id,source_version,source_scope,visit_id,kind,pending_key,created_at,updated_at,request_key,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        row.id,
        row.patient_id,
        org,
        row.branch_id,
        actor.id,
        row.consultant_id,
        source.id,
        source.version,
        source.note_kind,
        source.visit_id ?? null,
        body.kind,
        pending,
        now(),
        now(),
        request,
        payload,
      ],
    );
    await workflowEvent(tx, c, row, "referral.requested", {
      kind: body.kind,
      consultant_id: row.consultant_id,
      source_encounter_id: source.id,
      source_version: source.version,
    });
    return { id: row.id, version: 1 };
  }
  const match = path.match(
    /^\/consultant-referrals\/([^/]+)\/(source|accept|decline|withdraw|start|complete|cancel|reschedule)$/,
  );
  if (match) {
    let row = await tx.get("SELECT * FROM consultant_referrals WHERE id=? AND organization_id=?", [
      match[1],
      org,
    ]);
    if (
      !row ||
      (actor.id !== row.from_user_id && actor.id !== row.consultant_id) ||
      (actor.branch_id && actor.branch_id !== row.branch_id)
    )
      fail(404, "Referral unavailable in your account and branch.");
    const action = match[2];
    if (action === "source" && method === "GET") {
      permit(actor, actor.id === row.from_user_id ? "referrals.create" : "referrals.respond");
      await authority(
        actor,
        row.patient_id,
        false,
        actor.id === row.from_user_id ? row.source_scope : "general",
      );
      const previewAccess = await careAuthority(tx, actor, row.patient_id, false);
      if (!previewAccess.accessPolicy.scopes.includes(row.source_scope))
        fail(403, "The patient has not shared this referral source category.");
      const version = await tx.get(
        "SELECT payload,version,signed_at AS created_at FROM note_versions WHERE encounter_id=? AND version=?",
        [row.source_encounter_id, row.source_version],
      );
      if (!version) fail(404, "Signed referral source unavailable.");
      await workflowEvent(tx, c, row, "referral.source_read", {});
      return {
        source: JSON.parse(version.payload),
        version: version.version,
        created_at: version.created_at,
      };
    }
    if (method !== "POST") fail(404, "Referral action unavailable.");
    permit(actor, action === "withdraw" ? "referrals.create" : "referrals.respond");
    if (
      (action === "withdraw" && actor.id !== row.from_user_id) ||
      (action !== "withdraw" && actor.id !== row.consultant_id)
    )
      fail(403, "Only the responsible sender or consultant may perform this action.");
    if (row.visit_id) await tx.run("UPDATE care_visits SET id=id WHERE id=?", [row.visit_id]);
    await tx.run("UPDATE patients SET id=id WHERE id=?", [row.patient_id]);
    row = await tx.get("SELECT * FROM consultant_referrals WHERE id=?", [row.id]);
    if (row.version !== body.version) fail(409, "Referral changed. Refresh before deciding.");
    if (["decline", "accept"].includes(action) && row.status !== "pending")
      fail(409, "This referral is no longer pending.");
    if (action === "withdraw" && !["pending", "scheduled"].includes(row.status))
      fail(409, "Only pending or scheduled referrals can be withdrawn.");
    if (["cancel", "reschedule"].includes(action) && row.status !== "scheduled")
      fail(409, "Only scheduled referrals can be cancelled or rescheduled.");
    if (action === "start" && row.status !== "scheduled")
      fail(409, "This referral is not scheduled.");
    if (action === "complete" && !["accepted"].includes(row.status))
      fail(409, "Start the consultation before completing it.");
    let status,
      acceptedAt = null,
      scheduled = null,
      reason = null,
      responseNote = null;
    if (action === "decline") {
      reason = text(body.reason, "decline reason", 1000, true);
      status = "declined";
    } else if (action === "withdraw" || action === "cancel") {
      reason = text(body.reason, "withdrawal reason", 500, true);
      status = "cancelled";
    } else {
      await outpatient(row.patient_id);
      await authority(actor, row.patient_id);
      await recipient(row, action !== "complete");
      if (action !== "complete") await sourceValid(row);
      if ((action === "accept" && body.decision === "schedule") || action === "reschedule") {
        const time = Date.parse(body.scheduled_at);
        if (!Number.isFinite(time) || time <= Date.now())
          fail(400, "Choose a future consultation date and time.");
        scheduled = new Date(time).toISOString();
        status = "scheduled";
      } else {
        if (action === "accept" && body.decision !== "now")
          fail(400, "Choose Accept now or Schedule.");
        if (action === "start" && Date.parse(row.scheduled_at) > Date.now())
          fail(409, "The scheduled consultation time has not arrived.");
        status = action === "complete" ? "completed" : "accepted";
        if (status === "accepted") acceptedAt = now();
        if (row.kind === "transfer" && action !== "complete") {
          const visit = await tx.get("SELECT * FROM care_visits WHERE id=? AND organization_id=?", [
            row.visit_id,
            org,
          ]);
          if (
            !visit ||
            visit.status !== "in-progress" ||
            visit.assigned_user_id !== row.from_user_id
          )
            fail(409, "The GP’s visit responsibility changed. A new transfer referral is needed.");
          if (
            (await tx.get(
              "SELECT id FROM visit_handoffs WHERE visit_id=? AND pending_key=? AND status='pending'",
              [visit.id, visit.id],
            )) ||
            (await tx.get(
              "SELECT id FROM encounters WHERE visit_id=? AND author_id=? AND status='draft'",
              [visit.id, row.from_user_id],
            ))
          )
            fail(409, "Resolve pending handoffs and outgoing drafts before transfer.");
          if (!hasPermission(actor, "visits.document"))
            fail(403, "Transfer requires visit documentation permission.");
          const sender = await careProfessional(tx, row.from_user_id, org, row.branch_id);
          await authority(sender, row.patient_id, true, row.source_scope);
          await tx.run(
            "UPDATE care_visits SET assigned_user_id=?,version=version+1,updated_at=? WHERE id=?",
            [actor.id, now(), visit.id],
          );
          await tx.run(
            "INSERT INTO visit_events(id,visit_id,actor_id,action,from_status,to_status,assigned_user_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
            [
              randomUUID(),
              visit.id,
              actor.id,
              "visit.consultant_transfer",
              visit.status,
              visit.status,
              actor.id,
              now(),
            ],
          );
        }
        if (action === "complete") {
          const note = await tx.get(
            "SELECT id,visit_id FROM encounters WHERE id=? AND patient_id=? AND author_id=? AND organization_id=? AND branch_id=? AND note_kind='general' AND status<>'draft' AND created_at>=? AND EXISTS(SELECT 1 FROM note_versions nv WHERE nv.encounter_id=encounters.id AND nv.author_id=? AND nv.signed_at>=?)",
            [
              body.response_encounter_id,
              row.patient_id,
              actor.id,
              org,
              row.branch_id,
              row.created_at,
              actor.id,
              row.accepted_at ?? row.created_at,
            ],
          );
          if (!note || (row.kind === "transfer" && note.visit_id !== row.visit_id))
            fail(400, "Choose your own signed consultation note for this referral.");
          responseNote = note.id;
          if (row.kind === "transfer") {
            permit(actor, "visits.document");
            const visit = await tx.get(
              "SELECT * FROM care_visits WHERE id=? AND organization_id=?",
              [row.visit_id, org],
            );
            if (
              !visit ||
              visit.assigned_user_id !== actor.id ||
              !["in-progress", "completed"].includes(visit.status)
            )
              fail(409, "The transferred visit is no longer yours to complete.");
            if (visit.assigned_user_id === actor.id && visit.status === "in-progress") {
              if (
                await tx.get(
                  "SELECT id FROM visit_handoffs WHERE visit_id=? AND status='pending'",
                  [visit.id],
                )
              )
                fail(409, "Resolve the pending handoff before completing this consultation.");
              await tx.run(
                "UPDATE care_visits SET status='completed',active_key=NULL,version=version+1,completed_at=?,updated_at=? WHERE id=?",
                [now(), now(), visit.id],
              );
              await tx.run(
                "INSERT INTO visit_events(id,visit_id,actor_id,action,from_status,to_status,assigned_user_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
                [
                  randomUUID(),
                  visit.id,
                  actor.id,
                  "visit.consultant_completed",
                  "in-progress",
                  "completed",
                  actor.id,
                  now(),
                ],
              );
            }
          }
        }
      }
    }
    await tx.run(
      "UPDATE consultant_referrals SET status=?,scheduled_at=COALESCE(?,scheduled_at),accepted_at=COALESCE(?,accepted_at),decline_reason=?,response_encounter_id=COALESCE(?,response_encounter_id),pending_key=CASE WHEN ? IN ('declined','cancelled','completed') THEN NULL ELSE pending_key END,version=version+1,updated_at=? WHERE id=?",
      [status, scheduled, acceptedAt, reason, responseNote, status, now(), row.id],
    );
    await workflowEvent(tx, c, row, "referral." + status, {
      kind: row.kind,
      scheduled_at: scheduled ?? row.scheduled_at,
      reason,
      response_encounter_id: responseNote,
    });
    return { updated: true, version: row.version + 1, status };
  }
  fail(404, "Referral action unavailable.");
}
