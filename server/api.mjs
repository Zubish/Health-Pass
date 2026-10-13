import { handleDepartments } from "./departments.mjs";
import { handleAccountSecurity, recordSignin, signinContext } from "./account-security.mjs";
import { handleTreatment } from "./treatment.mjs";
import { handleCareOperations } from "./care-operations.mjs";
import { handleConsultantReferrals } from "./consultant-referrals.mjs";
import { careAreaAllowsPatient, careAreaPatientPredicate } from "./care-area-access.mjs";
import { hasPermission, resolveMembership } from "./roles.mjs";
import { workspaceRoutes } from "./workspaces.mjs";
import { handlePatientOnboarding, patientForEmail } from "./patient-onboarding.mjs";
import { deliverPatientEmails } from "./patient-email.mjs";
import { handleCareResponsibilities } from "./care-responsibilities.mjs";
import { handlePatientLinking } from "./patient-linking.mjs";
import { handleVisits, validateEncounterVisit } from "./visits.mjs";
import { handleCareHandoffs, participatingVisitIds, visitParticipation } from "./care-handoffs.mjs";
import {
  handleProfessionalAccess,
  resolveProfessionalAccess,
  listProfessionalPatients,
} from "./professional-access.mjs";
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
  const cookie = (token, age = 2592000) =>
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
    details = null,
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
        details ?? "care and record governance",
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
      "SELECT u.*, s.id AS session_id,s.organization_id,s.mfa_verified,s.mfa_skipped,s.created_at AS session_created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.last_seen_at>? AND u.active=1 AND (u.eight_hour_limit=0 OR s.created_at>?)",
      [
        hash(token),
        now(),
        new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        new Date(Date.now() - 28800000).toISOString(),
      ],
    );
    if (!user) return null;
    await tx.run("UPDATE sessions SET last_seen_at=? WHERE id=?", [now(), user.session_id]);
    if (user.organization_id) {
      const membership = await tx.get(
        "SELECT * FROM memberships WHERE user_id=? AND organization_id=?",
        [user.id, user.organization_id],
      );
      if (!membership) fail(403, "Your facility membership is unavailable.");
      await resolveMembership(tx, membership, user);
      user.pendingMembership = !membership.active || !user.verified;
      user.authenticatorPromptDismissed = !!membership.authenticator_prompt_dismissed;
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
    if (actor.accessExpired)
      fail(403, "Your workspace access has expired. Contact its administrator.");
    if (actor.pendingMembership)
      fail(403, "Your facility access is awaiting administrator approval.");
    if (
      actor.organization_id &&
      !actor.mfa_verified &&
      !actor.mfa_skipped &&
      !actor.authenticatorPromptDismissed
    )
      fail(403, "Verify with your authenticator or choose Continue.");
  };
  const permit = (actor, key) => {
    strong(actor);
    if (!hasPermission(actor, key)) fail(403, "Your workspace roles do not permit this action.");
  };
  async function access(
    tx,
    actor,
    patientId,
    write = false,
    { checkSession = true, assignmentCheck = false } = {},
  ) {
    if (checkSession) strong(actor);
    const patient = await tx.get("SELECT * FROM patients WHERE id=?", [patientId]);
    if (!patient) fail(404, "Patient unavailable.");
    const legacyPolicy = {
      restricted: false,
      scopes: ["general", "nursing", "medication", "laboratory", "radiology"],
      includeProfile: true,
      canContribute: true,
      canEditProfile: true,
      contributionScopes: actor.clinicalScopes ?? [],
      grantId: null,
    };
    if (
      !actor.patient_id &&
      actor.clinicalScopes?.length &&
      actor.clinicalScopes.every((s) => ["laboratory", "radiology"].includes(s))
    ) {
      legacyPolicy.scopes = [...actor.clinicalScopes];
      legacyPolicy.includeProfile = false;
      legacyPolicy.canEditProfile = false;
    }
    if (actor.patient_id === patientId && !write)
      return { patient, consent: null, accessPolicy: legacyPolicy };
    if (!hasPermission(actor, "records.view")) fail(403, "Clinical access is not permitted.");
    if (!(await careAreaAllowsPatient(tx, actor, patientId)))
      fail(403, "This patient is outside your assigned department or ward scope.");
    let episodeScopes = null;
    const admission = await tx.get(
      "SELECT id FROM care_admissions WHERE patient_id=? AND organization_id=? AND status='active'",
      [patientId, actor.organization_id],
    );
    if (admission && !assignmentCheck) {
      const team = await tx.get(
        "SELECT duty FROM admission_team_members WHERE admission_id=? AND user_id=? AND active=1",
        [admission.id, actor.id],
      );
      const lead = await tx.get(
        "SELECT id FROM care_responsibilities WHERE admission_id=? AND consultant_id=? AND status='active'",
        [admission.id, actor.id],
      );
      episodeScopes = [
        ...new Set([
          ...(team
            ? [{ doctor: "general", nurse: "nursing", medication: "medication" }[team.duty]]
            : []),
          ...(lead ? ["general"] : []),
        ]),
      ];
      if (write && !actor.clinicalScopes.some((scope) => episodeScopes.includes(scope)))
        fail(
          403,
          "Your current inpatient care-team assignment does not permit this care category.",
        );
      legacyPolicy.contributionScopes = legacyPolicy.contributionScopes.filter((scope) =>
        episodeScopes.includes(scope),
      );
      legacyPolicy.canContribute = legacyPolicy.contributionScopes.length > 0;
      legacyPolicy.canEditProfile = legacyPolicy.canContribute;
    }
    const policy = await resolveProfessionalAccess(tx, actor, patientId);
    if (episodeScopes) {
      policy.contributionScopes = policy.contributionScopes.filter((scope) =>
        episodeScopes.includes(scope),
      );
      policy.canContribute = policy.canContribute && policy.contributionScopes.length > 0;
      policy.canEditProfile = policy.canEditProfile && policy.canContribute;
    }
    if (policy.restricted) {
      if (!policy.grants.length)
        fail(
          403,
          "This patient permits only selected professionals. Ask them to grant you access.",
        );
      if (write && (!policy.canContribute || !policy.contributionScopes.length))
        fail(403, "Your patient sharing grant permits reading only.");
      return { patient, consent: null, accessPolicy: policy };
    }
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
    const preferences = await tx.all(
      "SELECT include_profile FROM patient_relationship_preferences WHERE patient_id=? AND organization_id=? AND (CAST(? AS TEXT) IS NULL OR branch_id=?)",
      [patientId, actor.organization_id, actor.branch_id ?? null, actor.branch_id ?? null],
    );
    const includeProfile =
      !!grant || !preferences.length || preferences.some((row) => row.include_profile === 1);
    return {
      patient,
      consent: grant?.id ?? null,
      accessPolicy: {
        ...legacyPolicy,
        includeProfile: includeProfile && legacyPolicy.includeProfile,
        canEditProfile: includeProfile && legacyPolicy.canEditProfile,
      },
    };
  }
  const requireContributionScope = (policy, scope) => {
    if (!policy.contributionScopes.includes(scope))
      fail(403, "The patient has not permitted you to contribute this record category.");
  };
  const accessAudit = (policy) =>
    policy.restricted
      ? JSON.stringify({ active_professional_grant_ids: policy.grants.map((grant) => grant.id) })
      : null;
  async function makeSession(tx, user) {
    const membership = await tx.get(
      "SELECT organization_id FROM memberships WHERE user_id=? ORDER BY organization_id LIMIT 1",
      [user.id],
    );
    const token = randomBytes(32).toString("hex");
    await tx.run(
      "INSERT INTO sessions(id,user_id,token_hash,organization_id,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)",
      [
        randomUUID(),
        user.id,
        hash(token),
        membership?.organization_id ?? null,
        new Date(Date.now() + 30 * 86400000).toISOString(),
        now(),
        now(),
      ],
    );
    return token;
  }
  const workspace = workspaceRoutes({ fail, text, emailValue, audit, makeSession, cookie, strong });
  async function dispatch(tx, request, path, method, body, actor, correlation, outputHeaders) {
    if (path === "/auth/workspace-check" && method === "POST") {
      limit("workspace-check", 60);
      const code = text(body.workspace_code, "workspace code", 80, true).toUpperCase();
      const organization = await tx.get(
        "SELECT name,workspace_code FROM organizations WHERE workspace_code=?",
        [code],
      );
      if (!organization)
        fail(400, "Workspace not found. Check the code with your facility administrator.");
      return { workspace: organization };
    }
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
    if (path === "/auth/patient-claim")
      return handlePatientOnboarding(tx, {
        actor,
        path,
        method,
        body,
        searchParams: new URL(request.url).searchParams,
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
      });
    if (path === "/auth/login" && method === "POST") {
      const email = emailValue(body.email);
      limit(
        `login:${String(body.workspace_code ?? body.account_type ?? "legacy")
          .trim()
          .toUpperCase()}:${email}`,
      );
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
      if (await patientForEmail(tx, email))
        fail(
          409,
          "This email already has a patient account or facility registration. Sign in or use your activation invitation.",
        );
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
      const reserved = await tx.get(
        "INSERT INTO patient_addresses(email,patient_id,created_at) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING RETURNING email",
        [email, patientId, now()],
      );
      if (!reserved)
        fail(
          409,
          "This email already has a patient account or facility registration. Use its activation invitation.",
        );
      await tx.run("INSERT INTO users(id,email,name,password_hash,patient_id) VALUES (?,?,?,?,?)", [
        userId,
        email,
        data.name,
        passwordHash(password),
        patientId,
      ]);
      await tx.run("UPDATE patient_addresses SET claimed_by=? WHERE email=?", [userId, email]);
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
    const context = {
      actor,
      path,
      method,
      body,
      searchParams: new URL(request.url).searchParams,
      permit,
      strong,
      access,
      assignmentAuthority: (tx, candidate, patientId, write = false) =>
        access(tx, candidate, patientId, write, { checkSession: false, assignmentCheck: true }),
      careAuthority: (tx, candidate, patientId, write = false) =>
        access(tx, candidate, patientId, write, { checkSession: false }),
      fail,
      text,
      audit,
      correlation,
      limit,
      emailValue,
      patientInput,
      config,
      makeSession,
      cookie,
      outputHeaders,
    };
    const securityResult = await handleAccountSecurity(tx, context);
    if (securityResult !== undefined) return securityResult;
    const departmentResult = await handleDepartments(tx, context);
    if (departmentResult !== undefined) return departmentResult;
    const treatmentResult = await handleTreatment(tx, context);
    if (treatmentResult !== undefined) return treatmentResult;
    const operationsResult = await handleCareOperations(tx, context);
    if (operationsResult !== undefined) return operationsResult;
    const referralsResult = await handleConsultantReferrals(tx, context);
    if (referralsResult !== undefined) return referralsResult;
    const responsibilityResult = await handleCareResponsibilities(tx, context);
    if (responsibilityResult !== undefined) return responsibilityResult;
    const onboardingResult = await handlePatientOnboarding(tx, context);
    if (onboardingResult !== undefined) return onboardingResult;
    const linkingResult = await handlePatientLinking(tx, context);
    if (linkingResult !== undefined) return linkingResult;
    const sharingResult = await handleProfessionalAccess(tx, context);
    if (sharingResult !== undefined) return sharingResult;
    const handoffResult = await handleCareHandoffs(tx, context);
    if (handoffResult !== undefined) return handoffResult;
    const visitResult = await handleVisits(tx, context);
    if (visitResult !== undefined) return visitResult;
    if (path === "/auth/me" && method === "GET") {
      const org = actor.organization_id
        ? await tx.get("SELECT * FROM organizations WHERE id=?", [actor.organization_id])
        : null;
      return {
        securityAlerts: Number(
          (
            await tx.get(
              "SELECT COUNT(*) AS count FROM signin_events WHERE user_id=? AND risk<>'normal' AND reviewed_at IS NULL",
              [actor.id],
            )
          ).count,
        ),
        user: safeUser(actor),
        role: actor.role,
        permissions: actor.permissions ?? [],
        jobRoles: actor.jobRoles ?? [],
        clinicalScopes: actor.clinicalScopes ?? [],
        deniedPermissions: actor.deniedPermissions ?? [],
        careAreaRestricted: !!actor.careAreaRestricted,
        careAreaIds: actor.careAreaIds ?? [],
        isOwner: !!actor.isOwner,
        accessExpired: !!actor.accessExpired,
        supportAccess: !!actor.supportAccess,
        accessExpiresAt: actor.accessExpiresAt ?? null,
        pendingMembership: !!actor.pendingMembership,
        branch: actor.branch_id
          ? await tx.get("SELECT id,name FROM branches WHERE id=? AND organization_id=?", [
              actor.branch_id,
              actor.organization_id,
            ])
          : null,
        organization: org,
        mfaRequired:
          !!org && !actor.mfa_verified && !actor.mfa_skipped && !actor.authenticatorPromptDismissed,
        mfaEnrolled: !!actor.totp_secret,
      };
    }
    if (path === "/auth/logout" && method === "POST") {
      await tx.run("DELETE FROM sessions WHERE id=?", [actor.session_id]);
      outputHeaders.set("set-cookie", cookie("", 0));
      return { signedOut: true };
    }
    if (path === "/auth/mfa/skip" && method === "POST") {
      if (!actor.organization_id) fail(400, "Authenticator choice is for professional workspaces.");
      if (actor.pendingMembership)
        fail(403, "Your facility access is awaiting administrator approval.");
      if (actor.accessExpired)
        fail(403, "Your workspace access has expired. Contact its administrator.");
      if (body.dont_show_again === true) {
        await tx.run(
          "UPDATE memberships SET authenticator_prompt_dismissed=1 WHERE user_id=? AND organization_id=?",
          [actor.id, actor.organization_id],
        );
      }
      await tx.run("UPDATE sessions SET mfa_skipped=1 WHERE id=?", [actor.session_id]);
      await audit(
        tx,
        actor,
        "auth.mfa_skipped",
        "allow",
        null,
        null,
        correlation,
        null,
        JSON.stringify({ dont_show_again: body.dont_show_again === true }),
      );
      return { skipped: true };
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
      permit(actor, "registry.view");
      const areaPredicate = careAreaPatientPredicate(actor);
      const rows = await tx.all(
        `SELECT DISTINCT p.id,p.healthpass_id,p.name,p.dob,p.created_at FROM patients p LEFT JOIN patient_links l ON l.patient_id=p.id LEFT JOIN consents c ON c.patient_id=p.id LEFT JOIN patient_access_settings pas ON pas.patient_id=p.id WHERE ((l.organization_id=? AND (CAST(? AS TEXT) IS NULL OR EXISTS(SELECT 1 FROM branch_patient_links bp WHERE bp.patient_id=p.id AND bp.branch_id=?))) ${hasPermission(actor, "records.view") ? "OR (c.recipient_id=? AND c.revoked_at IS NULL AND c.expires_at>? AND COALESCE(pas.restricted,0)=0)" : ""}) AND (${areaPredicate.sql}) ORDER BY p.name`,
        [
          ...(hasPermission(actor, "records.view")
            ? [
                actor.organization_id,
                actor.branch_id ?? null,
                actor.branch_id ?? null,
                actor.organization_id,
                now(),
              ]
            : [actor.organization_id, actor.branch_id ?? null, actor.branch_id ?? null]),
          ...areaPredicate.args,
        ],
      );
      if (hasPermission(actor, "records.view")) {
        const named = await listProfessionalPatients(tx, actor);
        const ids = new Set(rows.map((p) => p.id));
        for (const patient of named) if (!ids.has(patient.id)) rows.push(patient);
        rows.sort((a, b) => a.name.localeCompare(b.name));
      }
      if (hasPermission(actor, "registry.create")) {
        const origins = await tx.all(
          "SELECT r.patient_id,a.claimed_by FROM patient_origins r LEFT JOIN patient_addresses a ON a.patient_id=r.patient_id WHERE r.organization_id=? AND (CAST(? AS TEXT) IS NULL OR r.branch_id=?)",
          [actor.organization_id, actor.branch_id ?? null, actor.branch_id ?? null],
        );
        const activatable = new Set(origins.filter((r) => !r.claimed_by).map((r) => r.patient_id));
        for (const row of rows) row.can_activate = activatable.has(row.id);
      }
      await audit(tx, actor, "registry.list", "allow", null, null, correlation);
      return { patients: rows };
    }
    let match = path.match(/^\/patients\/([^/]+)$/);
    if (match && method === "GET") {
      const { patient, consent, accessPolicy } = await access(tx, actor, match[1]);
      const sharedVisits = new Set(await participatingVisitIds(tx, actor, patient.id));
      const encounters = await tx.all(
        "SELECT e.*,u.name AS author_name,o.name AS organization_name FROM encounters e JOIN users u ON u.id=e.author_id JOIN organizations o ON o.id=e.organization_id WHERE e.patient_id=? ORDER BY e.created_at DESC",
        [patient.id],
      );
      const visible = encounters
        .filter(
          (e) =>
            (accessPolicy.restricted && accessPolicy.scopes.includes(e.note_kind ?? "general")) ||
            (!accessPolicy.restricted &&
              e.organization_id === actor.organization_id &&
              (!actor.branch_id || e.branch_id === actor.branch_id)) ||
            actor.patient_id === patient.id ||
            consent,
        )
        .filter(
          (e) =>
            (e.status !== "draft" ||
              (e.author_id === actor.id &&
                e.organization_id === actor.organization_id &&
                (!actor.branch_id || e.branch_id === actor.branch_id) &&
                hasPermission(actor, "records.view"))) &&
            (!e.visit_id ||
              e.author_id === actor.id ||
              actor.patient_id === patient.id ||
              sharedVisits.has(e.visit_id) ||
              (accessPolicy.restricted &&
                accessPolicy.scopes.includes(e.note_kind ?? "general"))) &&
            (!accessPolicy.restricted || accessPolicy.scopes.includes(e.note_kind ?? "general")) &&
            (e.status !== "draft" ||
              !accessPolicy.restricted ||
              accessPolicy.contributionScopes.includes(e.note_kind ?? "general")),
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
          hasPermission(actor, "records.view")
            ? encounter
            : { ...encounter, ...JSON.parse(versions[0]?.payload ?? "{}") };
        const { create_request_payload, client_request_id, ...released } = full;
        let visitEditable = true;
        if (encounter.visit_id) {
          const visit = await tx.get(
            "SELECT assigned_user_id,status FROM care_visits WHERE id=? AND organization_id=?",
            [encounter.visit_id, actor.organization_id],
          );
          visitEditable =
            !!visit &&
            (visit.assigned_user_id === actor.id ||
              (encounter.status !== "draft" &&
                (await visitParticipation(tx, actor, encounter.visit_id)))) &&
            hasPermission(actor, "visits.document") &&
            (visit.status === "in-progress" ||
              (encounter.status !== "draft" && ["completed", "cancelled"].includes(visit.status)));
        }
        records.push({
          ...released,
          versions: versions.map((v) => ({ ...v, payload: JSON.parse(v.payload) })),
          editable:
            accessPolicy.canContribute &&
            accessPolicy.contributionScopes.includes(encounter.note_kind ?? "general") &&
            visitEditable &&
            encounter.author_id === actor.id &&
            actor.clinicalScopes?.includes(encounter.note_kind) &&
            (encounter.status === "draft"
              ? hasPermission(actor, "notes.edit") || hasPermission(actor, "notes.sign")
              : hasPermission(actor, "notes.amend")) &&
            encounter.organization_id === actor.organization_id &&
            (!actor.branch_id || encounter.branch_id === actor.branch_id) &&
            hasPermission(actor, "records.view"),
        });
      }
      const releasedPatient =
        !accessPolicy.restricted && accessPolicy.includeProfile
          ? patient
          : {
              id: patient.id,
              healthpass_id: patient.healthpass_id,
              name: patient.name,
              dob: patient.dob,
              created_at: patient.created_at,
              ...(accessPolicy.includeProfile
                ? {
                    allergy_status: patient.allergy_status,
                    allergies: patient.allergies,
                    emergency_contact: patient.emergency_contact,
                  }
                : {}),
            };
      await audit(
        tx,
        actor,
        "chart.read",
        "allow",
        patient.id,
        patient.id,
        correlation,
        consent,
        accessAudit(accessPolicy),
      );
      return {
        patient: releasedPatient,
        encounters: records,
        accessScope: {
          restricted: accessPolicy.restricted,
          scopes: accessPolicy.scopes,
          includeProfile: accessPolicy.includeProfile,
          canContribute: accessPolicy.canContribute,
          canEditProfile: accessPolicy.canEditProfile,
          contributionScopes: accessPolicy.contributionScopes,
        },
      };
    }
    match = path.match(/^\/patients\/([^/]+)\/profile$/);
    if (match && method === "PATCH") {
      const { patient, consent, accessPolicy } = await access(tx, actor, match[1], true);
      permit(actor, "profile.edit");
      if (!accessPolicy.canEditProfile)
        fail(403, "The patient has not shared their clinical profile.");
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
        accessAudit(accessPolicy),
      );
      return { updated: true };
    }
    if (path === "/encounters" && method === "POST") {
      permit(actor, "notes.create");
      const kind = body.note_kind ?? actor.clinicalScopes[0];
      if (!actor.clinicalScopes.includes(kind))
        fail(403, "Your reviewed clinical scope does not cover this note type.");
      const { patient, consent, accessPolicy } = await access(
        tx,
        actor,
        text(body.patient_id, "patient ID", 100, true),
        true,
      );
      requireContributionScope(accessPolicy, kind);
      const note = noteInput(body),
        id = randomUUID(),
        date = now();
      const visit = body.visit_id
        ? await validateEncounterVisit(tx, context, body.visit_id, patient.id)
        : null;
      const requestKey =
        body.client_request_id === undefined
          ? null
          : text(body.client_request_id, "request ID", 100, true);
      const requestPayload = JSON.stringify({
        patient_id: patient.id,
        visit_id: visit?.id ?? null,
        note_kind: kind,
        ...note,
      });
      const replayDraft = (existing) => {
        if (existing.create_request_payload !== requestPayload)
          fail(
            409,
            "This request was already used for different note content. Reload the chart before continuing.",
          );
        return { id: existing.id, version: existing.version };
      };
      if (requestKey) {
        const existing = await tx.get(
          "SELECT id,version,create_request_payload FROM encounters WHERE author_id=? AND client_request_id=?",
          [actor.id, requestKey],
        );
        if (existing) return replayDraft(existing);
      }
      // A partner clinician creates their own record; they do not rewrite the source facility's note.
      const inserted = await tx.get(
        "INSERT INTO encounters(id,patient_id,organization_id,author_id,status,complaint,history,findings,assessment,plan,created_at,updated_at,branch_id,note_kind,visit_id,client_request_id,create_request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(author_id,client_request_id) DO NOTHING RETURNING id",
        [
          id,
          patient.id,
          actor.organization_id,
          actor.id,
          "draft",
          ...Object.values(note),
          date,
          date,
          visit?.branch_id ?? actor.branch_id ?? null,
          kind,
          visit?.id ?? null,
          requestKey,
          requestPayload,
        ],
      );
      if (!inserted) {
        return replayDraft(
          await tx.get(
            "SELECT id,version,create_request_payload FROM encounters WHERE author_id=? AND client_request_id=?",
            [actor.id, requestKey],
          ),
        );
      }
      await audit(
        tx,
        actor,
        "encounter.create",
        "allow",
        patient.id,
        id,
        correlation,
        consent,
        accessAudit(accessPolicy),
      );
      return { id, version: 1 };
    }
    match = path.match(/^\/encounters\/([^/]+)(?:\/(sign|amend))?$/);
    if (match && ["PATCH", "POST"].includes(method)) {
      permit(
        actor,
        match[2] === "sign" ? "notes.sign" : match[2] === "amend" ? "notes.amend" : "notes.edit",
      );
      const encounter = await tx.get("SELECT * FROM encounters WHERE id=?", [match[1]]);
      if (!encounter) fail(404, "Encounter unavailable.");
      if (encounter.author_id !== actor.id || !actor.clinicalScopes.includes(encounter.note_kind))
        fail(403, "You can only change your own notes within your reviewed clinical scope.");
      if (encounter.visit_id)
        await validateEncounterVisit(tx, context, encounter.visit_id, encounter.patient_id, {
          allowCompleted: match[2] === "amend",
        });
      const { consent, accessPolicy } = await access(tx, actor, encounter.patient_id, true);
      requireContributionScope(accessPolicy, encounter.note_kind ?? "general");
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
          accessAudit(accessPolicy),
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
      if (
        operation === "sign" &&
        !hasPermission(actor, "notes.edit") &&
        Object.keys(note).some((key) => note[key] !== encounter[key])
      )
        fail(403, "Signing permission does not grant permission to edit the draft.");
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
        accessAudit(accessPolicy),
      );
      return { version };
    }
    if (path === "/consents" && method === "GET") {
      if (!actor.patient_id) fail(403, "Use a patient account to manage sharing.");
      return {
        restricted: !!(await tx.get(
          "SELECT patient_id FROM patient_access_settings WHERE patient_id=? AND restricted=1",
          [actor.patient_id],
        )),
        consents: await tx.all(
          "SELECT c.*,o.name AS recipient_name FROM consents c JOIN organizations o ON o.id=c.recipient_id WHERE patient_id=? ORDER BY created_at DESC",
          [actor.patient_id],
        ),
      };
    }
    if (path === "/consents" && method === "POST") {
      if (!actor.patient_id) fail(403, "Only the patient can grant this sharing scope.");
      if (
        await tx.get(
          "SELECT patient_id FROM patient_access_settings WHERE patient_id=? AND restricted=1",
          [actor.patient_id],
        )
      )
        fail(
          403,
          "You use only selected professionals. Create a named-professional grant instead.",
        );
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
      if (!actor.patient_id) permit(actor, "audit.view");
      const rows = actor.patient_id
        ? await tx.all(
            "SELECT a.*,u.name AS actor_name,o.name AS organization_name FROM audits a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN organizations o ON o.id=a.organization_id WHERE a.patient_id=? ORDER BY a.created_at DESC LIMIT 100",
            [actor.patient_id],
          )
        : await tx.all(
            "SELECT a.*,u.name AS actor_name FROM audits a LEFT JOIN users u ON u.id=a.actor_id WHERE a.organization_id=? AND (CAST(? AS TEXT) IS NULL OR a.actor_id=?) ORDER BY a.created_at DESC LIMIT 100",
            [
              actor.organization_id,
              hasPermission(actor, "audit.manage") ? null : actor.id,
              actor.id,
            ],
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
    let submittedBody = null;
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
      submittedBody = body;
      if (path === "/auth/login" && request.method === "POST") {
        const attemptKey = hash(
          String(body.workspace_code ?? body.account_type ?? "legacy")
            .trim()
            .toUpperCase() +
            ":" +
            String(body.email ?? "")
              .trim()
              .toLowerCase(),
        );
        const count = await db.transaction(async (tx) => {
          await tx.run(
            "INSERT INTO signin_attempt_limits(id,attempt_count,window_ends_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET attempt_count=CASE WHEN signin_attempt_limits.window_ends_at>? THEN signin_attempt_limits.attempt_count+1 ELSE 1 END,window_ends_at=CASE WHEN signin_attempt_limits.window_ends_at>? THEN signin_attempt_limits.window_ends_at ELSE excluded.window_ends_at END",
            [attemptKey, new Date(Date.now() + 600000).toISOString(), now(), now()],
          );
          return (
            await tx.get("SELECT attempt_count FROM signin_attempt_limits WHERE id=?", [attemptKey])
          ).attempt_count;
        });
        if (count > 10) fail(429, "Too many attempts. Try again in ten minutes.");
      }
      const result = await db.transaction(async (tx) => {
        actor = await session(tx, request);
        const result = await dispatch(
          tx,
          request,
          path,
          request.method,
          body,
          actor,
          correlation,
          headers,
        );
        const sessionToken = headers.get("set-cookie")?.match(/^hp_session=([a-f0-9]+)/)?.[1];
        if (sessionToken && path.startsWith("/auth/"))
          await recordSignin(tx, request, headers, secure, sessionToken);
        if (request.method !== "GET") {
          const current = actor?.id
            ? actor
            : sessionToken
              ? await tx.get("SELECT user_id AS id FROM sessions WHERE token_hash=?", [
                  hash(sessionToken),
                ])
              : null;
          if (current)
            await tx.run(
              "INSERT INTO account_activity(id,user_id,action,created_at) VALUES (?,?,?,?)",
              [
                randomUUID(),
                current.id,
                path
                  .split("/")
                  .filter((part) => part && !/^[0-9a-f-]{20,}$/.test(part))
                  .join(" · "),
                now(),
              ],
            );
        }
        return result;
      });
      if (request.method !== "GET") await deliverPatientEmails(db, config).catch(() => {});
      return new Response(JSON.stringify(result), { status: 200, headers });
    } catch (error) {
      const status = error.status ?? 500;
      if (path === "/auth/login" && status === 401 && submittedBody?.email)
        await db
          .transaction(async (tx) => {
            const email = String(submittedBody.email).trim().toLowerCase();
            const user = submittedBody.workspace_code
              ? await tx.get(
                  "SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id WHERE COALESCE(u.login_email,u.email)=? AND o.workspace_code=?",
                  [email, String(submittedBody.workspace_code).toUpperCase()],
                )
              : await tx.get(
                  "SELECT id FROM users WHERE COALESCE(login_email,email)=? AND account_scope='patient'",
                  [email],
                );
            if (user) {
              const info = signinContext(request);
              await tx.run(
                "INSERT INTO signin_events(id,user_id,action,device_label,country,ip_hash,risk,created_at) VALUES (?,?,?,?,?,?,?,?)",
                [
                  randomUUID(),
                  user.id,
                  "failed_signin",
                  info.label,
                  info.country,
                  info.ip ? hash("healthpass-ip:" + info.ip) : null,
                  "failed_password",
                  now(),
                ],
              );
            }
          })
          .catch(() => {});
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
