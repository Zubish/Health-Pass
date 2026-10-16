import { randomUUID, randomBytes } from "node:crypto";
import { hash, passwordHash, protectSecret } from "./security.mjs";
import { emailReady } from "./patient-email.mjs";
const now = () => new Date().toISOString();
const expires = (days) => new Date(Date.now() + days * 86400000).toISOString();
const requestState = (row) =>
  row.status === "pending" && row.expires_at <= now() ? "expired" : row.status;
const requestMeta = (row) => ({
  id: row.id,
  facility_name: row.facility_name,
  branch_name: row.branch_name,
  purpose: row.purpose,
  status: requestState(row),
  created_at: row.created_at,
  expires_at: row.expires_at,
  ...(row.patient_name ? { patient_name: row.patient_name } : {}),
});
export async function patientForEmail(tx, email) {
  return (
    (await tx.get("SELECT patient_id,claimed_by FROM patient_addresses WHERE email=?", [email])) ??
    (await tx.get(
      "SELECT patient_id,id AS claimed_by FROM users WHERE LOWER(COALESCE(login_email,email))=? AND account_scope='patient'",
      [email],
    ))
  );
}
export async function handlePatientOnboarding(tx, context) {
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
    emailValue,
    patientInput,
    audit,
    correlation,
    limit,
    config,
    makeSession,
    cookie,
    outputHeaders,
  } = context;
  const publicClaim = path === "/auth/patient-claim";
  const relevant =
    publicClaim ||
    (path === "/patients" && method === "POST") ||
    path === "/patient-registration-options" ||
    path.startsWith("/patient-activation") ||
    path.startsWith("/facility-access-requests") ||
    path.startsWith("/primary-care");
  if (!relevant) {
    return undefined;
  }
  const patientOnly = () => {
    strong(actor);
    if (!actor.patient_id || actor.organization_id) {
      fail(403, "Use your patient account for this action.");
    }
  };
  const staffOnly = () => {
    permit(actor, "registry.create");
    if (actor.supportAccess) {
      fail(403, "Support access does not include patient registration.");
    }
  };
  const branchFor = async () => {
    if (actor.branch_id && body.branch_id && body.branch_id !== actor.branch_id) {
      fail(403, "Choose your current workspace branch.");
    }
    const available =
      !actor.branch_id && !body.branch_id
        ? await tx.all(
            "SELECT id FROM branches WHERE organization_id=? AND active=1 ORDER BY id LIMIT 2",
            [actor.organization_id],
          )
        : [];
    const id =
      actor.branch_id ?? body.branch_id ?? (available.length === 1 ? available[0].id : null);
    if (!id) {
      fail(400, "Choose the branch where this patient receives care.");
    }
    const branch = await tx.get(
      "SELECT id,name FROM branches WHERE id=? AND organization_id=? AND active=1",
      [id, actor.organization_id],
    );
    if (!branch) {
      fail(400, "Choose an active branch of your facility.");
    }
    return branch;
  };
  const requestView = (row) => requestMeta(row);
  const invite = async (patientId, email, facility) => {
    // Single current invitation per profile; old links remain stored but unusable.
    await tx.run(
      "UPDATE patient_claims SET revoked_at=? WHERE patient_id=? AND consumed_at IS NULL AND revoked_at IS NULL",
      [now(), patientId],
    );
    const token = randomBytes(32).toString("hex");
    const id = randomUUID();
    const created = now();
    await tx.run(
      "INSERT INTO patient_claims(id,patient_id,email,token_hash,created_at,expires_at) VALUES (?,?,?,?,?,?)",
      [id, patientId, email, hash(token), created, expires(1)],
    );
    const url = `${config.PUBLIC_APP_ORIGIN || "http://localhost:3000"}/workspace?claim=${id}#claim-token=${token}`;
    await tx.run(
      "INSERT INTO patient_email_outbox(id,encrypted_payload,created_at) VALUES (?,?,?)",
      [
        id,
        protectSecret(JSON.stringify({ email, facility, url }), config.HEALTHPASS_AUTH_KEY),
        created,
      ],
    );
    return emailReady(config) ? "queued" : "awaiting_email_configuration";
  };
  if (publicClaim) {
    limit("patient-claim", 40);
    if (method !== "POST") {
      fail(405, "Use the activation form to verify this invitation.");
    }
    const token = text(body.token, "invitation", 64, true);
    const claim = await tx.get(
      "SELECT * FROM patient_claims WHERE token_hash=? AND id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?",
      [hash(token), text(body.claim_id, "invitation", 100, true), now()],
    );
    if (!claim || !/^[a-f0-9]{64}$/.test(token)) {
      fail(
        400,
        "This invitation is invalid, expired or already used. Ask the registering facility for a new invitation.",
      );
    }
    const address = await tx.get("SELECT * FROM patient_addresses WHERE email=? AND patient_id=?", [
      claim.email,
      claim.patient_id,
    ]);
    if (!address || address.claimed_by) {
      fail(409, "This profile already has an account. Sign in instead.");
    }
    const profile = await tx.get(
      `SELECT p.name,o.name AS facility_name,r.organization_id FROM patients p JOIN patient_origins r ON r.patient_id=p.id JOIN organizations o ON o.id=r.organization_id WHERE p.id=?`,
      [claim.patient_id],
    );
    if (!profile) {
      fail(400, "Invitation unavailable.");
    }
    if (body.review === true) {
      return {
        name: profile.name,
        email: claim.email,
        facility_name: profile.facility_name,
        expires_at: claim.expires_at,
      };
    }
    const password = text(body.password, "password", 256, true);
    if (password.length < 12) {
      fail(400, "Use a password of at least 12 characters.");
    }
    if (body.confirm_registration !== true) {
      fail(400, "Confirm you recognise this care registration.");
    }
    const claimed = await tx.get(
      "UPDATE patient_claims SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>? RETURNING id",
      [now(), claim.id, now()],
    );
    if (!claimed) {
      fail(409, "This invitation changed. Reopen the invitation.");
    }
    const userId = randomUUID();
    const reserved = await tx.get(
      "UPDATE patient_addresses SET verified_at=? WHERE email=? AND patient_id=? AND claimed_by IS NULL RETURNING email",
      [now(), claim.email, claim.patient_id],
    );
    if (!reserved) {
      fail(409, "This profile already has an account. Sign in instead.");
    }
    await tx.run(
      "INSERT INTO users(id,email,login_email,name,password_hash,patient_id,verified) VALUES (?,?,?,?,?,?,1)",
      [userId, claim.email, claim.email, profile.name, passwordHash(password), claim.patient_id],
    );
    await tx.run("UPDATE patient_addresses SET claimed_by=? WHERE email=?", [userId, claim.email]);
    if (body.keep_primary === true) {
      await tx.run(
        "INSERT INTO primary_care(patient_id,organization_id,source,changed_at) VALUES (?,?,'first_registration',?) ON CONFLICT(patient_id) DO NOTHING",
        [claim.patient_id, profile.organization_id, now()],
      );
    }
    await tx.run(
      "UPDATE patient_claims SET revoked_at=? WHERE patient_id=? AND id<>? AND consumed_at IS NULL AND revoked_at IS NULL",
      [now(), claim.patient_id, claim.id],
    );
    const user = await tx.get("SELECT * FROM users WHERE id=?", [userId]);
    outputHeaders.set("set-cookie", cookie(await makeSession(tx, user)));
    await audit(
      tx,
      user,
      "patient.account_claimed",
      "allow",
      claim.patient_id,
      claim.id,
      correlation,
      null,
      JSON.stringify({ primary_confirmed: body.keep_primary === true }),
    );
    return { registered: true };
  }
  strong(actor);
  if (path === "/patient-registration-options" && method === "GET") {
    staffOnly();
    return {
      branches: await tx.all(
        "SELECT id,name FROM branches WHERE organization_id=? AND active=1 AND (CAST(? AS TEXT) IS NULL OR id=?) ORDER BY name,id",
        [actor.organization_id, actor.branch_id ?? null, actor.branch_id ?? null],
      ),
    };
  }
  if (path === "/patients" && method === "POST") {
    staffOnly();
    limit(`patient-register:${actor.id}`, 30);
    const data = patientInput(body);
    const branch = await branchFor();
    const email = body.email ? emailValue(body.email) : null;
    const requestKey = body.client_request_id
      ? hash(actor.id + ":" + text(body.client_request_id, "request identifier", 100, true))
      : null;
    const payloadHash = hash(JSON.stringify({ data, branch_id: branch.id, email }));
    if (requestKey) {
      await tx.run("UPDATE users SET name=name WHERE id=?", [actor.id]);
    }
    if (requestKey) {
      const previous = await tx.get(
        "SELECT patient_id,request_payload_hash FROM patient_origins WHERE request_key=?",
        [requestKey],
      );
      if (previous) {
        if (previous.request_payload_hash !== payloadHash) {
          fail(409, "Registration details changed. Use a new request identifier.");
        }
        const address = await tx.get(
          "SELECT claimed_by FROM patient_addresses WHERE patient_id=?",
          [previous.patient_id],
        );
        return {
          id: previous.patient_id,
          activation: address?.claimed_by
            ? "claimed"
            : email
              ? emailReady(config)
                ? "queued"
                : "awaiting_email_configuration"
              : "no_email",
          replayed: true,
        };
      }
    }
    if (email && body.identity_confirmed !== true) {
      fail(400, "Confirm you checked the patient identity and their own email.");
    }
    if (email && (await patientForEmail(tx, email))) {
      return {
        existing_account: true,
        message:
          "An account or registration already uses this email. Ask the patient to share their profile, or request access. No new profile was created.",
      };
    }
    const id = randomUUID();
    const created = now();
    await tx.run(
      "INSERT INTO patients(id,healthpass_id,name,dob,phone,created_at) VALUES (?,?,?,?,?,?)",
      [
        id,
        `HP-${randomBytes(6).toString("hex").toUpperCase()}`,
        data.name,
        data.dob,
        data.phone,
        created,
      ],
    );
    if (email) {
      const reserved = await tx.get(
        "INSERT INTO patient_addresses(email,patient_id,created_at) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING RETURNING email",
        [email, id, created],
      );
      if (!reserved) {
        fail(409, "An account or registration already uses this email. Request access instead.");
      }
    }
    await tx.run(
      "INSERT INTO patient_origins(patient_id,organization_id,branch_id,registered_by,created_at,request_key,request_payload_hash) VALUES (?,?,?,?,?,?,?)",
      [id, actor.organization_id, branch.id, actor.id, created, requestKey, payloadHash],
    );
    await tx.run(
      "INSERT INTO patient_links(patient_id,organization_id,created_at) VALUES (?,?,?)",
      [id, actor.organization_id, created],
    );
    await tx.run("INSERT INTO branch_patient_links(branch_id,patient_id) VALUES (?,?)", [
      branch.id,
      id,
    ]);
    const facility = await tx.get("SELECT name FROM organizations WHERE id=?", [
      actor.organization_id,
    ]);
    const delivery = email ? await invite(id, email, facility.name) : "no_email";
    await audit(tx, actor, "registry.register", "allow", id, id, correlation);
    return { id, activation: delivery };
  }
  if (path === "/patient-activation" && method === "GET") {
    staffOnly();
    const patientId = text(searchParams.get("patient_id"), "patient", 100, true);
    const origin = await tx.get(
      "SELECT * FROM patient_origins WHERE patient_id=? AND organization_id=?",
      [patientId, actor.organization_id],
    );
    if (!origin || (actor.branch_id && actor.branch_id !== origin.branch_id)) {
      fail(404, "This facility cannot activate that profile.");
    }
    const address = await tx.get("SELECT * FROM patient_addresses WHERE patient_id=?", [patientId]);
    const latest = await tx.get(
      "SELECT c.*,o.sent_at,o.last_error FROM patient_claims c LEFT JOIN patient_email_outbox o ON o.id=c.id WHERE c.patient_id=? ORDER BY c.created_at DESC,c.id DESC LIMIT 1",
      [patientId],
    );
    return {
      email: address?.email ?? null,
      claimed: !!address?.claimed_by,
      delivery: address?.claimed_by
        ? "claimed"
        : latest && (latest.revoked_at || latest.expires_at <= now())
          ? "expired"
          : latest?.sent_at
            ? "sent"
            : latest && !emailReady(config)
              ? "awaiting_email_configuration"
              : latest?.last_error
                ? "retry_pending"
                : latest
                  ? "queued"
                  : "no_email",
      expires_at: latest?.expires_at ?? null,
    };
  }
  if (path === "/patient-activation" && method === "POST") {
    staffOnly();
    limit(`patient-invite:${actor.id}`, 15);
    const patientId = text(body.patient_id, "patient", 100, true);
    // Serialize resend/attach/claim races through the profile row.
    await tx.run("UPDATE patients SET name=name WHERE id=?", [patientId]);
    const origin = await tx.get(
      "SELECT * FROM patient_origins WHERE patient_id=? AND organization_id=?",
      [patientId, actor.organization_id],
    );
    if (!origin || (actor.branch_id && actor.branch_id !== origin.branch_id)) {
      fail(404, "This facility cannot activate that profile.");
    }
    if (body.identity_confirmed !== true) {
      fail(400, "Confirm the patient supplied their own email and you checked their identity.");
    }
    const reference = text(body.review_reference, "identity review reference", 500, true);
    const email = emailValue(body.email);
    const current = await tx.get("SELECT * FROM patient_addresses WHERE patient_id=?", [patientId]);
    if (current?.claimed_by) {
      fail(409, "This patient already has an account. Ask them to sign in.");
    }
    if (current && current.email !== email) {
      fail(
        409,
        "Email changes need a separate identity correction review. Use the recorded email for this invitation.",
      );
    }
    const other = await patientForEmail(tx, email);
    if (other && other.patient_id !== patientId) {
      fail(
        409,
        "An account or registration already uses this email. Request access instead; do not merge these profiles.",
      );
    }
    await tx.run(
      "INSERT INTO patient_addresses(email,patient_id,created_at) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING",
      [email, patientId, now()],
    );
    const reserved = await tx.get("SELECT patient_id FROM patient_addresses WHERE email=?", [
      email,
    ]);
    if (reserved?.patient_id !== patientId) {
      fail(409, "This email was registered elsewhere. Request access instead.");
    }
    const facility = await tx.get("SELECT name FROM organizations WHERE id=?", [
      actor.organization_id,
    ]);
    const activation = await invite(patientId, email, facility.name);
    await audit(
      tx,
      actor,
      "patient.activation_invited",
      "allow",
      patientId,
      patientId,
      correlation,
      null,
      JSON.stringify({ review_reference: reference }),
    );
    return { activation };
  }
  const accessJoined = `SELECT r.*,o.name AS facility_name,b.name AS branch_name FROM facility_access_requests r JOIN organizations o ON o.id=r.organization_id JOIN branches b ON b.id=r.branch_id`;
  if (path === "/facility-access-requests" && method === "GET") {
    if (actor.patient_id) {
      patientOnly();
      return {
        requests: (
          await tx.all(`${accessJoined} WHERE r.patient_id=? ORDER BY r.created_at DESC LIMIT 50`, [
            actor.patient_id,
          ])
        ).map(requestView),
      };
    }
    staffOnly();
    const rows = await tx.all(
      `${accessJoined} WHERE r.organization_id=? AND (CAST(? AS TEXT) IS NULL OR r.branch_id=?) ORDER BY r.created_at DESC LIMIT 50`,
      [actor.organization_id, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    // No patient's existing demographics or email disclosed before approval.
    return { requests: rows.map(requestView) };
  }
  if (path === "/facility-access-requests" && method === "POST") {
    staffOnly();
    limit(`facility-request:${actor.id}`, 20);
    const email = emailValue(body.email);
    const branch = await branchFor();
    const purpose = text(body.purpose, "purpose", 500, true);
    const reference = text(body.review_reference, "identity review reference", 500, true);
    if (body.identity_confirmed !== true) {
      fail(400, "Confirm the patient supplied this email and requested care at your facility.");
    }
    const target = await patientForEmail(tx, email);
    if (!target) {
      return {
        requested: true,
        message:
          "If a patient profile uses this email, its account will receive the request. Ask the patient to sign in and check requests.",
      };
    }
    const pendingKey = `${target.patient_id}:${actor.organization_id}:${branch.id}`;
    await tx.run(
      "UPDATE facility_access_requests SET status='withdrawn',pending_key=NULL,resolved_at=? WHERE pending_key=? AND expires_at<=?",
      [now(), pendingKey, now()],
    );
    const id = randomUUID();
    const added = await tx.get(
      "INSERT INTO facility_access_requests(id,patient_id,organization_id,branch_id,requested_by,purpose,pending_key,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(pending_key) DO NOTHING RETURNING id",
      [
        id,
        target.patient_id,
        actor.organization_id,
        branch.id,
        actor.id,
        purpose,
        pendingKey,
        now(),
        expires(14),
      ],
    );
    if (added) {
      await audit(
        tx,
        actor,
        "patient.facility_access_requested",
        "allow",
        null,
        id,
        correlation,
        null,
        JSON.stringify({ review_reference: reference }),
      );
    }
    return {
      requested: true,
      message:
        "If a patient profile uses this email, its account will receive the request. Ask the patient to sign in and check requests.",
    };
  }
  const accessAction = path.match(
    /^\/facility-access-requests\/([^/]+)\/(accept|decline|withdraw)$/,
  );
  if (accessAction && method === "POST") {
    const [, id, action] = accessAction;
    const row = await tx.get("SELECT * FROM facility_access_requests WHERE id=?", [id]);
    if (!row) {
      fail(404, "Request unavailable.");
    }
    if (action === "withdraw") {
      staffOnly();
      if (
        row.organization_id !== actor.organization_id ||
        (actor.branch_id && row.branch_id !== actor.branch_id)
      ) {
        fail(404, "Request unavailable.");
      }
    } else {
      patientOnly();
      if (row.patient_id !== actor.patient_id) {
        fail(404, "Request unavailable.");
      }
    }
    if (requestState(row) !== "pending") {
      fail(409, "This request is no longer pending. Refresh requests.");
    }
    if (action === "accept" && body.acknowledge_registration !== true) {
      fail(400, "Confirm facility registration and its local care-access explanation.");
    }
    if (
      !(await tx.get("SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1", [
        row.branch_id,
        row.organization_id,
      ]))
    ) {
      fail(409, "This branch is no longer active.");
    }
    const status = { accept: "accepted", decline: "declined", withdraw: "withdrawn" }[action];
    const changed = await tx.get(
      "UPDATE facility_access_requests SET status=?,pending_key=NULL,resolved_at=? WHERE id=? AND status='pending' AND expires_at>? RETURNING id",
      [status, now(), id, now()],
    );
    if (!changed) {
      fail(409, "The request changed. Refresh requests.");
    }
    if (action === "accept") {
      await tx.run(
        "INSERT INTO patient_links(patient_id,organization_id,created_at) VALUES (?,?,?) ON CONFLICT(patient_id,organization_id) DO NOTHING",
        [row.patient_id, row.organization_id, now()],
      );
      await tx.run(
        "INSERT INTO branch_patient_links(branch_id,patient_id) VALUES (?,?) ON CONFLICT(branch_id,patient_id) DO NOTHING",
        [row.branch_id, row.patient_id],
      );
      await tx.run(
        "INSERT INTO patient_relationship_preferences(patient_id,organization_id,branch_id,include_profile,changed_at) VALUES (?,?,?,?,?) ON CONFLICT(patient_id,organization_id,branch_id) DO UPDATE SET include_profile=excluded.include_profile,changed_at=excluded.changed_at",
        [
          row.patient_id,
          row.organization_id,
          row.branch_id,
          body.share_profile === true ? 1 : 0,
          now(),
        ],
      );
    }
    await audit(
      tx,
      actor,
      `patient.facility_access_${status}`,
      "allow",
      action === "withdraw" ? null : row.patient_id,
      id,
      correlation,
    );
    return { status };
  }
  const primaryJoined = `SELECT r.*,o.name AS facility_name FROM primary_care_requests r JOIN organizations o ON o.id=r.organization_id`;
  if (path === "/primary-care" && method === "GET") {
    patientOnly();
    const primary = await tx.get(
      "SELECT c.organization_id,c.source,c.changed_at,o.name AS facility_name FROM primary_care c JOIN organizations o ON o.id=c.organization_id WHERE c.patient_id=?",
      [actor.patient_id],
    );
    const origin = await tx.get(
      "SELECT r.organization_id,o.name AS facility_name FROM patient_origins r JOIN organizations o ON o.id=r.organization_id WHERE r.patient_id=?",
      [actor.patient_id],
    );
    return {
      primary: primary ?? null,
      first_registration: origin ?? null,
      requests: (
        await tx.all(`${primaryJoined} WHERE r.patient_id=? ORDER BY r.created_at DESC LIMIT 30`, [
          actor.patient_id,
        ])
      ).map(requestView),
    };
  }
  if (path === "/primary-care" && method === "POST") {
    patientOnly();
    limit(`primary-request:${actor.id}`, 20);
    // A single per-patient lock serializes replacements, clearing and accepting competing requests.
    await tx.run("UPDATE patients SET name=name WHERE id=?", [actor.patient_id]);
    const facility = await tx.get("SELECT id,name FROM organizations WHERE workspace_code=?", [
      text(body.workspace_code, "workspace code", 80, true).toUpperCase(),
    ]);
    if (!facility) {
      fail(404, "Facility unavailable. Check its workspace code.");
    }
    if (body.acknowledge_no_access_grant !== true) {
      fail(400, "Confirm that primary status does not grant record access.");
    }
    await tx.run(
      "UPDATE primary_care_requests SET status='withdrawn',pending_key=NULL,resolved_at=?,resolved_by=? WHERE patient_id=? AND status='pending'",
      [now(), actor.id, actor.patient_id],
    );
    const origin = await tx.get("SELECT organization_id FROM patient_origins WHERE patient_id=?", [
      actor.patient_id,
    ]);
    const immediate = origin?.organization_id === facility.id;
    if (immediate) {
      await tx.run(
        "INSERT INTO primary_care(patient_id,organization_id,source,changed_at) VALUES (?,?,'first_registration',?) ON CONFLICT(patient_id) DO UPDATE SET organization_id=excluded.organization_id,source=excluded.source,changed_at=excluded.changed_at",
        [actor.patient_id, facility.id, now()],
      );
      await audit(
        tx,
        actor,
        "patient.primary_care_selected",
        "allow",
        actor.patient_id,
        facility.id,
        correlation,
      );
      return { status: "accepted" };
    }
    const id = randomUUID();
    await tx.run(
      "INSERT INTO primary_care_requests(id,patient_id,organization_id,pending_key,created_at,expires_at) VALUES (?,?,?,?,?,?)",
      [id, actor.patient_id, facility.id, actor.patient_id, now(), expires(30)],
    );
    await audit(
      tx,
      actor,
      "patient.primary_care_requested",
      "allow",
      actor.patient_id,
      id,
      correlation,
    );
    return { status: "pending" };
  }
  if (path === "/primary-care/clear" && method === "POST") {
    patientOnly();
    await tx.run("UPDATE patients SET name=name WHERE id=?", [actor.patient_id]);
    // Runtime role deliberately has no deletion: retain a nullable designation as withdrawn history.
    await tx.run("UPDATE primary_care SET organization_id=NULL,changed_at=? WHERE patient_id=?", [
      now(),
      actor.patient_id,
    ]);
    await tx.run(
      "UPDATE primary_care_requests SET status='withdrawn',pending_key=NULL,resolved_at=?,resolved_by=? WHERE patient_id=? AND status='pending'",
      [now(), actor.id, actor.patient_id],
    );
    await audit(
      tx,
      actor,
      "patient.primary_care_cleared",
      "allow",
      actor.patient_id,
      actor.patient_id,
      correlation,
    );
    return { cleared: true };
  }
  if (path === "/primary-care/requests" && method === "GET") {
    permit(actor, "primary.manage");
    const rows = await tx.all(
      `SELECT r.*,o.name AS facility_name,p.name AS patient_name FROM primary_care_requests r JOIN organizations o ON o.id=r.organization_id JOIN patients p ON p.id=r.patient_id WHERE r.organization_id=? ORDER BY r.created_at DESC LIMIT 50`,
      [actor.organization_id],
    );
    // Intentionally only metadata, patient name separately for a solicited administrative relationship.
    return { requests: rows.map(requestView) };
  }
  const primaryAction = path.match(
    /^\/primary-care\/requests\/([^/]+)\/(accept|decline|withdraw)$/,
  );
  if (primaryAction && method === "POST") {
    const [, id, action] = primaryAction;
    const preliminary = await tx.get("SELECT patient_id FROM primary_care_requests WHERE id=?", [
      id,
    ]);
    if (!preliminary) {
      fail(404, "Request unavailable.");
    }
    await tx.run("UPDATE patients SET name=name WHERE id=?", [preliminary.patient_id]);
    const row = await tx.get("SELECT * FROM primary_care_requests WHERE id=?", [id]);
    if (action === "withdraw") {
      patientOnly();
      if (row.patient_id !== actor.patient_id) {
        fail(404, "Request unavailable.");
      }
    } else {
      permit(actor, "primary.manage");
      if (row.organization_id !== actor.organization_id) {
        fail(404, "Request unavailable.");
      }
    }
    if (requestState(row) !== "pending") {
      fail(409, "This request is no longer pending. Refresh requests.");
    }
    const status = { accept: "accepted", decline: "declined", withdraw: "withdrawn" }[action];
    const changed = await tx.get(
      "UPDATE primary_care_requests SET status=?,pending_key=NULL,resolved_at=?,resolved_by=? WHERE id=? AND status='pending' AND expires_at>? RETURNING id",
      [status, now(), actor.id, id, now()],
    );
    if (!changed) {
      fail(409, "This request changed. Refresh requests.");
    }
    if (action === "accept") {
      await tx.run(
        "INSERT INTO primary_care(patient_id,organization_id,source,changed_at) VALUES (?,?,'accepted_request',?) ON CONFLICT(patient_id) DO UPDATE SET organization_id=excluded.organization_id,source=excluded.source,changed_at=excluded.changed_at",
        [row.patient_id, row.organization_id, now()],
      );
    }
    await audit(
      tx,
      actor,
      `patient.primary_care_${status}`,
      "allow",
      row.patient_id,
      id,
      correlation,
    );
    return { status };
  }
  return undefined;
}
