import { workspaceRoutes } from "./workspaces.mjs";
import { randomUUID, randomBytes } from "node:crypto";
import {
  hash,
  passwordHash,
  passwordMatches,
  newTotpSecret,
  verifyTotp,
  protectSecret,
  revealSecret,
  totp,
} from "./security.mjs";
const now = () => new Date().toISOString();
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new ApiError(status, message);
};
const text = (value, field, max = 6000, required = false) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()))
    fail(400, `Invalid ${field}.`);
  return value.trim();
};
const emailValue = (value) => {
  const email = text(value, "email", 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email.");
  return email;
};
const patientInput = (input) => {
  const name = text(input.name, "name", 160, true);
  const dob = input.dob ? text(input.dob, "date of birth", 10) : null;
  if (
    dob &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(dob) ||
      Number.isNaN(Date.parse(dob)) ||
      new Date(dob).toISOString().slice(0, 10) !== dob ||
      dob > now().slice(0, 10))
  )
    fail(400, "Enter a valid date of birth; leave blank if unknown.");
  return { name, dob, phone: input.phone ? text(input.phone, "phone", 40) : null };
};
const noteInput = (input) =>
  Object.fromEntries(
    ["complaint", "history", "findings", "assessment", "plan"].map((key) => [
      key,
      text(input[key] ?? "", key, 6000, key === "complaint"),
    ]),
  );
const safeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.login_email ?? user.email,
  patient_id: user.patient_id,
});
export function createApi(db, config = process.env) {
  const origin = config.PUBLIC_APP_ORIGIN || "http://localhost:3000";
  if (
    config.NODE_ENV === "production" &&
    (!config.PUBLIC_APP_ORIGIN?.startsWith("https://") || !config.DATABASE_URL)
  )
    throw new Error("Production requires HTTPS PUBLIC_APP_ORIGIN and DATABASE_URL.");
  const secure = config.NODE_ENV === "production";
  const secretKey = config.HEALTHPASS_AUTH_KEY;
  if ((secure && !secretKey) || (secretKey && !/^[a-f0-9]{64}$/i.test(secretKey)))
    throw new Error("Configure HEALTHPASS_AUTH_KEY as a server-only 32-byte hex encryption key.");
  const attempts = new Map();
  function limit(key, maximum = 10) {
    const time = Date.now();
    const entry = attempts.get(key);
    const value = entry && entry.until > time ? entry : { count: 0, until: time + 600000 };
    value.count++;
    attempts.set(key, value);
    if (attempts.size > 10000)
      for (const [k, v] of attempts) if (v.until < time) attempts.delete(k);
    if (value.count > maximum) fail(429, "Too many attempts. Try again in ten minutes.");
  }
  const cookie = (token, age = 28800) =>
    `hp_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`;
  async function audit(
    tx,
    actor,
    action,
    decision,
    patient,
    resource,
    correlation,
    consent = null,
  ) {
    await tx.run(
      "INSERT INTO audits(id,actor_id,organization_id,patient_id,resource_id,action,decision,purpose,consent_id,created_at,correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        randomUUID(),
        actor?.id ?? null,
        actor?.organization_id ?? null,
        patient ?? null,
        resource ?? null,
        action,
        decision,
        "care and record governance",
        consent,
        now(),
        correlation,
      ],
    );
  }
  async function session(tx, request) {
    const token = request.headers.get("cookie")?.match(/(?:^|;\s*)hp_session=([a-f0-9]+)/)?.[1];
    if (!token) return null;
    const user = await tx.get(
      "SELECT u.*, s.id AS session_id,s.organization_id,s.mfa_verified,s.created_at AS session_created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1",
      [hash(token), now()],
    );
    if (!user) return null;
    if (user.organization_id) {
      const membership = await tx.get(
        "SELECT role,active,branch_id FROM memberships WHERE user_id=? AND organization_id=?",
        [user.id, user.organization_id],
      );
      if (!membership) fail(403, "Your facility membership is unavailable.");
      user.pendingMembership = !membership.active || !user.verified;
      user.branch_id = membership.branch_id;
      user.role = membership.role;
    } else user.role = "patient";
    return user;
  }
  const authenticated = (actor) => {
    if (!actor) fail(401, "Sign in to continue.");
  };
  const strong = (actor) => {
    authenticated(actor);
    if (actor.pendingMembership)
      fail(403, "Your facility access is awaiting administrator approval.");
    if (actor.organization_id && (!actor.totp_secret || !actor.mfa_verified))
      fail(403, "Complete authenticator verification first.");
  };
  const clinician = (actor) => {
    strong(actor);
    if (actor.role !== "clinician")
      fail(403, "Only an authorized clinician can change clinical records.");
  };
  async function access(tx, actor, patientId, write = false) {
    strong(actor);
    const patient = await tx.get("SELECT * FROM patients WHERE id=?", [patientId]);
    if (!patient) fail(404, "Patient unavailable.");
    if (actor.patient_id === patientId && !write) return { patient, consent: null };
    if (actor.role !== "clinician") fail(403, "Clinical access is not permitted.");
    const local = await tx.get(
      "SELECT patient_id FROM patient_links WHERE patient_id=? AND organization_id=?",
      [patientId, actor.organization_id],
    );
    const grant = await tx.get(
      "SELECT id FROM consents WHERE patient_id=? AND recipient_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1",
      [patientId, actor.organization_id, now()],
    );
    const branchLocal =
      !actor.branch_id ||
      (await tx.get(
        "SELECT patient_id FROM branch_patient_links WHERE patient_id=? AND branch_id=?",
        [patientId, actor.branch_id],
      ));
    if ((!local || !branchLocal) && !grant)
      fail(403, "No active care relationship or sharing grant.");
    return { patient, consent: grant?.id ?? null };
  }
  async function makeSession(tx, user) {
    const membership = await tx.get(
      "SELECT organization_id FROM memberships WHERE user_id=? ORDER BY organization_id LIMIT 1",
      [user.id],
    );
    const token = randomBytes(32).toString("hex");
    await tx.run(
      "INSERT INTO sessions(id,user_id,token_hash,organization_id,expires_at,created_at) VALUES (?,?,?,?,?,?)",
      [
        randomUUID(),
        user.id,
        hash(token),
        membership?.organization_id ?? null,
        new Date(Date.now() + 28800000).toISOString(),
        now(),
      ],
    );
    return token;
  }
  const workspace = workspaceRoutes({ fail, text, emailValue, audit, makeSession, cookie, strong });
  async function dispatch(tx, request, path, method, body, actor, correlation, outputHeaders) {
    if (path === "/auth/facility-register" || path === "/auth/workspace-register")
      limit("workspace-registration", 30);
    const workspaceResult = await workspace(
      tx,
      path,
      method,
      body,
      actor,
      correlation,
      outputHeaders,
    );
    if (workspaceResult !== undefined) return workspaceResult;
    if (path === "/health" && method === "GET")
      return {
        status: "ok",
        mode:
          config.HEALTHPASS_MODE === "synthetic-development"
            ? "synthetic-development"
            : config.NODE_ENV === "production"
              ? "pilot"
              : "synthetic-development",
        database: db.engine,
      };
    if (path === "/auth/login" && method === "POST") {
      const email = emailValue(body.email);
      limit(`login:${body.workspace_code ?? body.account_type ?? "legacy"}:${email}`);
      const password = text(body.password, "password", 256, true);
      let user;
      if (body.account_type === "professional" || body.workspace_code) {
        const code = text(body.workspace_code, "workspace code", 80, true).toUpperCase();
        user = await tx.get(
          "SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id WHERE COALESCE(u.login_email,u.email)=? AND o.workspace_code=? AND u.active=1",
          [email, code],
        );
      } else if (body.account_type === "patient") {
        user = await tx.get(
          "SELECT * FROM users WHERE COALESCE(login_email,email)=? AND account_scope='patient' AND active=1",
          [email],
        );
      } else {
        // Compatibility for previously provisioned accounts; new professional accounts require a workspace code.
        user = await tx.get(
          "SELECT * FROM users WHERE COALESCE(login_email,email)=? AND workspace_auth=0 AND active=1",
          [email],
        );
      }
      // Always perform password work, including for an unknown email.
      const valid = passwordMatches(
        password,
        user?.password_hash ?? passwordHash("constant-unknown-password"),
      );
      if (!user || !valid) fail(401, "Email or password is incorrect.");
      if (!user.patient_id && !user.verified && !user.workspace_auth)
        fail(403, "Professional verification is pending.");
      outputHeaders.set("set-cookie", cookie(await makeSession(tx, user)));
      await audit(tx, user, "auth.login", "allow", user.patient_id, null, correlation);
      return { signedIn: true };
    }
    if (path === "/auth/register" && method === "POST") {
      limit("registration", 30);
      const email = emailValue(body.email);
      const password = text(body.password, "password", 256, true);
      if (password.length < 12) fail(400, "Use a password of at least 12 characters.");
      const data = patientInput(body);
      if (
        await tx.get(
          "SELECT id FROM users WHERE COALESCE(login_email,email)=? AND account_scope='patient'",
          [email],
        )
      )
        fail(409, "Unable to create this account. Try signing in or contact support.");
      const patientId = randomUUID(),
        userId = randomUUID();
      await tx.run(
        "INSERT INTO patients(id,healthpass_id,name,dob,phone,created_at) VALUES (?,?,?,?,?,?)",
        [
          patientId,
          `HP-${randomBytes(6).toString("hex").toUpperCase()}`,
          data.name,
          data.dob,
          data.phone,
          now(),
        ],
      );
      await tx.run("INSERT INTO users(id,email,name,password_hash,patient_id) VALUES (?,?,?,?,?)", [
        userId,
        email,
        data.name,
        passwordHash(password),
        patientId,
      ]);
      const user = await tx.get("SELECT * FROM users WHERE id=?", [userId]);
      outputHeaders.set("set-cookie", cookie(await makeSession(tx, user)));
      await audit(
        tx,
        user,
        "patient.self_registration",
        "allow",
        patientId,
        patientId,
        correlation,
      );
      return { registered: true };
    }
    authenticated(actor);
    if (path === "/auth/me" && method === "GET") {
      const org = actor.organization_id
        ? await tx.get("SELECT * FROM organizations WHERE id=?", [actor.organization_id])
        : null;
      return {
        user: safeUser(actor),
        role: actor.role,
        pendingMembership: !!actor.pendingMembership,
        branch: actor.branch_id
          ? await tx.get("SELECT id,name FROM branches WHERE id=? AND organization_id=?", [
              actor.branch_id,
              actor.organization_id,
            ])
          : null,
        organization: org,
        mfaRequired: !!org && (!actor.totp_secret || !actor.mfa_verified),
        mfaEnrolled: !!actor.totp_secret,
      };
    }
    if (path === "/auth/logout" && method === "POST") {
      await tx.run("DELETE FROM sessions WHERE id=?", [actor.session_id]);
      outputHeaders.set("set-cookie", cookie("", 0));
      return { signedOut: true };
    }
    if (path === "/auth/mfa/setup" && method === "POST") {
      if (!actor.organization_id || actor.totp_secret)
        fail(409, "Authenticator setup unavailable.");
      const secret = newTotpSecret();
      await tx.run("UPDATE users SET pending_totp=? WHERE id=?", [
        protectSecret(secret, secretKey),
        actor.id,
      ]);
      return {
        secret,
        uri: `otpauth://totp/HealthPass:${encodeURIComponent(actor.email)}?secret=${secret}&issuer=HealthPass`,
      };
    }
    if (path === "/auth/mfa/verify" && method === "POST") {
      limit(`mfa:${actor.id}`);
      const secret = revealSecret(actor.totp_secret ?? actor.pending_totp, secretKey),
        code = String(body.code ?? "");
      if (!secret || !verifyTotp(secret, code)) fail(401, "Authenticator code is incorrect.");
      const step = [-1, 0, 1]
        .map((delta) => Math.floor(Date.now() / 30000) + delta)
        .find((value) => totp(secret, value * 30000) === code);
      if (actor.last_totp_step && step <= Number(actor.last_totp_step))
        fail(401, "This code was already used. Wait for the next authenticator code.");
      const updated = await tx.run(
        "UPDATE users SET last_totp_step=? WHERE id=? AND (last_totp_step IS NULL OR CAST(last_totp_step AS BIGINT) < ?)",
        [String(step), actor.id, step],
      );
      if ((updated.rowCount ?? updated.changes) !== 1)
        fail(401, "This code was already used. Wait for the next authenticator code.");
      if (!actor.totp_secret)
        await tx.run("UPDATE users SET totp_secret=pending_totp,pending_totp=NULL WHERE id=?", [
          actor.id,
        ]);
      await tx.run("UPDATE sessions SET mfa_verified=1 WHERE id=?", [actor.session_id]);
      await audit(tx, actor, "auth.mfa_verified", "allow", null, null, correlation);
      return { verified: true };
    }
    strong(actor);
    if (path === "/organizations" && method === "GET")
      return { organizations: await tx.all("SELECT id,name FROM organizations ORDER BY name") };
    if (path === "/patients" && method === "GET") {
      if (actor.patient_id)
        return {
          patients: await tx.all(
            "SELECT id,healthpass_id,name,dob,created_at FROM patients WHERE id=?",
            [actor.patient_id],
          ),
        };
      if (!["clinician", "reception"].includes(actor.role))
        fail(403, "Patient registry access is not permitted.");
      const rows = await tx.all(
        `SELECT DISTINCT p.id,p.healthpass_id,p.name,p.dob,p.created_at FROM patients p LEFT JOIN patient_links l ON l.patient_id=p.id LEFT JOIN consents c ON c.patient_id=p.id WHERE (l.organization_id=? AND (CAST(? AS TEXT) IS NULL OR EXISTS(SELECT 1 FROM branch_patient_links bp WHERE bp.patient_id=p.id AND bp.branch_id=?))) ${actor.role === "clinician" ? "OR (c.recipient_id=? AND c.revoked_at IS NULL AND c.expires_at>?)" : ""} ORDER BY p.name`,
        actor.role === "clinician"
          ? [
              actor.organization_id,
              actor.branch_id ?? null,
              actor.branch_id ?? null,
              actor.organization_id,
              now(),
            ]
          : [actor.organization_id, actor.branch_id ?? null, actor.branch_id ?? null],
      );
      await audit(tx, actor, "registry.list", "allow", null, null, correlation);
      return { patients: rows };
    }
    if (path === "/patients" && method === "POST") {
      if (!["clinician", "reception"].includes(actor.role))
        fail(403, "Registration is not permitted.");
      const data = patientInput(body);
      const id = randomUUID();
      // No automatic demographic matching/merge; every uncertain identity remains separate.
      await tx.run(
        "INSERT INTO patients(id,healthpass_id,name,dob,phone,created_at) VALUES (?,?,?,?,?,?)",
        [
          id,
          `HP-${randomBytes(6).toString("hex").toUpperCase()}`,
          data.name,
          data.dob,
          data.phone,
          now(),
        ],
      );
      await tx.run(
        "INSERT INTO patient_links(patient_id,organization_id,created_at) VALUES (?,?,?)",
        [id, actor.organization_id, now()],
      );
      const branchId =
        actor.branch_id ??
        (
          await tx.get(
            "SELECT id FROM branches WHERE organization_id=? AND active=1 ORDER BY id LIMIT 1",
            [actor.organization_id],
          )
        )?.id;
      if (branchId)
        await tx.run("INSERT INTO branch_patient_links(branch_id,patient_id) VALUES (?,?)", [
          branchId,
          id,
        ]);
      await audit(tx, actor, "registry.register", "allow", id, id, correlation);
      return { id };
    }
    let match = path.match(/^\/patients\/([^/]+)$/);
    if (match && method === "GET") {
      const { patient, consent } = await access(tx, actor, match[1]);
      const encounters = await tx.all(
        "SELECT e.*,u.name AS author_name,o.name AS organization_name FROM encounters e JOIN users u ON u.id=e.author_id JOIN organizations o ON o.id=e.organization_id WHERE e.patient_id=? ORDER BY e.created_at DESC",
        [patient.id],
      );
      const visible = encounters
        .filter(
          (e) =>
            (e.organization_id === actor.organization_id &&
              (!actor.branch_id || e.branch_id === actor.branch_id)) ||
            actor.patient_id === patient.id ||
            consent,
        )
        .filter(
          (e) =>
            e.status !== "draft" ||
            (e.organization_id === actor.organization_id &&
              (!actor.branch_id || e.branch_id === actor.branch_id) &&
              actor.role === "clinician"),
        );
      // Patient and partner readers receive signed snapshots, never newer unsaved draft content.
      const records = [];
      for (const encounter of visible) {
        const versions = await tx.all(
          "SELECT n.*,u.name AS signer_name FROM note_versions n JOIN users u ON u.id=n.author_id WHERE encounter_id=? ORDER BY version DESC",
          [encounter.id],
        );
        const full =
          encounter.status === "draft" &&
          encounter.organization_id === actor.organization_id &&
          (!actor.branch_id || encounter.branch_id === actor.branch_id) &&
          actor.role === "clinician"
            ? encounter
            : { ...encounter, ...JSON.parse(versions[0]?.payload ?? "{}") };
        records.push({
          ...full,
          versions: versions.map((v) => ({ ...v, payload: JSON.parse(v.payload) })),
          editable:
            encounter.organization_id === actor.organization_id &&
            (!actor.branch_id || encounter.branch_id === actor.branch_id) &&
            actor.role === "clinician",
        });
      }
      await audit(tx, actor, "chart.read", "allow", patient.id, patient.id, correlation, consent);
      return { patient, encounters: records };
    }
    match = path.match(/^\/patients\/([^/]+)\/profile$/);
    if (match && method === "PATCH") {
      const { patient, consent } = await access(tx, actor, match[1], true);
      clinician(actor);
      if (!["unknown", "reviewed", "none-known"].includes(body.allergy_status))
        fail(400, "Choose an allergy verification status.");
      const allergies = text(body.allergies ?? "", "allergies");
      if (body.allergy_status === "reviewed" && !allergies)
        fail(400, "Record the reviewed allergy details.");
      await tx.run(
        "UPDATE patients SET allergy_status=?,allergies=?,emergency_contact=? WHERE id=?",
        [
          body.allergy_status,
          body.allergy_status === "reviewed" ? allergies : "",
          text(body.emergency_contact ?? "", "emergency contact", 500),
          patient.id,
        ],
      );
      await audit(
        tx,
        actor,
        "profile.review",
        "allow",
        patient.id,
        patient.id,
        correlation,
        consent,
      );
      return { updated: true };
    }
    if (path === "/encounters" && method === "POST") {
      clinician(actor);
      const { patient, consent } = await access(
        tx,
        actor,
        text(body.patient_id, "patient ID", 100, true),
        true,
      );
      const note = noteInput(body),
        id = randomUUID(),
        date = now();
      // A partner clinician creates their own record; they do not rewrite the source facility's note.
      await tx.run(
        "INSERT INTO encounters(id,patient_id,organization_id,author_id,status,complaint,history,findings,assessment,plan,created_at,updated_at,branch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          patient.id,
          actor.organization_id,
          actor.id,
          "draft",
          ...Object.values(note),
          date,
          date,
          actor.branch_id ?? null,
        ],
      );
      await audit(tx, actor, "encounter.create", "allow", patient.id, id, correlation, consent);
      return { id, version: 1 };
    }
    match = path.match(/^\/encounters\/([^/]+)(?:\/(sign|amend))?$/);
    if (match && ["PATCH", "POST"].includes(method)) {
      clinician(actor);
      const encounter = await tx.get("SELECT * FROM encounters WHERE id=?", [match[1]]);
      if (!encounter) fail(404, "Encounter unavailable.");
      const { consent } = await access(tx, actor, encounter.patient_id, true);
      if (
        encounter.organization_id !== actor.organization_id ||
        (actor.branch_id && encounter.branch_id !== actor.branch_id)
      )
        fail(403, "You cannot change another facility's record.");
      if (!Number.isInteger(body.version) || body.version !== encounter.version)
        fail(409, "This record changed. Reload the chart before saving.");
      const operation = match[2];
      if (method === "PATCH" && !operation) {
        if (encounter.status !== "draft") fail(409, "Signed notes require a versioned amendment.");
        const note = noteInput(body);
        const result = await tx.run(
          "UPDATE encounters SET complaint=?,history=?,findings=?,assessment=?,plan=?,version=version+1,updated_at=? WHERE id=? AND version=? AND status='draft'",
          [...Object.values(note), now(), encounter.id, body.version],
        );
        if ((result.rowCount ?? result.changes) !== 1)
          fail(409, "This record changed. Reload before saving.");
        await audit(
          tx,
          actor,
          "encounter.save",
          "allow",
          encounter.patient_id,
          encounter.id,
          correlation,
          consent,
        );
        return { version: body.version + 1 };
      }
      if (method !== "POST" || !operation) fail(405, "Method not allowed.");
      if (operation === "sign" && encounter.status !== "draft")
        fail(409, "This encounter is already signed.");
      if (operation === "amend" && encounter.status === "draft")
        fail(409, "Sign the initial note before amending.");
      const note =
        operation === "amend" || body.complaint !== undefined
          ? noteInput(body)
          : noteInput(encounter);
      if (!note.assessment || !note.plan)
        fail(400, "Assessment and plan are required before signing.");
      const reason =
        operation === "amend" ? text(body.reason, "amendment reason", 1000, true) : null;
      const previous = await tx.get(
        "SELECT id FROM note_versions WHERE encounter_id=? ORDER BY version DESC LIMIT 1",
        [encounter.id],
      );
      const version = encounter.version + 1,
        signedAt = now(),
        payload = JSON.stringify(note),
        noteId = randomUUID();
      const result = await tx.run(
        "UPDATE encounters SET complaint=?,history=?,findings=?,assessment=?,plan=?,status=?,version=?,updated_at=? WHERE id=? AND version=?",
        [
          ...Object.values(note),
          operation === "amend" ? "amended" : "signed",
          version,
          signedAt,
          encounter.id,
          body.version,
        ],
      );
      if ((result.rowCount ?? result.changes) !== 1)
        fail(409, "This record changed. Reload before signing.");
      // Hash binds the retained note, author and time; it is an integrity digest, not a PKI signature.
      await tx.run(
        "INSERT INTO note_versions(id,encounter_id,version,author_id,payload,signature_hash,signed_at,amendment_reason,previous_id) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          noteId,
          encounter.id,
          version,
          actor.id,
          payload,
          hash(
            JSON.stringify({
              encounter: encounter.id,
              version,
              author: actor.id,
              signedAt,
              payload,
              reason,
              previous: previous?.id ?? null,
            }),
          ),
          signedAt,
          reason,
          previous?.id ?? null,
        ],
      );
      await audit(
        tx,
        actor,
        `encounter.${operation}`,
        "allow",
        encounter.patient_id,
        noteId,
        correlation,
        consent,
      );
      return { version };
    }
    if (path === "/consents" && method === "GET") {
      if (!actor.patient_id) fail(403, "Use a patient account to manage sharing.");
      return {
        consents: await tx.all(
          "SELECT c.*,o.name AS recipient_name FROM consents c JOIN organizations o ON o.id=c.recipient_id WHERE patient_id=? ORDER BY created_at DESC",
          [actor.patient_id],
        ),
      };
    }
    if (path === "/consents" && method === "POST") {
      if (!actor.patient_id) fail(403, "Only the patient can grant this sharing scope.");
      const recipient = text(body.recipient_id, "recipient", 100, true),
        purpose = text(body.purpose, "purpose", 500, true);
      if (!(await tx.get("SELECT id FROM organizations WHERE id=?", [recipient])))
        fail(400, "Recipient unavailable.");
      const expiry = text(body.expires_at, "expiry", 40, true),
        timestamp = Date.parse(expiry);
      if (
        !Number.isFinite(timestamp) ||
        timestamp <= Date.now() ||
        timestamp > Date.now() + 90 * 86400000
      )
        fail(400, "Sharing must expire within 90 days.");
      const id = randomUUID();
      await tx.run(
        "INSERT INTO consents(id,patient_id,recipient_id,grantor_id,purpose,expires_at,created_at) VALUES (?,?,?,?,?,?,?)",
        [
          id,
          actor.patient_id,
          recipient,
          actor.id,
          purpose,
          new Date(timestamp).toISOString(),
          now(),
        ],
      );
      await audit(tx, actor, "consent.grant", "allow", actor.patient_id, id, correlation, id);
      return { id };
    }
    match = path.match(/^\/consents\/([^/]+)\/revoke$/);
    if (match && method === "POST") {
      const grant = await tx.get("SELECT * FROM consents WHERE id=? AND patient_id=?", [
        match[1],
        actor.patient_id ?? "",
      ]);
      if (!grant) fail(403, "Sharing grant unavailable.");
      await tx.run("UPDATE consents SET revoked_at=? WHERE id=?", [now(), grant.id]);
      await audit(
        tx,
        actor,
        "consent.revoke",
        "allow",
        actor.patient_id,
        grant.id,
        correlation,
        grant.id,
      );
      return { revoked: true };
    }
    if (path === "/audit" && method === "GET") {
      const rows = actor.patient_id
        ? await tx.all(
            "SELECT a.*,u.name AS actor_name,o.name AS organization_name FROM audits a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN organizations o ON o.id=a.organization_id WHERE a.patient_id=? ORDER BY a.created_at DESC LIMIT 100",
            [actor.patient_id],
          )
        : await tx.all(
            "SELECT a.*,u.name AS actor_name FROM audits a LEFT JOIN users u ON u.id=a.actor_id WHERE a.organization_id=? ORDER BY a.created_at DESC LIMIT 100",
            [actor.organization_id],
          );
      await audit(tx, actor, "audit.read", "allow", actor.patient_id, null, correlation);
      return { audits: rows };
    }
    fail(404, "Endpoint unavailable.");
  }
  return async (request) => {
    const url = new URL(request.url),
      path = url.pathname.replace(/^\/api\/healthpass/, "") || "/";
    const correlation = randomUUID(),
      headers = new Headers({
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-correlation-id": correlation,
      });
    let actor = null;
    try {
      if (!["GET", "POST", "PATCH"].includes(request.method)) fail(405, "Method not allowed.");
      let body = {};
      if (request.method !== "GET") {
        if (request.headers.get("origin") !== origin) fail(403, "Request origin is not permitted.");
        if (!request.headers.get("content-type")?.includes("application/json"))
          fail(415, "Use application/json.");
        const raw = await request.text();
        if (raw.length > 40000) fail(413, "Request too large.");
        try {
          body = JSON.parse(raw);
        } catch {
          fail(400, "Invalid JSON.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          fail(400, "Invalid request body.");
      }
      const result = await db.transaction(async (tx) => {
        actor = await session(tx, request);
        return dispatch(tx, request, path, request.method, body, actor, correlation, headers);
      });
      return new Response(JSON.stringify(result), { status: 200, headers });
    } catch (error) {
      const status = error.status ?? 500;
      // Failed transaction rolls back. Persist denial separately, without submitted clinical content.
      if (status === 401 || status === 403)
        await db
          .transaction((tx) => audit(tx, actor, "access.denied", "deny", null, null, correlation))
          .catch(() => {});
      if (status === 500)
        console.error("HealthPass request failed", correlation, error.code ?? error.name);
      headers.delete("set-cookie");
      return new Response(
        JSON.stringify({
          error:
            status === 500 ? "The request could not be completed. Please retry." : error.message,
          correlation,
        }),
        { status, headers },
      );
    }
  };
}
