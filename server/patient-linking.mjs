import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "./security.mjs";

const now = () => new Date().toISOString();
const invitationStatus = (row) =>
  row.redeemed_at
    ? "redeemed"
    : row.revoked_at
      ? "revoked"
      : row.expires_at <= now()
        ? "expired"
        : "pending";
const metadata = (row) => ({
  id: row.id,
  facility_name: row.facility_name,
  branch_name: row.branch_name,
  expires_at: row.expires_at,
  created_at: row.created_at,
  redeemed_at: row.redeemed_at ?? null,
  status: invitationStatus(row),
});
const joinedInvitation = `SELECT i.*,o.name AS facility_name,b.name AS branch_name,b.active AS branch_active
  FROM patient_link_invitations i JOIN organizations o ON o.id=i.organization_id
  JOIN branches b ON b.id=i.branch_id`;

/** Registration of an existing self-account; no old-record claims or identity merging. */
export async function handlePatientLinking(tx, context) {
  const {
    actor,
    path,
    method,
    body,
    searchParams,
    permit,
    strong,
    fail,
    text,
    audit,
    correlation,
    limit,
  } = context;
  if (path !== "/patient-link-options" && !path.startsWith("/patient-link-invitations"))
    return undefined;
  strong(actor);
  const patientOnly = () => {
    if (!actor.patient_id || actor.organization_id)
      fail(403, "Use your patient account to manage registration invitations.");
  };
  const unavailable = () =>
    fail(404, "Registration invitation unavailable. Check the code with the patient.");
  const facilityForCode = async (code) => {
    const workspaceCode = text(code, "workspace code", 80, true).toUpperCase();
    const facility = await tx.get(
      "SELECT id,name,workspace_code FROM organizations WHERE workspace_code=?",
      [workspaceCode],
    );
    if (!facility) fail(404, "Facility unavailable. Check its workspace code.");
    return facility;
  };
  const invitationForStaff = async () => {
    permit(actor, "registry.create");
    limit(`patient-link:${actor.id}`, 30);
    const code = text(body.code, "registration code", 100, true).toUpperCase();
    if (!/^HP-LINK-[A-F0-9]{64}$/.test(code)) unavailable();
    const invitation = await tx.get(`${joinedInvitation} WHERE i.code_hash=?`, [hash(code)]);
    if (
      !invitation ||
      invitationStatus(invitation) !== "pending" ||
      !invitation.branch_active ||
      invitation.organization_id !== actor.organization_id ||
      (actor.branch_id && invitation.branch_id !== actor.branch_id)
    )
      unavailable();
    return invitation;
  };
  const reviewFor = async (invitation) => {
    const patient = await tx.get("SELECT id,healthpass_id,name,dob FROM patients WHERE id=?", [
      invitation.patient_id,
    ]);
    if (!patient) unavailable();
    const registered = await tx.get(
      `SELECT p.patient_id FROM patient_links p JOIN branch_patient_links b ON b.patient_id=p.patient_id
       WHERE p.patient_id=? AND p.organization_id=? AND b.branch_id=?`,
      [patient.id, invitation.organization_id, invitation.branch_id],
    );
    // Candidates are bounded and limited to the receiving branch's existing registry.
    // Similar demographics are a warning only, never an instruction to merge.
    const duplicates = await tx.all(
      `SELECT p.id,p.healthpass_id,p.name,p.dob FROM patients p
       JOIN patient_links l ON l.patient_id=p.id JOIN branch_patient_links b ON b.patient_id=p.id
       WHERE l.organization_id=? AND b.branch_id=? AND p.id<>? AND LOWER(p.name)=LOWER(?)
       AND (p.dob=? OR p.dob IS NULL OR CAST(? AS TEXT) IS NULL) ORDER BY p.name,p.id LIMIT 10`,
      [
        invitation.organization_id,
        invitation.branch_id,
        patient.id,
        patient.name,
        patient.dob,
        patient.dob,
      ],
    );
    return {
      invitation_id: invitation.id,
      patient,
      facility: { id: invitation.organization_id, name: invitation.facility_name },
      branch: { id: invitation.branch_id, name: invitation.branch_name },
      already_registered: !!registered,
      possible_duplicates: duplicates,
    };
  };

  if (path === "/patient-link-options" && method === "GET") {
    patientOnly();
    const facility = await facilityForCode(searchParams.get("workspace_code"));
    return {
      facility,
      branches: await tx.all(
        "SELECT id,name FROM branches WHERE organization_id=? AND active=1 ORDER BY name,id",
        [facility.id],
      ),
    };
  }
  if (path === "/patient-link-invitations" && method === "GET") {
    patientOnly();
    const rows = await tx.all(
      `${joinedInvitation} WHERE i.patient_id=? ORDER BY i.created_at DESC LIMIT 30`,
      [actor.patient_id],
    );
    return { invitations: rows.map(metadata) };
  }
  if (path === "/patient-link-invitations" && method === "POST") {
    patientOnly();
    if (body.acknowledge_registration !== true)
      fail(400, "Confirm this registration and its facility care-access explanation.");
    const facility = await facilityForCode(body.workspace_code);
    const branchId = text(body.branch_id, "branch", 100, true);
    const branch = await tx.get(
      "SELECT id,name FROM branches WHERE id=? AND organization_id=? AND active=1",
      [branchId, facility.id],
    );
    if (!branch) fail(400, "Choose an active branch of the selected facility.");
    limit(`patient-link-issue:${actor.id}`, 20);
    const pending = await tx.get(
      "SELECT COUNT(*) AS total FROM patient_link_invitations WHERE patient_id=? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at>?",
      [actor.patient_id, now()],
    );
    if (Number(pending.total) >= 5)
      fail(409, "Revoke an unused invitation before creating another.");
    const id = randomUUID(),
      code = `HP-LINK-${randomBytes(32).toString("hex").toUpperCase()}`;
    const createdAt = now(),
      expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await tx.run(
      `INSERT INTO patient_link_invitations(id,patient_id,grantor_id,organization_id,branch_id,code_hash,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, actor.patient_id, actor.id, facility.id, branch.id, hash(code), createdAt, expiresAt],
    );
    await audit(
      tx,
      actor,
      "patient.registration_invited",
      "allow",
      actor.patient_id,
      id,
      correlation,
      null,
      JSON.stringify({
        organization_id: facility.id,
        branch_id: branch.id,
        expires_at: expiresAt,
        disclosure: "facility-role-care-access-v1",
      }),
    );
    return {
      invitation: metadata({
        id,
        facility_name: facility.name,
        branch_name: branch.name,
        created_at: createdAt,
        expires_at: expiresAt,
      }),
      code,
    };
  }
  const revoke = path.match(/^\/patient-link-invitations\/([^/]+)\/revoke$/);
  if (revoke && method === "POST") {
    patientOnly();
    const invitation = await tx.get(
      "SELECT * FROM patient_link_invitations WHERE id=? AND patient_id=?",
      [revoke[1], actor.patient_id],
    );
    if (!invitation) unavailable();
    if (invitation.redeemed_at)
      fail(409, "This invitation was already used. Revoking it cannot undo a care registration.");
    if (!invitation.revoked_at) {
      const updated = await tx.get(
        "UPDATE patient_link_invitations SET revoked_at=? WHERE id=? AND redeemed_at IS NULL AND revoked_at IS NULL RETURNING id",
        [now(), invitation.id],
      );
      if (!updated) fail(409, "The invitation changed. Refresh before trying again.");
      await audit(
        tx,
        actor,
        "patient.registration_invitation_revoked",
        "allow",
        actor.patient_id,
        invitation.id,
        correlation,
      );
    }
    return { revoked: true };
  }
  if (path === "/patient-link-invitations/review" && method === "POST") {
    const invitation = await invitationForStaff(),
      review = await reviewFor(invitation);
    await audit(
      tx,
      actor,
      "registry.link_reviewed",
      "allow",
      invitation.patient_id,
      invitation.id,
      correlation,
    );
    return review;
  }
  if (path === "/patient-link-invitations/redeem" && method === "POST") {
    const invitation = await invitationForStaff(),
      review = await reviewFor(invitation);
    if (body.identity_confirmed !== true)
      fail(400, "Confirm you checked the patient's identity with them.");
    const reference = text(body.review_reference, "identity review reference", 500, true);
    if (review.possible_duplicates.length && body.duplicate_reviewed !== true)
      fail(
        409,
        "Review the possible existing records. Registration never merges these identities.",
      );
    const redeemed = await tx.get(
      `UPDATE patient_link_invitations SET redeemed_at=?,redeemed_by=?,review_reference=?
       WHERE id=? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING id`,
      [now(), actor.id, reference, invitation.id, now()],
    );
    if (!redeemed) unavailable();
    await tx.run(
      "INSERT INTO patient_links(patient_id,organization_id,created_at) VALUES (?,?,?) ON CONFLICT(patient_id,organization_id) DO NOTHING",
      [invitation.patient_id, invitation.organization_id, now()],
    );
    await tx.run(
      "INSERT INTO branch_patient_links(branch_id,patient_id) VALUES (?,?) ON CONFLICT(branch_id,patient_id) DO NOTHING",
      [invitation.branch_id, invitation.patient_id],
    );
    await audit(
      tx,
      actor,
      "registry.patient_linked",
      "allow",
      invitation.patient_id,
      invitation.id,
      correlation,
      null,
      JSON.stringify({
        branch_id: invitation.branch_id,
        review_reference: reference,
        duplicate_reviewed: body.duplicate_reviewed === true,
        identity_confirmed: true,
      }),
    );
    return {
      id: invitation.patient_id,
      linked: true,
      already_registered: review.already_registered,
    };
  }
  return undefined;
}
