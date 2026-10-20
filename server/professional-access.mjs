import { careAreaAllowsPatient } from "./care-area-access.mjs";
import { randomUUID } from "node:crypto";
import { hasPermission, resolveMembership } from "./roles.mjs";

const now = () => new Date().toISOString();
const categories = ["general", "nursing", "medication", "laboratory", "radiology"];
const union = (arrays) => [...new Set(arrays.flat())];
const scopesOf = (grant) => JSON.parse(grant.scopes_json);
const branchMatches = (member, grant) =>
  (member.branch_id ?? null) === (grant.recipient_branch_id ?? null);
const joined = `SELECT g.*,u.name AS recipient_name,o.name AS facility_name,b.name AS branch_name,
 a.name AS grantor_name FROM professional_grants g JOIN users u ON u.id=g.recipient_user_id
 JOIN organizations o ON o.id=g.recipient_organization_id LEFT JOIN branches b ON b.id=g.recipient_branch_id
 JOIN users a ON a.id=g.grantor_id`;

async function currentProfessional(tx, userId, organizationId) {
  const user = await tx.get(
    "SELECT * FROM users WHERE id=? AND active=1 AND verified=1 AND patient_id IS NULL",
    [userId],
  );
  if (!user) {
    return null;
  }
  const member = await tx.get(
    "SELECT * FROM memberships WHERE user_id=? AND organization_id=? AND active=1",
    [userId, organizationId],
  );
  if (!member) {
    return null;
  }
  if (
    member.branch_id &&
    !(await tx.get("SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1", [
      member.branch_id,
      organizationId,
    ]))
  ) {
    return null;
  }
  user.organization_id = organizationId;
  user.branch_id = member.branch_id ?? null;
  await resolveMembership(tx, member, user);
  if (
    !hasPermission(user, "registry.view") ||
    !hasPermission(user, "records.view") ||
    !user.clinicalScopes.length ||
    user.accessExpired ||
    user.supportAccess
  ) {
    return null;
  }
  return user;
}

async function effectiveGrant(tx, grant) {
  if (grant.revoked_at || grant.expires_at <= now()) {
    return null;
  }
  const recipient = await currentProfessional(
    tx,
    grant.recipient_user_id,
    grant.recipient_organization_id,
  );
  if (
    !recipient ||
    !branchMatches(recipient, grant) ||
    !(await careAreaAllowsPatient(tx, recipient, grant.patient_id))
  ) {
    return null;
  }
  const scopes = scopesOf(grant);
  let contributionScopes = grant.can_contribute
    ? scopes.filter((s) => recipient.clinicalScopes.includes(s))
    : [];
  if (grant.parent_id) {
    const parent = await tx.get("SELECT * FROM professional_grants WHERE id=?", [grant.parent_id]);
    if (
      !parent ||
      parent.parent_id ||
      parent.patient_id !== grant.patient_id ||
      parent.recipient_user_id !== grant.grantor_id ||
      !parent.allow_delegation
    ) {
      return null;
    }
    const authority = await effectiveGrant(tx, parent);
    if (
      !authority ||
      scopes.some((s) => !authority.scopes.includes(s)) ||
      (grant.include_profile && !parent.include_profile) ||
      (grant.can_contribute && !parent.can_contribute) ||
      grant.expires_at > parent.expires_at ||
      (grant.recipient_organization_id !== parent.recipient_organization_id &&
        !parent.allow_external_delegation)
    ) {
      return null;
    }
    contributionScopes = contributionScopes.filter((s) => authority.contributionScopes.includes(s));
  }
  return {
    id: grant.id,
    scopes,
    include_profile: !!grant.include_profile,
    can_contribute: !!grant.can_contribute,
    contributionScopes,
  };
}

export async function resolveProfessionalAccess(tx, actor, patientId) {
  const settings = await tx.get(
    "SELECT restricted FROM patient_access_settings WHERE patient_id=?",
    [patientId],
  );
  const restricted = !!settings?.restricted;
  const rows = actor?.organization_id
    ? await tx.all(
        "SELECT * FROM professional_grants WHERE patient_id=? AND recipient_user_id=? AND recipient_organization_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at,id",
        [patientId, actor.id, actor.organization_id, now()],
      )
    : [];
  const effective = [];
  for (const row of rows) {
    const result = await effectiveGrant(tx, row);
    if (result) {
      effective.push(result);
    }
  }
  return {
    restricted,
    grants: effective.map(({ contributionScopes, ...grant }) => grant),
    scopes: union(effective.map((g) => g.scopes)),
    includeProfile: effective.some((g) => g.include_profile),
    canContribute: effective.some((g) => g.contributionScopes.length > 0),
    canEditProfile: effective.some((g) => g.include_profile && g.contributionScopes.length > 0),
    contributionScopes: union(effective.map((g) => g.contributionScopes)),
    grantId: effective[0]?.id ?? null,
  };
}

