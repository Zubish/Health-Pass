import { canManageWorkspaceLogo, normalizeWorkspaceLogo } from "./workspace-logo.mjs";
import {
  createDefaultRoles,
  hasPermission,
  permissionCatalog,
  roleTemplates,
  clinicalPermissions,
} from "./roles.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { passwordHash } from "./security.mjs";

export function workspaceRoutes({ fail, text, emailValue, audit, makeSession, cookie, strong }) {
  const fields = (body) => {
    const email = emailValue(body.email);
    const name = text(body.name, "full name", 160, true);
    const password = text(body.password, "password", 256, true);
    if (password.length < 12) {
      fail(400, "Use a password of at least 12 characters.");
    }
    return { email, name, password };
  };
  return async (tx, path, method, body, actor, correlation, headers) => {
    if (/^\/workspace\/members\/[^/]+\/restrictions$/.test(path)) {
      return undefined;
    }
    if (path === "/auth/facility-register" && method === "POST") {
      const { email, name, password } = fields(body);
      const facility = text(body.facility_name, "facility name", 160, true);
      const type = text(body.facility_type, "facility type", 80, true);
      if (!["hospital", "clinic", "therapy", "other"].includes(type)) {
        fail(400, "Choose a facility type.");
      }
      if (body.authority !== "confirmed") {
        fail(400, "Confirm that you are authorized to create this facility workspace.");
      }
      const org = randomUUID();
      const user = randomUUID();
      const branch = randomUUID();
      const code = "HP-" + randomBytes(6).toString("hex").toUpperCase();
      await tx.run(
        "INSERT INTO organizations(id,name,workspace_code,facility_type,address) VALUES (?,?,?,?,?)",
        [org, facility, code, type, text(body.address ?? "", "facility address", 500, true)],
      );
      await tx.run("INSERT INTO branches(id,organization_id,name,address) VALUES (?,?,?,?)", [
        branch,
        org,
        text(body.branch_name, "initial branch name", 160, true),
        text(body.address ?? "", "facility address", 500, true),
      ]);
      await createDefaultRoles(tx, org);
      // Workspace ownership grants administrative management only, never a clinical role.
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,workspace_auth,name,password_hash,verified) VALUES (?,?,?,?,1,?,?,1)",
        [user, user + "@identity.healthpass.invalid", email, org, name, passwordHash(password)],
      );
      await tx.run(
        "INSERT INTO memberships(id,user_id,organization_id,role,is_owner) VALUES (?,?,?,?,1)",
        [randomUUID(), user, org, "administrator"],
      );
      await tx.run(
        "INSERT INTO membership_roles(membership_id,role_id) SELECT id,? FROM memberships WHERE user_id=? AND organization_id=?",
        ["role-" + org + "-administrator", user, org],
      );
      const owner = await tx.get("SELECT * FROM users WHERE id=?", [user]);
      headers.set("set-cookie", cookie(await makeSession(tx, owner)));
      await audit(
        tx,
        { id: user, organization_id: org },
        "workspace.created",
        "allow",
        null,
        org,
        correlation,
      );
      return { created: true, workspace_code: code };
    }
    if (path === "/auth/workspace-register" && method === "POST") {
      const { email, name, password } = fields(body);
      const code = text(body.workspace_code, "workspace code", 80, true).toUpperCase();
      const org = await tx.get("SELECT id FROM organizations WHERE workspace_code=?", [code]);
      if (!org) {
        fail(400, "Check the workspace code with your facility administrator.");
      }
      if (
        await tx.get(
          "SELECT id FROM users WHERE COALESCE(login_email,email)=? AND account_scope=?",
          [email, org.id],
        )
      ) {
        fail(409, "An account already exists in this workspace. Sign in instead.");
      }
      const user = randomUUID();
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,workspace_auth,name,password_hash,profession,registration_number) VALUES (?,?,?,?,1,?,?,?,?)",
        [
          user,
          user + "@identity.healthpass.invalid",
          email,
          org.id,
          name,
          passwordHash(password),
          text(body.profession, "profession", 100, true),
          text(body.registration_number ?? "", "professional registration", 160),
        ],
      );
      await tx.run(
        "INSERT INTO memberships(id,user_id,organization_id,role,active) VALUES (?,?,?,?,0)",
        [randomUUID(), user, org.id, "reception"],
      );
      await tx.run(
        "INSERT INTO membership_roles(membership_id,role_id) SELECT id,? FROM memberships WHERE user_id=? AND organization_id=?",
        ["role-" + org.id + "-reception", user, org.id],
      );
      headers.set(
        "set-cookie",
        cookie(await makeSession(tx, await tx.get("SELECT * FROM users WHERE id=?", [user]))),
      );
      await audit(
        tx,
        { id: user, organization_id: org.id },
        "membership.requested",
        "allow",
        null,
        user,
        correlation,
      );
      return { requested: true };
    }
    if (!path.startsWith("/workspace/")) {
      return undefined;
    }
    strong(actor);
    if (!actor.organization_id) {
      fail(403, "A facility workspace is required.");
    }
    const org = actor.organization_id;
    const requirePermission = (permission) => {
      if (!hasPermission(actor, permission)) {
        fail(403, "This action is not permitted by your workspace roles.");
      }
    };
    if (path === "/workspace/logo") {
      if (method === "GET") {
        const row = await tx.get("SELECT image_data FROM workspace_logos WHERE organization_id=?", [
          org,
        ]);
        return { logo: row?.image_data ?? null };
      }
      if (method === "POST") {
        if (!canManageWorkspaceLogo(actor, hasPermission)) {
          fail(403, "Only a workspace administrator can change the facility logo.");
        }
        if (body.logo === null) {
          await tx.run("DELETE FROM workspace_logos WHERE organization_id=?", [org]);
        } else {
          const logo = normalizeWorkspaceLogo(body.logo, fail);
          await tx.run(
            "INSERT INTO workspace_logos(organization_id,image_data,updated_at) VALUES (?,?,?) ON CONFLICT(organization_id) DO UPDATE SET image_data=excluded.image_data,updated_at=excluded.updated_at",
            [org, logo, new Date().toISOString()],
          );
        }
        await audit(
          tx,
          actor,
          body.logo === null ? "workspace.logo.removed" : "workspace.logo.updated",
          "allow",
          null,
          org,
          correlation,
        );
        return { saved: true };
      }
    }
    if (path === "/workspace/settings" && method === "GET") {
      requirePermission("workspace.view");
      return {
        organization: await tx.get(
          "SELECT id,name,workspace_code,facility_type,address FROM organizations WHERE id=?",
          [org],
        ),
        branches: await tx.all(
          "SELECT id,name,address,active FROM branches WHERE organization_id=? ORDER BY name",
          [org],
        ),
        roles: await tx.all("SELECT * FROM workspace_roles WHERE organization_id=? ORDER BY name", [
          org,
        ]),
        areas: await tx.all(
          "SELECT a.*,b.name AS branch_name FROM care_areas a JOIN branches b ON b.id=a.branch_id WHERE a.organization_id=? AND (CAST(? AS TEXT) IS NULL OR a.branch_id=?) ORDER BY a.name LIMIT 200",
          [org, actor.branch_id ?? null, actor.branch_id ?? null],
        ),
        permissionCatalog,
        templates: roleTemplates.filter((r) => r.key !== "clinician"),
        members: hasPermission(actor, "staff.manage")
          ? await tx.all(
              "SELECT m.*,u.name,COALESCE(u.login_email,u.email) AS email,u.profession,u.registration_number,u.verified,u.provider_support_verified FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? ORDER BY u.name",
              [org],
            )
          : [],
        assignments: hasPermission(actor, "staff.manage")
          ? await tx.all(
              "SELECT mr.* FROM membership_roles mr JOIN memberships m ON m.id=mr.membership_id WHERE m.organization_id=?",
              [org],
            )
          : [],
      };
    }
    const roleMatch = path.match(/^\/workspace\/roles\/([^/]+)$/);
    if ((path === "/workspace/roles" && method === "POST") || (roleMatch && method === "PATCH")) {
      requirePermission("roles.manage");
      const existing = roleMatch
        ? await tx.get("SELECT * FROM workspace_roles WHERE id=? AND organization_id=?", [
            roleMatch[1],
            org,
          ])
        : null;
      if (roleMatch && !existing) {
        fail(404, "Role unavailable.");
      }
      const name = text(body.name, "role name", 100, true);
      const duplicate = await tx.get(
        "SELECT id FROM workspace_roles WHERE organization_id=? AND LOWER(name)=LOWER(?) AND id<>?",
        [org, name, existing?.id ?? ""],
      );
      if (duplicate) {
        fail(409, "A role with this name already exists in your workspace.");
      }
      if (
        !Array.isArray(body.permissions) ||
        body.permissions.some((key) => !permissionCatalog.some((p) => p.key === key))
      ) {
        fail(400, "Choose permissions supported by HealthPass.");
      }
      const permissions = [...new Set(body.permissions)];
      const template =
        existing?.template_key ??
        (roleTemplates.some((t) => t.key === body.template_key) ? body.template_key : null);
      if (template === "zed-support" && permissions.some((key) => key !== "workspace.view")) {
        fail(400, "Zed Tech support roles only permit workspace information access.");
      }
      const scope = permissions.some((key) => clinicalPermissions.has(key))
        ? body.clinical_scope
        : null;
      if (
        scope &&
        !["general", "nursing", "medication", "laboratory", "radiology"].includes(scope)
      ) {
        fail(400, "Choose a supported clinical scope.");
      }
      if (permissions.some((key) => clinicalPermissions.has(key)) && !scope) {
        fail(400, "Clinical permissions require a clinical scope.");
      }
      const dependencies = {
        "diagnostics.order": "records.view",
        "laboratory.work": "records.view",
        "laboratory.report": "laboratory.work",
        "laboratory.release": "laboratory.report",
        "radiology.work": "records.view",
        "radiology.report": "radiology.work",
        "radiology.release": "radiology.report",
        "pharmacy.review": "records.view",
        "pharmacy.fulfil": "pharmacy.review",
        "admissions.decide": "records.view",
        "prescriptions.create": "records.view",
        "medication.administer": "records.view",
        "ward.observations": "records.view",
        "areas.manage": "workspace.view",
        "referrals.create": "records.view",
        "referrals.respond": "records.view",
        "careteam.view": "registry.view",
        "registry.create": "registry.view",
        "visits.view": "registry.view",
        "visits.manage": "visits.view",
        "visits.document": "records.view",
        "observations.create": "records.view",
        "followups.manage": "records.view",
        "records.view": "registry.view",
        "profile.edit": "records.view",
        "notes.create": "records.view",
        "notes.edit": "records.view",
        "notes.sign": "records.view",
        "notes.amend": "records.view",
        "audit.manage": "audit.view",
        "roles.manage": "workspace.view",
        "staff.manage": "workspace.view",
        "branches.manage": "workspace.view",
      };
      for (const [key, required] of Object.entries(dependencies)) {
        if (permissions.includes(key) && !permissions.includes(required)) {
          fail(400, `The ${key} permission also requires ${required}.`);
        }
      }
      const id = existing?.id ?? randomUUID();
      const description = text(body.description ?? "", "role description", 500);
      if (existing) {
        await tx.run(
          "UPDATE workspace_roles SET name=?,description=?,clinical_scope=?,permissions=?,active=? WHERE id=? AND organization_id=?",
          [
            name,
            description,
            scope,
            JSON.stringify(permissions),
            body.active === false ? 0 : 1,
            id,
            org,
          ],
        );
      } else {
        await tx.run(
          "INSERT INTO workspace_roles(id,organization_id,name,description,template_key,clinical_scope,permissions) VALUES (?,?,?,?,?,?,?)",
          [id, org, name, description, template, scope, JSON.stringify(permissions)],
        );
      }
      await audit(
        tx,
        actor,
        existing ? "role.updated" : "role.created",
        "allow",
        null,
        id,
        correlation,
        null,
        JSON.stringify({
          before: existing
            ? {
                name: existing.name,
                permissions: JSON.parse(existing.permissions),
                scope: existing.clinical_scope,
                active: existing.active,
              }
            : null,
          after: { name, permissions, scope, active: body.active !== false },
        }),
      );
      return { id };
    }
    if (path === "/workspace/branches" && method === "POST") {
      requirePermission("branches.manage");
      const id = randomUUID();
      await tx.run("INSERT INTO branches(id,organization_id,name,address) VALUES (?,?,?,?)", [
        id,
        org,
        text(body.name, "branch name", 160, true),
        text(body.address ?? "", "branch address", 500),
      ]);
      await audit(tx, actor, "branch.created", "allow", null, id, correlation);
      return { id };
    }
    const match = path.match(/^\/workspace\/members\/([^/]+)$/);
    if (match && method === "PATCH") {
      requirePermission("staff.manage");
      const member = await tx.get("SELECT * FROM memberships WHERE id=? AND organization_id=?", [
        match[1],
        org,
      ]);
      if (!member) {
        fail(404, "Membership unavailable.");
      }
      if (member.user_id === actor.id) {
        fail(400, "Your own administrator membership cannot be changed here.");
      }
      if (body.action === "suspend") {
        if (member.is_owner) {
          fail(400, "The workspace creator cannot be suspended through staff role management.");
        }
        await tx.run("UPDATE memberships SET active=0 WHERE id=?", [member.id]);
        await audit(tx, actor, "membership.suspended", "allow", null, member.id, correlation);
        return { updated: true };
      }
      const roleIds =
        body.role_ids ??
        (["clinician", "reception", "administrator"].includes(body.role)
          ? ["role-" + org + "-" + body.role]
          : []);
      if (!Array.isArray(roleIds) || !roleIds.length || roleIds.length > 10) {
        fail(400, "Choose one or more workspace job roles.");
      }
      const selected = [];
      for (const id of [...new Set(roleIds)]) {
        const role = await tx.get(
          "SELECT * FROM workspace_roles WHERE id=? AND organization_id=? AND active=1",
          [id, org],
        );
        if (!role) {
          fail(400, "Choose active roles from this workspace.");
        }
        selected.push(role);
      }
      const branch = await tx.get(
        "SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1",
        [body.branch_id, org],
      );
      if (!branch) {
        fail(400, "Choose an active branch in this workspace.");
      }
      const reference = text(body.review_reference, "verification review reference", 500, true);
      if (body.verified !== "confirmed") {
        fail(400, "Confirm the staff identity review.");
      }
      const scopes = [
        ...new Set(
          selected
            .filter((r) => JSON.parse(r.permissions).some((key) => clinicalPermissions.has(key)))
            .map((r) => r.clinical_scope),
        ),
      ];
      let clinicalReference = "";
      if (scopes.length) {
        if (body.role_ids && body.clinical_verified !== "confirmed") {
          fail(400, "Clinical permissions require an explicit professional credential review.");
        }
        clinicalReference = text(
          body.clinical_review_reference ?? (!body.role_ids ? reference : ""),
          "clinical credential review reference",
          500,
          true,
        );
      }
      const consultantRole = selected.some((r) =>
        JSON.parse(r.permissions).includes("referrals.respond"),
      );
      let consultantReview = "";
      if (consultantRole) {
        if (body.consultant_verified !== "confirmed") {
          fail(
            400,
            "Confirm that consultant qualifications have been reviewed for the intended services.",
          );
        }
        consultantReview = text(
          body.consultant_review_reference,
          "consultant qualification review reference",
          500,
          true,
        );
      }
      const support = selected.some((r) => r.template_key === "zed-support");
      let expiry = null;
      if (body.access_expires_at) {
        const parsed = Date.parse(body.access_expires_at);
        if (!Number.isFinite(parsed) || parsed <= Date.now()) {
          fail(400, "Choose a future access expiry.");
        }
        expiry = new Date(parsed).toISOString();
      }
      if (support) {
        const user = await tx.get("SELECT provider_support_verified FROM users WHERE id=?", [
          member.user_id,
        ]);
        if (!user.provider_support_verified) {
          fail(400, "Zed Tech support identity must first be verified by the platform operator.");
        }
        if (selected.length !== 1) {
          fail(400, "Support access cannot be combined with other roles.");
        }
        if (!expiry || Date.parse(expiry) > Date.now() + 24 * 60 * 60 * 1000) {
          fail(400, "Support access requires an expiry within 24 hours.");
        }
      }
      const legacy = scopes.length
        ? "clinician"
        : selected.some((r) =>
              JSON.parse(r.permissions).some((p) => ["roles.manage", "staff.manage"].includes(p)),
            )
          ? "administrator"
          : "reception";
      await tx.run(
        "UPDATE memberships SET active=1,role=?,branch_id=?,review_reference=?,clinical_verified=?,clinical_scopes=?,clinical_review_reference=?,access_expires_at=?,consultant_verified=?,consultant_review_reference=? WHERE id=?",
        [
          legacy,
          branch.id,
          reference,
          scopes.length ? 1 : 0,
          JSON.stringify(scopes),
          clinicalReference,
          expiry,
          consultantRole ? 1 : 0,
          consultantReview,
          member.id,
        ],
      );
      await tx.run("DELETE FROM membership_roles WHERE membership_id=?", [member.id]);
      for (const role of selected) {
        await tx.run("INSERT INTO membership_roles(membership_id,role_id) VALUES (?,?)", [
          member.id,
          role.id,
        ]);
      }
      await tx.run("UPDATE users SET verified=1 WHERE id=?", [member.user_id]);
      if (support) {
        await audit(
          tx,
          actor,
          "support.granted",
          "allow",
          null,
          member.id,
          correlation,
          null,
          JSON.stringify({ roles: selected.map((r) => r.id), expires_at: expiry }),
        );
      }
      await audit(
        tx,
        actor,
        "membership.approved",
        "allow",
        null,
        member.id,
        correlation,
        null,
        JSON.stringify({
          roles: selected.map((r) => r.id),
          branch: branch.id,
          clinical_scopes: scopes,
          clinical_verified: !!scopes.length,
          consultant_verified: consultantRole,
          consultant_review_reference: consultantReview,
          expires_at: expiry,
        }),
      );
      return { updated: true };
    }
    fail(404, "Workspace operation unavailable.");
  };
}
