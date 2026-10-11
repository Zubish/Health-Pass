import test from "node:test";
import assert from "node:assert/strict";
import { openTestDatabase } from "./database.mjs";
import { createApi } from "../server/api.mjs";
import { totp } from "../server/security.mjs";
const password = "synthetic-workspace-password";
async function fixture() {
  const db = await openTestDatabase();
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  function client() {
    let cookie = "";
    return async (path, method = "GET", body) => {
      const r = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method,
          headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      const c = r.headers.get("set-cookie");
      if (c) cookie = c.split(";")[0];
      return { status: r.status, data: await r.json() };
    };
  }
  async function mfa(c) {
    const setup = await c("/auth/mfa/setup", "POST", {});
    assert.equal(setup.status, 200);
    assert.equal(
      (await c("/auth/mfa/verify", "POST", { code: totp(setup.data.secret) })).status,
      200,
    );
  }
  async function facility(name, email = "owner@synthetic.invalid") {
    const c = client();
    const r = await c("/auth/facility-register", "POST", {
      name: "Synthetic Owner",
      email,
      password,
      facility_name: name,
      facility_type: "clinic",
      address: "Synthetic address",
      branch_name: "Main",
      authority: "confirmed",
    });
    assert.equal(r.status, 200);
    await mfa(c);
    return { c, code: r.data.workspace_code };
  }
  return { db, client, mfa, facility };
}
test("facility-scoped credentials permit reused email/password without crossing workspaces or patient identity", async () => {
  const { db, client, facility } = await fixture();
  try {
    const a = await facility("Synthetic A"),
      b = await facility("Synthetic B");
    const ca = await a.c("/auth/me"),
      cb = await b.c("/auth/me");
    assert.notEqual(ca.data.user.id, cb.data.user.id);
    assert.notEqual(ca.data.organization.id, cb.data.organization.id);
    const p = client();
    assert.equal(
      (
        await p("/auth/register", "POST", {
          name: "Synthetic Patient",
          email: "owner@synthetic.invalid",
          password,
        })
      ).status,
      200,
    );
    const login = client();
    assert.equal(
      (
        await login("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "professional",
          workspace_code: a.code,
        })
      ).status,
      200,
    );
    assert.equal((await login("/auth/me")).data.organization.id, ca.data.organization.id);
    const wrong = client();
    assert.equal(
      (
        await wrong("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "professional",
          workspace_code: "HP-NOTREAL",
        })
      ).status,
      401,
    );
    const noCode = client();
    assert.equal(
      (
        await noCode("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "professional",
        })
      ).status,
      400,
    );
    const patient = client();
    assert.equal(
      (
        await patient("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "patient",
        })
      ).status,
      200,
    );
    assert.equal((await patient("/auth/me")).data.organization, null);
    assert.equal(
      (await a.c("/patients")).status,
      403,
      "workspace ownership is not clinical access",
    );
  } finally {
    await db.close();
  }
});
test("codes request access only; reviewed approval, branch scopes and suspension enforce clinical boundaries", async () => {
  const { db, client, mfa, facility } = await fixture();
  try {
    const a = await facility("Synthetic A"),
      b = await facility("Synthetic B", "other-owner@synthetic.invalid");
    const staff = client();
    assert.equal(
      (
        await staff("/auth/workspace-register", "POST", {
          name: "Synthetic clinician",
          email: "staff@synthetic.invalid",
          password,
          workspace_code: a.code,
          profession: "Doctor",
          registration_number: "SYNTHETIC-ONLY",
        })
      ).status,
      200,
    );
    assert.equal((await staff("/auth/me")).data.pendingMembership, true);
    assert.equal((await staff("/patients")).status, 403);
    const settings = (await a.c("/workspace/settings")).data;
    const member = settings.members.find((m) => m.email === "staff@synthetic.invalid");
    const branch = settings.branches[0].id;
    assert.equal(
      (await b.c("/workspace/members/" + member.id, "PATCH", { action: "suspend" })).status,
      404,
    );
    assert.equal(
      (
        await a.c("/workspace/members/" + member.id, "PATCH", {
          role: "clinician",
          branch_id: branch,
          review_reference: "Synthetic review",
        })
      ).status,
      400,
    );
    const foreign = (await b.c("/workspace/settings")).data.branches[0].id;
    assert.equal(
      (
        await a.c("/workspace/members/" + member.id, "PATCH", {
          role: "clinician",
          branch_id: foreign,
          review_reference: "Synthetic review",
          verified: "confirmed",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await a.c("/workspace/members/" + member.id, "PATCH", {
          role: "clinician",
          branch_id: branch,
          review_reference: "Synthetic reviewed credentials",
          verified: "confirmed",
        })
      ).status,
      200,
    );
    assert.equal(
      (await staff("/patients")).status,
      403,
      "approved professionals choose authenticator verification or skip",
    );
    await mfa(staff);
    const patient = await staff("/patients", "POST", { name: "Synthetic branch patient" });
    assert.equal(patient.status, 200);
    assert.equal((await staff("/patients/" + patient.data.id)).status, 200);
    const draft = await staff("/encounters", "POST", {
      patient_id: patient.data.id,
      complaint: "Synthetic branch consultation",
    });
    assert.equal(draft.status, 200);
    assert.equal(
      (await staff("/patients/" + patient.data.id)).data.encounters[0].id,
      draft.data.id,
    );
    const second = (await a.c("/workspace/branches", "POST", { name: "Second branch" })).data.id;
    assert.equal(
      (
        await a.c("/workspace/members/" + member.id, "PATCH", {
          role: "clinician",
          branch_id: second,
          review_reference: "Synthetic reassignment",
          verified: "confirmed",
        })
      ).status,
      200,
    );
    assert.equal((await staff("/patients")).data.patients.length, 0);
    assert.equal((await staff("/patients/" + patient.data.id)).status, 403);
    assert.equal(
      (
        await staff("/encounters/" + draft.data.id, "PATCH", {
          version: draft.data.version,
          complaint: "Synthetic denied change",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await staff("/encounters/" + draft.data.id + "/sign", "POST", {
          version: draft.data.version,
        })
      ).status,
      403,
    );
    assert.equal(
      (await a.c("/workspace/members/" + member.id, "PATCH", { action: "suspend" })).status,
      200,
    );
    assert.equal((await staff("/patients")).status, 403);
    assert.equal((await staff("/auth/me")).data.pendingMembership, true);
  } finally {
    await db.close();
  }
});

test("sessions renew on activity and expire after thirty idle minutes", async () => {
  const { db, client } = await fixture();
  try {
    const c = client();
    assert.equal(
      (
        await c("/auth/register", "POST", {
          name: "Synthetic Idle",
          email: "idle@synthetic.invalid",
          password,
          dob: "1990-01-01",
        })
      ).status,
      200,
    );
    await db.transaction((tx) =>
      tx.run("UPDATE sessions SET last_seen_at=?", [
        new Date(Date.now() - 29 * 60000).toISOString(),
      ]),
    );
    assert.equal((await c("/auth/me")).status, 200);
    const session = await db.transaction((tx) => tx.get("SELECT last_seen_at FROM sessions"));
    assert.ok(Date.now() - Date.parse(session.last_seen_at) < 5000);
    await db.transaction((tx) =>
      tx.run("UPDATE sessions SET last_seen_at=?", [
        new Date(Date.now() - 31 * 60000).toISOString(),
      ]),
    );
    assert.equal((await c("/auth/me")).status, 401);
    assert.equal((await c("/patients")).status, 401);
    assert.equal(
      (
        await c("/auth/login", "POST", {
          email: "idle@synthetic.invalid",
          password,
          account_type: "patient",
        })
      ).status,
      200,
    );
    assert.equal((await c("/auth/me")).status, 200);
  } finally {
    await db.close();
  }
});

test("workspace confirmation identifies only the requested facility without granting access", async () => {
  const { db, client, facility } = await fixture();
  try {
    const a = await facility("Synthetic Confirmation A"),
      b = await facility("Synthetic Confirmation B");
    const anonymous = client();
    const checked = await anonymous("/auth/workspace-check", "POST", {
      workspace_code: a.code.toLowerCase(),
    });
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.data, {
      workspace: { name: "Synthetic Confirmation A", workspace_code: a.code },
    });
    assert.equal((await anonymous("/auth/me")).status, 401);
    assert.equal((await anonymous("/patients")).status, 401);
    const changed = await anonymous("/auth/workspace-check", "POST", { workspace_code: b.code });
    assert.equal(changed.data.workspace.name, "Synthetic Confirmation B");
    assert.equal(
      (await anonymous("/auth/workspace-check", "POST", { workspace_code: "HP-INVALID" })).status,
      400,
    );
    assert.equal((await anonymous("/auth/workspace-check", "POST", {})).status, 400);
  } finally {
    await db.close();
  }
});

test("facility creators can skip unfinished authenticator setup and sign back into their own workspace", async () => {
  const { db, client } = await fixture();
  try {
    const owner = client();
    const created = await owner("/auth/facility-register", "POST", {
      name: "Synthetic Creator",
      email: "creator@synthetic.invalid",
      password,
      facility_name: "Synthetic Creator Facility",
      facility_type: "hospital",
      address: "Synthetic address",
      branch_name: "Main",
      authority: "confirmed",
    });
    assert.equal(created.status, 200);
    const me = await owner("/auth/me");
    assert.equal(me.data.role, "administrator");
    assert.equal(me.data.pendingMembership, false);
    assert.equal(me.data.mfaRequired, true);
    assert.equal((await owner("/auth/mfa/setup", "POST", {})).status, 200);
    assert.equal((await owner("/auth/mfa/skip", "POST", {})).status, 200);
    assert.equal((await owner("/auth/me")).data.mfaRequired, false);
    assert.equal((await owner("/workspace/settings")).status, 200);
    assert.equal(
      (await owner("/patients")).status,
      403,
      "skipping cannot grant administrator clinical access",
    );
    const state = await db.transaction((tx) =>
      tx.get("SELECT mfa_verified,mfa_skipped FROM sessions"),
    );
    assert.deepEqual({ ...state }, { mfa_verified: 0, mfa_skipped: 1 });
    const event = await db.transaction((tx) =>
      tx.get("SELECT action FROM audits WHERE action='auth.mfa_skipped'"),
    );
    assert.equal(event.action, "auth.mfa_skipped");
    assert.equal((await owner("/auth/logout", "POST", {})).status, 200);
    assert.equal((await owner("/auth/mfa/skip", "POST", {})).status, 401);
    assert.equal(
      (
        await owner("/auth/login", "POST", {
          email: "creator@synthetic.invalid",
          password,
          account_type: "professional",
          workspace_code: created.data.workspace_code,
        })
      ).status,
      200,
    );
    assert.equal((await owner("/auth/me")).data.mfaRequired, true, "the choice is session-scoped");
    assert.equal((await owner("/auth/mfa/skip", "POST", {})).status, 200);
    assert.equal((await owner("/workspace/settings")).status, 200);
    await db.transaction((tx) =>
      tx.run("UPDATE sessions SET last_seen_at=?", [
        new Date(Date.now() - 31 * 60000).toISOString(),
      ]),
    );
    assert.equal((await owner("/auth/mfa/skip", "POST", {})).status, 401);
  } finally {
    await db.close();
  }
});
test("optional authenticator choice preserves enrollment and pending membership restrictions", async () => {
  const { db, client, facility } = await fixture();
  try {
    const owner = await facility("Synthetic Enrolled Owner");
    await owner.c("/auth/logout", "POST", {});
    assert.equal(
      (
        await owner.c("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "professional",
          workspace_code: owner.code,
        })
      ).status,
      200,
    );
    assert.equal((await owner.c("/auth/me")).data.mfaEnrolled, true);
    assert.equal((await owner.c("/auth/mfa/skip", "POST", {})).status, 200);
    assert.equal((await owner.c("/auth/me")).data.mfaEnrolled, true);
    assert.equal((await owner.c("/workspace/settings")).status, 200);
    const staff = client();
    assert.equal(
      (
        await staff("/auth/workspace-register", "POST", {
          name: "Synthetic Pending",
          email: "pending@synthetic.invalid",
          password,
          workspace_code: owner.code,
          profession: "Pharmacy Technician",
        })
      ).status,
      200,
    );
    assert.equal((await staff("/auth/mfa/skip", "POST", {})).status, 403);
    assert.equal((await staff("/patients")).status, 403);
    assert.equal((await client()("/auth/mfa/skip", "POST", {})).status, 401);
  } finally {
    await db.close();
  }
});