export async function listProfessionalPatients(tx, actor) {
  if (
    !actor?.organization_id ||
    !hasPermission(actor, "registry.view") ||
    !hasPermission(actor, "records.view")
  ) {
    return [];
  }
  const rows = await tx.all(
    `SELECT DISTINCT p.id,p.healthpass_id,p.name,p.dob,p.created_at FROM patients p
     JOIN professional_grants g ON g.patient_id=p.id WHERE g.recipient_user_id=? AND g.recipient_organization_id=?
     AND g.revoked_at IS NULL AND g.expires_at>? ORDER BY p.name,p.id LIMIT 100`,
    [actor.id, actor.organization_id, now()],
  );
  const patients = [];
  for (const row of rows) {
    if ((await resolveProfessionalAccess(tx, actor, row.id)).grants.length) {
      patients.push(row);
    }
  }
  return patients;
}

async function displayGrant(tx, row, actor) {
  const effective = await effectiveGrant(tx, row);
  return {
    id: row.id,
    patient_id: row.patient_id,
    recipient_user_id: row.recipient_user_id,
    recipient_organization_id: row.recipient_organization_id,
    recipient_branch_id: row.recipient_branch_id ?? null,
    parent_id: row.parent_id ?? null,
    recipient_name: row.recipient_name,
    facility_name: row.facility_name,
    branch_name: row.branch_name ?? null,
    grantor_name: row.grantor_name,
    grantor_id: row.grantor_id,
    scopes: scopesOf(row),
    include_profile: !!row.include_profile,
    can_contribute: !!row.can_contribute,
    allow_delegation: !!row.allow_delegation,
    allow_external_delegation: !!row.allow_external_delegation,
    purpose: row.purpose,
    expires_at: row.expires_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at ?? null,
    status: row.revoked_at
      ? "revoked"
      : row.expires_at <= now()
        ? "expired"
        : effective
          ? "active"
          : "unavailable",
    effective: !!effective,
    can_revoke:
      actor.patient_id === row.patient_id ||
      (!!row.parent_id && row.grantor_id === actor.id && !!actor.organization_id),
    can_delegate:
      !!effective &&
      !row.parent_id &&
      !!row.allow_delegation &&
      row.recipient_user_id === actor.id &&
      row.recipient_organization_id === actor.organization_id,
  };
}

