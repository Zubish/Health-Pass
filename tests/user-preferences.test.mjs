import test from "node:test";
import assert from "node:assert/strict";
import { openTestDatabase } from "./database.mjs";
import { seed } from "../server/seed.mjs";
import { createApi } from "../server/api.mjs";

test("preferences persist for the signed-in user, validate values, and do not change another account", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  await seed(db, "synthetic-preferences-password");
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  let cookie = "";
  async function request(path, method = "GET", body) {
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
  }
  assert.equal((await request("/account/preferences")).status, 401);
  assert.equal(
    (
      await request("/auth/login", "POST", {
        email: "patient@healthpass.test",
        password: "synthetic-preferences-password",
        account_type: "patient",
      })
    ).status,
    200,
  );
  assert.deepEqual((await request("/account/preferences")).data.preferences, {
    theme: "system",
    soundEnabled: true,
  });
  assert.equal(
    (await request("/account/preferences", "PATCH", { theme: "invalid", soundEnabled: false }))
      .status,
    400,
  );
  assert.equal(
    (await request("/account/preferences", "PATCH", { theme: "dark", soundEnabled: "false" }))
      .status,
    400,
  );
  assert.equal(
    (
      await request("/account/preferences", "PATCH", {
        theme: "dark",
        soundEnabled: false,
        user_id: "doctor-lagos",
      })
    ).status,
    200,
  );
  assert.deepEqual((await request("/auth/me")).data.preferences, {
    theme: "dark",
    soundEnabled: false,
  });
  const other = await db.transaction((tx) =>
    tx.get("SELECT theme,sound_enabled FROM users WHERE id='doctor-lagos'"),
  );
  assert.deepEqual({ ...other }, { theme: "system", sound_enabled: 1 });
  await request("/auth/logout", "POST", {});
  await request("/auth/login", "POST", {
    email: "patient@healthpass.test",
    password: "synthetic-preferences-password",
    account_type: "patient",
  });
  assert.deepEqual((await request("/account/preferences")).data.preferences, {
    theme: "dark",
    soundEnabled: false,
  });
});
