import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { openTestDatabase } from "./database.mjs";
import { seed } from "../server/seed.mjs";
import { createApi } from "../server/api.mjs";

test("facility logos require administrators, remain tenant scoped, reject invalid images, and clear to initials", async (t) => {
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
  const png = new PNG({ width: 8, height: 8 });
  png.data.fill(128);
  const logo = "data:image/png;base64," + PNG.sync.write(png).toString("base64");
  assert.equal((await admin("/auth/me")).data.canManageWorkspaceLogo, true);
  assert.equal((await gp("/auth/me")).data.canManageWorkspaceLogo, false);
  assert.equal((await gp("/workspace/logo", "POST", { logo })).status, 403);
  assert.equal((await patient("/workspace/logo")).status, 403);
  for (const invalid of [
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,AAAA",
    logo.slice(0, -16),
    "a".repeat(610001),
  ]) {
    assert.ok(
      [400, 413].includes((await admin("/workspace/logo", "POST", { logo: invalid })).status),
    );
  }
  assert.equal(
    (await admin("/workspace/logo", "POST", { logo, organization_id: "org-ibadan" })).status,
    200,
  );
  assert.equal((await gp("/workspace/logo")).data.logo, logo);
  assert.equal((await foreign("/workspace/logo")).data.logo, null);
  assert.equal((await gp("/workspace/logo", "POST", { logo: null })).status, 403);
  const adminId = (await admin("/auth/me")).data.user.id;
  await db.transaction((tx) =>
    tx.run("UPDATE memberships SET denied_permissions=? WHERE user_id=?", [
      '["roles.manage"]',
      adminId,
    ]),
  );
  assert.equal((await admin("/auth/me")).data.canManageWorkspaceLogo, false);
  assert.equal((await admin("/workspace/logo", "POST", { logo: null })).status, 403);
  await db.transaction((tx) =>
    tx.run("UPDATE memberships SET denied_permissions='[]' WHERE user_id=?", [adminId]),
  );
  assert.equal((await admin("/workspace/logo", "POST", { logo: null })).status, 200);
  assert.equal((await gp("/workspace/logo")).data.logo, null);
  const audits = await db.transaction((tx) =>
    tx.all("SELECT action FROM audits WHERE action LIKE 'workspace.logo.%'"),
  );
  assert.equal(audits.length, 2);
});
