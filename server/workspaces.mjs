import { randomBytes, randomUUID } from "node:crypto";
import { passwordHash } from "./security.mjs";

export function workspaceRoutes({ fail, text, emailValue, audit, makeSession, cookie, strong }) {
  const fields = (body) => {
    const email = emailValue(body.email),
      name = text(body.name, "full name", 160, true);
    const password = text(body.password, "password", 256, true);
    if (password.length < 12) fail(400, "Use a password of at least 12 characters.");
    return { email, name, password };
  };
  return async (tx, path, method, body, actor, correlation, headers) => {
    if (path === "/auth/facility-register" && method === "POST") {
      const { email, name, password } = fields(body);
      const facility = text(body.facility_name, "facility name", 160, true);
      const type = text(body.facility_type, "facility type", 80, true);
      if (!["hospital", "clinic", "therapy", "other"].includes(type))
        fail(400, "Choose a facility type.");
      if (body.authority !== "confirmed")
        fail(400, "Confirm that you are authorized to create this facility workspace.");
      const org = randomUUID(),
        user = randomUUID(),
        branch = randomUUID();
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
      // Workspace ownership grants administrative management only, never a clinical role.
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,workspace_auth,name,password_hash,verified) VALUES (?,?,?,?,1,?,?,1)",
        [user, user + "@identity.healthpass.invalid", email, org, name, passwordHash(password)],
      );
      await tx.run("INSERT INTO memberships(id,user_id,organization_id,role) VALUES (?,?,?,?)", [
        randomUUID(),
        user,
        org,
        "administrator",
      ]);
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
      if (!org) fail(400, "Check the workspace code with your facility administrator.");
      if (
        await tx.get(
          "SELECT id FROM users WHERE COALESCE(login_email,email)=? AND account_scope=?",
          [email, org.id],
        )
      )
        fail(409, "An account already exists in this workspace. Sign in instead.");
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
    if (!path.startsWith("/workspace/")) return undefined;
    strong(actor);
    if (!actor.organization_id) fail(403, "A facility workspace is required.");
    if (actor.role !== "administrator")
      fail(403, "Only a workspace administrator can manage branches and membership.");
    const org = actor.organization_id;
    if (path === "/workspace/settings" && method === "GET")
      return {
        organization: await tx.get(
          "SELECT id,name,workspace_code,facility_type,address FROM organizations WHERE id=?",
          [org],
        ),
        branches: await tx.all(
          "SELECT id,name,address,active FROM branches WHERE organization_id=? ORDER BY name",
          [org],
        ),
        members: await tx.all(
          "SELECT m.id,m.role,m.active,m.branch_id,u.name,COALESCE(u.login_email,u.email) AS email,u.profession,u.registration_number,u.verified FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=? ORDER BY u.name",
          [org],
        ),
      };
    if (path === "/workspace/branches" && method === "POST") {
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
      const member = await tx.get("SELECT * FROM memberships WHERE id=? AND organization_id=?", [
        match[1],
        org,
      ]);
      if (!member) fail(404, "Membership unavailable.");
      if (member.user_id === actor.id)
        fail(400, "Your own administrator membership cannot be changed here.");
      if (body.action === "suspend") {
        await tx.run("UPDATE memberships SET active=0 WHERE id=?", [member.id]);
        await audit(tx, actor, "membership.suspended", "allow", null, member.id, correlation);
        return { updated: true };
      }
      if (!["clinician", "reception", "administrator"].includes(body.role))
        fail(400, "Choose a supported role.");
      const branch = await tx.get(
        "SELECT id FROM branches WHERE id=? AND organization_id=? AND active=1",
        [body.branch_id, org],
      );
      if (!branch) fail(400, "Choose an active branch in this workspace.");
      const reference = text(body.review_reference, "verification review reference", 500, true);
      if (body.verified !== "confirmed")
        fail(400, "Confirm identity and applicable professional credentials have been reviewed.");
      await tx.run(
        "UPDATE memberships SET active=1,role=?,branch_id=?,review_reference=? WHERE id=?",
        [body.role, body.role === "administrator" ? null : branch.id, reference, member.id],
      );
      await tx.run("UPDATE users SET verified=1 WHERE id=?", [member.user_id]);
      await audit(tx, actor, "membership.approved", "allow", null, member.id, correlation);
      return { updated: true };
    }
    fail(404, "Workspace operation unavailable.");
  };
}
