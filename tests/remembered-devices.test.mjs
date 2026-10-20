import test from "node:test";
import assert from "node:assert/strict";
import { openTestDatabase } from "./database.mjs";
import { seed } from "../server/seed.mjs";
import { createApi } from "../server/api.mjs";
const password = "synthetic-remembered-device-password";
async function ok(p) {
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function fixture(t) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  await seed(db, password);
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  const client = (email = "doctor@healthpass.test", country = "NG") => {
    const jar = {};
    let location = country;
    let agent = "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0";
    const call = async (path, method = "GET", body) => {
      const response = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method,
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
            cookie: Object.entries(jar)
              .map(([k, v]) => `${k}=${v}`)
              .join("; "),
            "user-agent": agent,
            "x-healthpass-country": location,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      for (const cookie of [
        ...response.headers.getSetCookie(),
        response.headers.get("x-healthpass-device-cookie"),
      ].filter(Boolean)) {
        const [key, value] = cookie.split(";")[0].split("=");
        jar[key] = value;
      }
      return { status: response.status, data: await response.json() };
    };
    return {
      call,
      jar,
      country: (v) => {
        location = v;
      },
      agent: (v) => {
        agent = v;
      },
      login: async () => {
        await ok(
          call("/auth/login", "POST", {
            email,
            password,
            ...(email === "patient@healthpass.test"
              ? { account_type: "patient" }
              : { account_type: "professional", workspace_code: "HP-ORG-LAGOS" }),
          }),
        );
        if (email !== "patient@healthpass.test") {
          await ok(call("/auth/mfa/skip", "POST", {}));
        }
      },
      history: () => ok(call("/account/security")),
    };
  };
  return { db, client };
}
async function remember(c, event) {
  await ok(c.call(`/account/security/events/${event.id}/review`, "POST", {}));
  return ok(
    c.call(`/account/security/events/${event.id}/remember-device`, "POST", { confirmed: true }),
  );
}

test("remembered browsers stay quiet across normal sign-ins and compare location against their own history", async (t) => {
  const { client } = await fixture(t);
  const first = client();
  await first.login();
  const deviceCookie = first.jar.hp_device;
  let event = (await first.history()).events[0];
  await remember(first, event);
  assert.equal((await first.history()).devices.length, 1);
  const second = client("doctor@healthpass.test", "GB");
  await second.login();
  event = (await second.history()).events[0];
  assert.ok(event.risk.includes("new_device"));
  await remember(second, event);
  await ok(first.call("/auth/logout", "POST", {}));
  await first.login();
  const h = await first.history();
  assert.equal(first.jar.hp_device, deviceCookie);
  assert.equal(h.events[0].risk, "normal");
  assert.equal((await ok(first.call("/notifications"))).counts.security, 0);
  first.country("US");
  await first.login();
  assert.equal((await first.history()).events[0].risk, "country_changed");
  first.agent("Mozilla/5.0 (Linux) Firefox/130.0");
  await first.login();
  assert.ok((await first.history()).events[0].risk.includes("device_changed"));
});

test("remembering requires an explicitly reviewed successful sign-in and cannot cross accounts", async (t) => {
  const { client } = await fixture(t);
  const c = client();
  await c.login();
  const event = (await c.history()).events[0];
  assert.equal(
    (
      await c.call(`/account/security/events/${event.id}/remember-device`, "POST", {
        confirmed: true,
      })
    ).status,
    409,
  );
  await ok(c.call(`/account/security/events/${event.id}/review`, "POST", {}));
  assert.equal(
    (await c.call(`/account/security/events/${event.id}/remember-device`, "POST", {})).status,
    400,
  );
  const other = client("patient@healthpass.test");
  await other.login();
  assert.equal(
    (
      await other.call(`/account/security/events/${event.id}/remember-device`, "POST", {
        confirmed: true,
      })
    ).status,
    404,
  );
  await remember(c, event);
  const d = (await c.history()).devices[0];
  assert.equal(
    (await other.call(`/account/security/devices/${d.id}/forget`, "POST", {})).status,
    404,
  );
  assert.equal(
    (
      await c.call("/auth/login", "POST", {
        email: "doctor@healthpass.test",
        password: "wrong-password",
        account_type: "professional",
        workspace_code: "HP-ORG-LAGOS",
      })
    ).status,
    401,
  );
  const failed = (await c.history()).events.find((e) => e.action === "failed_signin");
  const reviewed = await ok(c.call(`/account/security/events/${failed.id}/review`, "POST", {}));
  assert.equal(reviewed.device, null);
  assert.equal(
    (
      await c.call(`/account/security/events/${failed.id}/remember-device`, "POST", {
        confirmed: true,
      })
    ).status,
    409,
  );
});

test("Not now leaves the event reviewed without remembering; forget requests review again without revoking sessions", async (t) => {
  const { client } = await fixture(t);
  const c = client();
  await c.login();
  const second = client();
  await second.login();
  const e = (await second.history()).events[0];
  const reviewed = await ok(second.call(`/account/security/events/${e.id}/review`, "POST", {}));
  assert.ok(reviewed.device);
  assert.equal((await second.history()).devices.length, 0);
  assert.equal((await ok(second.call("/notifications"))).counts.security, 0);
  await remember(second, e);
  const d = (await second.history()).devices[0];
  await ok(second.call(`/account/security/devices/${d.id}/forget`, "POST", {}));
  assert.equal((await second.history()).devices.length, 0);
  assert.equal((await second.call("/auth/me")).status, 200);
  await second.login();
  assert.ok((await second.history()).events[0].risk.includes("new_device"));
});

test("recognition never replaces credentials, idle expiry or mandatory thirty-day authentication", async (t) => {
  const { client, db } = await fixture(t);
  const c = client("patient@healthpass.test");
  await c.login();
  await remember(c, (await c.history()).events[0]);
  const cookie = c.jar.hp_device;
  delete c.jar.hp_session;
  assert.equal((await c.call("/auth/me")).status, 401);
  assert.equal(c.jar.hp_device, cookie);
  await c.login();
  await db.transaction((tx) =>
    tx.run("UPDATE sessions SET last_seen_at=? WHERE user_id='patient-user'", [
      new Date(Date.now() - 31 * 60000).toISOString(),
    ]),
  );
  assert.equal((await c.call("/auth/me")).status, 401);
  await c.login();
  await ok(c.call("/account/security", "PATCH", { eight_hour_limit: false }));
  await db.transaction((tx) =>
    tx.run("UPDATE sessions SET created_at=?,expires_at=? WHERE user_id='patient-user'", [
      new Date(Date.now() - 31 * 86400000).toISOString(),
      new Date(Date.now() - 1000).toISOString(),
    ]),
  );
  assert.equal((await c.call("/auth/me")).status, 401);
  delete c.jar.hp_device;
  await c.login();
  assert.ok((await c.history()).events[0].risk.includes("new_device"));
});