export async function handleProfessionalAccess(tx, context) {
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
    audit,
    correlation,
  } = context;
  if (path !== "/professional-access" && !path.startsWith("/professional-access/")) {
    return undefined;
  }
  strong(actor);
  const patientOnly = () => {
    if (!actor.patient_id || actor.organization_id) {
      fail(403, "Use your patient account to choose professionals.");
    }
  };
  const patientForQuery = () =>
    actor.patient_id ?? text(searchParams.get("patient_id"), "patient", 100, true);
  const ownedRoot = async (id, patientId = null) => {
    permit(actor, "records.view");
    const grant = await tx.get(
      "SELECT * FROM professional_grants WHERE id=? AND recipient_user_id=? AND recipient_organization_id=?",
      [id, actor.id, actor.organization_id],
    );
    if (
      !grant ||
      grant.parent_id ||
      !grant.allow_delegation ||
      (patientId && grant.patient_id !== patientId) ||
      !(await effectiveGrant(tx, grant))
    ) {
      fail(403, "No active authority to delegate this patient's access.");
    }
    return grant;
  };
  const inputFor = (delegated) => {
    const allowed = new Set([
      "recipient_user_id",
      "recipient_organization_id",
      "scopes",
      "include_profile",
      "can_contribute",
      "purpose",
      "expires_at",
      "client_request_id",
      ...(delegated
        ? []
        : ["allow_delegation", "allow_external_delegation", "acknowledge_restriction"]),
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      fail(400, "Unsupported grant field.");
    }
    if (
      !Array.isArray(body.scopes) ||
      !body.scopes.length ||
      body.scopes.length > 3 ||
      body.scopes.some((s) => !categories.includes(s)) ||
      new Set(body.scopes).size !== body.scopes.length
    ) {
      fail(400, "Choose valid, distinct clinical note categories.");
    }
    for (const key of [
      "include_profile",
      "can_contribute",
      ...(delegated ? [] : ["allow_delegation", "allow_external_delegation"]),
    ]) {
      if (typeof body[key] !== "boolean") {
        fail(400, "Choose each grant permission explicitly.");
      }
    }
    if (!delegated && body.acknowledge_restriction !== true) {
      fail(400, "Confirm that only selected professionals will retain future clinical access.");
    }
    if (!delegated && body.allow_external_delegation && !body.allow_delegation) {
      fail(400, "External delegation requires delegation permission.");
    }
    const expiry = text(body.expires_at, "expiry", 40, true);
    const expiryTime = Date.parse(expiry);
    if (!Number.isFinite(expiryTime)) {
      fail(400, "Choose a valid expiry.");
    }
    return {
      recipient_user_id: text(body.recipient_user_id, "professional", 100, true),
      recipient_organization_id: text(body.recipient_organization_id, "facility", 100, true),
      scopes: [...body.scopes].sort(),
      include_profile: body.include_profile,
      can_contribute: body.can_contribute,
      allow_delegation: delegated ? false : body.allow_delegation,
      allow_external_delegation: delegated ? false : body.allow_external_delegation,
      purpose: text(body.purpose, "purpose", 500, true),
      expires_at: new Date(expiryTime).toISOString(),
      client_request_id: text(body.client_request_id, "request ID", 100, true),
    };
  };
  const create = async (input, patientId, parent) => {
    const payload = JSON.stringify({
      ...input,
      patient_id: patientId,
      parent_id: parent?.id ?? null,
    });
    const existing = await tx.get(
      "SELECT id,request_payload FROM professional_grants WHERE grantor_id=? AND client_request_id=?",
      [actor.id, input.client_request_id],
    );
    if (existing) {
      if (existing.request_payload !== payload) {
        fail(409, "This request ID was already used for a different grant.");
      }
      return { id: existing.id, ...(parent ? {} : { restricted: true }) };
    }
    if (
      Date.parse(input.expires_at) <= Date.now() ||
      Date.parse(input.expires_at) > Date.now() + 90 * 86400000
    ) {
      fail(400, "Choose a future expiry within 90 days.");
    }
    const recipient = await currentProfessional(
      tx,
      input.recipient_user_id,
      input.recipient_organization_id,
    );
    if (!recipient) {
      fail(400, "Choose a currently approved clinical professional in that facility.");
    }
    if (parent) {
      if (
        input.recipient_user_id === actor.id &&
        input.recipient_organization_id === actor.organization_id
      ) {
        fail(400, "Choose another professional to delegate to.");
      }
      if (
        input.scopes.some((s) => !scopesOf(parent).includes(s)) ||
        (input.include_profile && !parent.include_profile) ||
        (input.can_contribute && !parent.can_contribute) ||
        input.expires_at > parent.expires_at ||
        (input.recipient_organization_id !== parent.recipient_organization_id &&
          !parent.allow_external_delegation)
      ) {
        fail(403, "Delegation must remain within the patient's granted scope and expiry.");
      }
    }
    const id = randomUUID();
    const inserted = await tx.get(
      `INSERT INTO professional_grants(id,patient_id,recipient_user_id,recipient_organization_id,recipient_branch_id,grantor_id,parent_id,scopes_json,include_profile,can_contribute,allow_delegation,allow_external_delegation,purpose,expires_at,created_at,client_request_id,request_payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(grantor_id,client_request_id) DO NOTHING RETURNING id`,
      [
        id,
        patientId,
        recipient.id,
        input.recipient_organization_id,
        recipient.branch_id,
        actor.id,
        parent?.id ?? null,
        JSON.stringify(input.scopes),
        Number(input.include_profile),
        Number(input.can_contribute),
        Number(input.allow_delegation),
        Number(input.allow_external_delegation),
        input.purpose,
        input.expires_at,
        now(),
        input.client_request_id,
        payload,
      ],
    );
    if (!inserted) {
      const raced = await tx.get(
        "SELECT id,request_payload FROM professional_grants WHERE grantor_id=? AND client_request_id=?",
        [actor.id, input.client_request_id],
      );
      if (!raced || raced.request_payload !== payload) {
        fail(409, "This request ID was already used for a different grant.");
      }
      return { id: raced.id, ...(parent ? {} : { restricted: true }) };
    }
    if (!parent) {
      await tx.run(
        "INSERT INTO patient_access_settings(patient_id,restricted,updated_at) VALUES (?,1,?) ON CONFLICT(patient_id) DO UPDATE SET restricted=1,updated_at=excluded.updated_at",
        [patientId, now()],
      );
    }
    await audit(
      tx,
      actor,
      parent ? "patient.professional_access_delegated" : "patient.professional_access_granted",
      "allow",
      patientId,
      id,
      correlation,
      null,
      JSON.stringify({
        recipient_user_id: recipient.id,
        recipient_organization_id: recipient.organization_id,
        parent_id: parent?.id ?? null,
        scopes: input.scopes,
        include_profile: input.include_profile,
        can_contribute: input.can_contribute,
        expires_at: input.expires_at,
      }),
    );
    return { id, ...(parent ? {} : { restricted: true }) };
  };

  if (path === "/professional-access" && method === "GET") {
    const patientId = patientForQuery();
    let rows;
    if (actor.patient_id) {
      rows = await tx.all(
        `${joined} WHERE g.patient_id=? ORDER BY g.created_at DESC,g.id LIMIT 100`,
        [patientId],
      );
    } else {
      permit(actor, "records.view");
      rows = await tx.all(
        `${joined} WHERE g.patient_id=? AND ((g.recipient_user_id=? AND g.recipient_organization_id=?) OR (g.grantor_id=? AND g.parent_id IS NOT NULL)) ORDER BY g.created_at DESC,g.id LIMIT 100`,
        [patientId, actor.id, actor.organization_id, actor.id],
      );
      if (!rows.length) {
        fail(403, "No professional sharing relationship for this patient.");
      }
    }
    const settings = await tx.get(
      "SELECT restricted FROM patient_access_settings WHERE patient_id=?",
      [patientId],
    );
    const grants = [];
    for (const row of rows) {
      grants.push(await displayGrant(tx, row, actor));
    }
    return { restricted: !!settings?.restricted, grants };
  }
  if (path === "/professional-access/options" && method === "GET") {
    const patientId = patientForQuery();
    const code = text(searchParams.get("workspace_code"), "workspace code", 80, true).toUpperCase();
    const facility = await tx.get("SELECT id,name FROM organizations WHERE workspace_code=?", [
      code,
    ]);
    if (!facility) {
      fail(404, "Facility unavailable. Check its workspace code.");
    }
    if (!actor.patient_id) {
      permit(actor, "records.view");
      const roots = await tx.all(
        "SELECT * FROM professional_grants WHERE patient_id=? AND recipient_user_id=? AND recipient_organization_id=? AND parent_id IS NULL AND allow_delegation=1 AND revoked_at IS NULL AND expires_at>?",
        [patientId, actor.id, actor.organization_id, now()],
      );
      let eligible = false;
      for (const root of roots) {
        if (
          (facility.id === root.recipient_organization_id || root.allow_external_delegation) &&
          (await effectiveGrant(tx, root))
        ) {
          eligible = true;
        }
      }
      if (!eligible) {
        fail(403, "No active authority to choose delegates at that facility.");
      }
    }
    const search = text(searchParams.get("search") ?? "", "professional name", 160);
    const pattern = "%" + search.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%";
    const members = await tx.all(
      `SELECT u.id,u.name,m.branch_id,b.name AS branch_name FROM users u JOIN memberships m ON m.user_id=u.id
       LEFT JOIN branches b ON b.id=m.branch_id WHERE m.organization_id=? AND m.active=1 AND u.active=1 AND u.verified=1
       AND u.patient_id IS NULL AND LOWER(u.name) LIKE ? ESCAPE '\\' ORDER BY u.name,u.id LIMIT 100`,
      [facility.id, pattern],
    );
    const professionals = [];
    for (const row of members) {
      const current = await currentProfessional(tx, row.id, facility.id);
      if (current && (actor.patient_id || row.id !== actor.id)) {
        professionals.push({ ...row, clinicalScopes: current.clinicalScopes });
      }
      if (professionals.length >= 50) {
        break;
      }
    }
    return { facility, professionals };
  }
  if (path === "/professional-access" && method === "POST") {
    patientOnly();
    return create(inputFor(false), actor.patient_id, null);
  }
  const delegate = path.match(/^\/professional-access\/([^/]+)\/delegate$/);
  if (delegate && method === "POST") {
    const parent = await ownedRoot(delegate[1]);
    return create(inputFor(true), parent.patient_id, parent);
  }
  const revoke = path.match(/^\/professional-access\/([^/]+)\/revoke$/);
  if (revoke && method === "POST") {
    const grant = await tx.get("SELECT * FROM professional_grants WHERE id=?", [revoke[1]]);
    const patientOwns = actor.patient_id && actor.patient_id === grant?.patient_id;
    const delegatedOwns =
      actor.organization_id && grant?.parent_id && grant.grantor_id === actor.id;
    if (!grant || (!patientOwns && !delegatedOwns)) {
      fail(404, "Professional access grant unavailable.");
    }
    const changed = await tx.get(
      "UPDATE professional_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL RETURNING id",
      [now(), grant.id],
    );
    if (changed) {
      await audit(
        tx,
        actor,
        "patient.professional_access_revoked",
        "allow",
        grant.patient_id,
        grant.id,
        correlation,
      );
    }
    return { revoked: true };
  }
  return undefined;
}
