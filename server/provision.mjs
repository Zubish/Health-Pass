import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
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
)
  throw new Error(
    "Usage: npm run provision -- --email EMAIL --name NAME --facility FACILITY --role clinician|reception|administrator [--verified]",
  );
const password = process.env.HEALTHPASS_PROVISION_PASSWORD;
if (!password || password.length < 12)
  throw new Error(
    "Supply HEALTHPASS_PROVISION_PASSWORD through a private server environment, at least 12 characters.",
  );
const db = await openDatabase();
try {
  await db.transaction(async (tx) => {
    const email = values.email.trim().toLowerCase();
    if (await tx.get("SELECT id FROM users WHERE email=?", [email]))
      throw new Error(
        "Account already exists; review memberships through an operator-controlled process.",
      );
    const org = randomUUID(),
      user = randomUUID();
    // Explicit operator review establishes verification; no external credential service is claimed.
    await tx.run("INSERT INTO organizations(id,name) VALUES (?,?)", [org, values.facility.trim()]);
    await tx.run("INSERT INTO users(id,email,name,password_hash,verified) VALUES (?,?,?,?,?)", [
      user,
      email,
      values.name.trim(),
      passwordHash(password),
      values.verified ? 1 : 0,
    ]);
    await tx.run("INSERT INTO memberships(id,user_id,organization_id,role) VALUES (?,?,?,?)", [
      randomUUID(),
      user,
      org,
      values.role,
    ]);
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
