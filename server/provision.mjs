import { createDefaultRoles } from "./roles.mjs";
import { parseArgs } from "node:util";
import { randomUUID, randomBytes } from "node:crypto";
import { openDatabase } from "./db.mjs";
import { passwordHash } from "./security.mjs";
const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    facility: { type: "string" },
    role: { type: "string" },
    verified: { type: "boolean", default: false },
  },
});
if (
  !values.email ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) ||
  !values.name ||
  !values.facility ||
  !["clinician", "reception", "administrator"].includes(values.role)
) {
  throw new Error(
    "Usage: npm run provision -- --email EMAIL --name NAME --facility FACILITY --role clinician|reception|administrator [--verified]",
  );
}
const password = process.env.HEALTHPASS_PROVISION_PASSWORD;
if (!password || password.length < 12) {
  throw new Error(
    "Supply HEALTHPASS_PROVISION_PASSWORD through a private server environment, at least 12 characters.",
  );
}
const db = await openDatabase();
try {
  await db.transaction(async (tx) => {
    const email = values.email.trim().toLowerCase();
    const org = randomUUID();
    const user = randomUUID();
    // Explicit operator review establishes verification; no external credential service is claimed.
    const code = "HP-" + randomBytes(6).toString("hex").toUpperCase();
    const branch = randomUUID();
    await tx.run("INSERT INTO organizations(id,name,workspace_code) VALUES (?,?,?)", [
      org,
      values.facility.trim(),
      code,
    ]);
    await tx.run("INSERT INTO branches(id,organization_id,name) VALUES (?,?,?)", [
      branch,
      org,
      "Main branch",
    ]);
    await tx.run(
      "INSERT INTO users(id,email,login_email,account_scope,workspace_auth,name,password_hash,verified) VALUES (?,?,?,?,1,?,?,?)",
      [
        user,
        user + "@identity.healthpass.invalid",
        email,
        org,
        values.name.trim(),
        passwordHash(password),
        values.verified ? 1 : 0,
      ],
    );
    await tx.run(
      "INSERT INTO memberships(id,user_id,organization_id,role,branch_id) VALUES (?,?,?,?,?)",
      [randomUUID(), user, org, values.role, values.role === "administrator" ? null : branch],
    );
    await createDefaultRoles(tx, org);
    await tx.run(
      "INSERT INTO membership_roles(membership_id,role_id) SELECT id,? FROM memberships WHERE user_id=?",
      ["role-" + org + "-" + values.role, user],
    );
    if (values.role === "administrator") {
      await tx.run("UPDATE memberships SET is_owner=1 WHERE user_id=?", [user]);
    }
    if (values.role === "clinician" && values.verified) {
      await tx.run(
        "UPDATE memberships SET clinical_verified=1,clinical_scopes='[\"general\"]',clinical_review_reference='Operator reviewed clinical credentials' WHERE user_id=?",
        [user],
      );
    }
    console.log("Workspace code:", code);
    await tx.run(
      "INSERT INTO audits(id,actor_id,organization_id,resource_id,action,decision,purpose,created_at,correlation_id) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        randomUUID(),
        null,
        org,
        user,
        "membership.operator_provision",
        "allow",
        values.verified
          ? "Operator confirmed reviewed professional verification"
          : "Pending operator verification",
        new Date().toISOString(),
        randomUUID(),
      ],
    );
  });
  console.log("Facility and professional account provisioned. No credential values are logged.");
} finally {
  await db.close();
}
