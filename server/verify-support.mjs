import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { openDatabase } from "./db.mjs";
const { values } = parseArgs({
  options: {
    "user-id": { type: "string" },
    "review-reference": { type: "string" },
    "confirm-zed-tech-employment": { type: "boolean", default: false },
    revoke: { type: "boolean", default: false },
  },
});
if (
  !values["user-id"] ||
  !values["review-reference"] ||
  (!values.revoke && !values["confirm-zed-tech-employment"])
)
  throw new Error(
    "Use --user-id ID --review-reference REFERENCE and --confirm-zed-tech-employment, or --revoke. This is an operator-only identity review.",
  );
const db = await openDatabase();
try {
  await db.transaction(async (tx) => {
    const user = await tx.get("SELECT id,patient_id,account_scope FROM users WHERE id=?", [
      values["user-id"],
    ]);
    if (!user || user.patient_id || user.account_scope === "patient")
      throw new Error("Choose an existing professional identity.");
    await tx.run("UPDATE users SET provider_support_verified=? WHERE id=?", [
      values.revoke ? 0 : 1,
      user.id,
    ]);
    await tx.run(
      "INSERT INTO audits(id,organization_id,resource_id,action,decision,purpose,created_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)",
      [
        randomUUID(),
        user.account_scope,
        user.id,
        values.revoke ? "support.identity_revoked" : "support.identity_verified",
        "allow",
        String(values["review-reference"]).slice(0, 500),
        new Date().toISOString(),
        randomUUID(),
      ],
    );
  });
  console.log(
    "Zed Tech support identity review recorded. Facility approval and an expiring support grant are still required.",
  );
} finally {
  await db.close();
}
