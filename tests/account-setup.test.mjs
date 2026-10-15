import test from "node:test";
import assert from "node:assert/strict";
import { openTestDatabase } from "./database.mjs";
import { seed } from "../server/seed.mjs";
import { createApi } from "../server/api.mjs";

test("setup respects account roles, persists review/dismissal across sessions and derives primary care completion", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const password = "synthetic-logo-password";
  await seed(db, password);
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  async function client(email, workspace) {
    let cookie = "";
    const call = async (path, method = "GET", body) => {
      const response = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method,
          headers: { origin: "http://localhost:3000", cookie, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      if (response.headers.get("set-cookie")) {
        cookie = response.headers.get("set-cookie").split(";")[0];
      }
      return { status: response.status, data: await response.json() };
    };
    assert.equal(
      (
        await call("/auth/login", "POST", {
          email,
          password,
          account_type: workspace ? "professional" : "patient",
          ...(workspace ? { workspace_code: workspace } : {}),
        })
      ).status,
      200,
    );
    if (workspace) {
      await call("/auth/mfa/skip", "POST", {});
    }
    return call;
  }
  const admin = await client("admin@healthpass.test", "HP-ORG-LAGOS");
  const gp = await client("doctor@healthpass.test", "HP-ORG-LAGOS");
  const foreign = await client("ibadan@healthpass.test", "HP-ORG-IBADAN");
  const patient = await client("patient@healthpass.test");

  let setup = (await patient("/account/setup")).data;
  assert.equal(setup.showAutomatically, true);
  assert.ok(setup.steps.some((step) => step.id === "primary"));
  assert.ok(!setup.steps.some((step) => step.id === "roles" || step.id === "proxy"));
  assert.equal(
    (await patient("/account/setup", "POST", { action: "review", step: "primary" })).status,
    400,
  );
  await patient("/account/setup", "POST", { action: "presented" });
  assert.equal((await patient("/account/setup")).data.showAutomatically, false);
  await patient("/account/setup", "POST", { action: "review", step: "sharing" });
  assert.equal(
    (await patient("/account/setup")).data.steps.find((step) => step.id === "sharing").status,
    "done",
  );
  await patient("/account/setup", "POST", { action: "later" });
  assert.equal((await patient("/account/setup")).data.showAutomatically, false);
  await db.transaction((tx) =>
    tx.run("UPDATE account_setup SET snoozed_until='2000-01-01T00:00:00.000Z'"),
  );
  assert.equal((await patient("/account/setup")).data.showAutomatically, true);
  await patient("/account/setup", "POST", { action: "presented" });
  assert.equal((await patient("/account/setup")).data.showAutomatically, false);
  await patient("/account/setup", "POST", { action: "dismiss", user_id: "doctor-lagos" });
  assert.equal((await patient("/account/setup")).data.dismissed, true);
  const twin = await client("patient@healthpass.test");
  assert.equal((await twin("/account/setup")).data.showAutomatically, false);
  assert.equal((await twin("/account/setup")).data.dismissed, true);
  await Promise.all([
    patient("/account/setup", "POST", { action: "review", step: "profile" }),
    twin("/account/setup", "POST", { action: "review", step: "security" }),
  ]);
  const simultaneous = (await patient("/account/setup")).data;
  assert.ok(
    simultaneous.steps
      .filter((step) => ["profile", "security"].includes(step.id))
      .every((step) => step.status === "done"),
  );
  assert.equal(simultaneous.dismissed, true);

  assert.equal((await gp("/account/setup")).data.dismissed, false);
  assert.ok(!(await gp("/account/setup")).data.steps.some((step) => step.id === "roles"));
  assert.ok((await admin("/account/setup")).data.steps.some((step) => step.id === "roles"));
  assert.equal(
    (await gp("/account/setup", "POST", { action: "review", step: "roles" })).status,
    400,
  );
  assert.equal((await foreign("/account/setup")).data.dismissed, false);
  const id = (await patient("/auth/me")).data.user.patient_id;
  await db.transaction((tx) =>
    tx.run(
      "INSERT INTO primary_care(patient_id,organization_id,source,changed_at) VALUES (?,'org-lagos','first_registration',?) ON CONFLICT(patient_id) DO UPDATE SET organization_id=excluded.organization_id",
      [id, new Date().toISOString()],
    ),
  );
  setup = (await patient("/account/setup")).data;
  assert.equal(setup.steps.find((step) => step.id === "primary").status, "done");
  assert.equal(setup.dismissed, true);
  const gpId = (await gp("/auth/me")).data.user.id;
  await db.transaction((tx) => tx.run("UPDATE memberships SET active=0 WHERE user_id=?", [gpId]));
  await gp("/account/setup", "POST", { action: "presented" });
  await gp("/account/setup", "POST", { action: "later" });
  const waiting = (await gp("/account/setup")).data;
  assert.equal(waiting.pending, true);
  assert.deepEqual(
    waiting.steps.map((step) => step.id),
    ["preferences"],
  );
  assert.equal(
    (await gp("/account/preferences", "PATCH", { theme: "dark", soundEnabled: false })).status,
    200,
  );
  assert.equal((await gp("/account/security")).status, 403);
  assert.equal((await gp("/patients")).status, 403);
  assert.equal(
    (await gp("/account/setup", "POST", { action: "review", step: "department" })).status,
    400,
  );
  await db.transaction((tx) => tx.run("UPDATE memberships SET active=1 WHERE user_id=?", [gpId]));
  assert.equal((await gp("/account/setup")).data.pending, false);
  assert.equal((await gp("/account/setup")).data.showAutomatically, true);
  assert.ok((await gp("/account/setup")).data.steps.some((step) => step.id === "workspace"));
});
