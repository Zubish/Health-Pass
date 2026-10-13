import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { openTestDatabase } from "./database.mjs";
import { createApi } from "../server/api.mjs";
import { seed } from "../server/seed.mjs";
import { totp } from "../server/security.mjs";
const password = "synthetic-test-password-123";
async function fixture() {
  const db = await openTestDatabase();
  await seed(db, password);
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  function client() {
    let cookie = "";
    return async (path, method = "GET", body, options = {}) => {
      const response = await api(
        new Request(`http://localhost:3000/api/healthpass${path}`, {
          method,
          headers: {
            cookie,
            "content-type": "application/json",
            origin: "http://localhost:3000",
            ...options.headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const set = response.headers.get("set-cookie");
      if (set) {
        cookie = set.split(";")[0];
      }
      return { status: response.status, data: await response.json() };
    };
  }
  async function login(email, mfa = true) {
    const request = client();
    assert.equal((await request("/auth/login", "POST", { email, password })).status, 200);
    if (mfa && email !== "patient@healthpass.test") {
      const { data } = await request("/auth/mfa/setup", "POST", {});
      assert.equal(
        (await request("/auth/mfa/verify", "POST", { code: totp(data.secret) })).status,
        200,
      );
    }
    return request;
  }
  return { db, api, client, login };
}
const note = {
  complaint: "Synthetic follow-up",
  history: "Patient-reported history",
  findings: "Observation documented with units in narrative",
  assessment: "Reviewed assessment",
  plan: "Reviewed follow-up plan",
};
test("routine care: durable drafts, conflicts, signing, patient release and immutable amendments", async () => {
  const { db, login } = await fixture();
  try {
    const clinician = await login("doctor@healthpass.test");
    const patient = await login("patient@healthpass.test");
    const { data: created } = await clinician("/encounters", "POST", {
      patient_id: "patient-ade",
      ...note,
    });
    assert.equal(created.version, 1);
    assert.equal(
      (await patient("/patients/patient-ade")).data.encounters.length,
      0,
      "patient must not see drafts",
    );
    assert.equal(
      (await clinician(`/encounters/${created.id}`, "PATCH", { ...note, version: 0 })).status,
      409,
    );
    const saved = await clinician(`/encounters/${created.id}`, "PATCH", { ...note, version: 1 });
    assert.equal(saved.data.version, 2);
    const signed = await clinician(`/encounters/${created.id}/sign`, "POST", { version: 2 });
    assert.equal(signed.data.version, 3);
    const released = await patient("/patients/patient-ade");
    assert.equal(released.data.encounters[0].status, "signed");
    assert.equal(released.data.encounters[0].versions.length, 1);
    assert.equal(
      (await clinician(`/encounters/${created.id}`, "PATCH", { ...note, version: 3 })).status,
      409,
    );
    assert.equal(
      (
        await clinician(`/encounters/${created.id}/amend`, "POST", {
          ...note,
          version: 3,
          reason: "",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await clinician(`/encounters/${created.id}/amend`, "POST", {
          ...note,
          assessment: "Corrected reviewed assessment",
          version: 3,
          reason: "Clarify original wording",
        })
      ).status,
      200,
    );
    const amended = (await patient("/patients/patient-ade")).data.encounters[0];
    assert.equal(amended.versions.length, 2);
    assert.equal(amended.versions[1].payload.assessment, note.assessment);
    assert.equal(amended.versions[0].payload.assessment, "Corrected reviewed assessment");
    assert.ok(amended.versions[0].previous_id);
    await assert.rejects(
      () => db.transaction((tx) => tx.run("UPDATE note_versions SET payload='tampered'")),
      /immutable/,
    );
    await assert.rejects(
      () => db.transaction((tx) => tx.run("DELETE FROM audits")),
      /immutable|append-only/,
    );
    const audit = (await patient("/audit")).data.audits;
    assert.ok(audit.some((a) => a.action === "encounter.sign"));
    assert.ok(audit.some((a) => a.action === "encounter.amend"));
  } finally {
    await db.close();
  }
});
test("scope: MFA, receptionist/admin denial, tenant tampering, consent revocation and expiry", async () => {
  const { db, login, client } = await fixture();
  try {
    const unknown = client();
    assert.equal(
      (await unknown("/auth/login", "POST", { email: "absent@healthpass.test", password })).status,
      401,
    );
    const unverified = client();
    await unverified("/auth/login", "POST", { email: "doctor@healthpass.test", password });
    assert.equal((await unverified("/patients")).status, 403);
    const clinician = await login("doctor@healthpass.test");
    const partner = await login("ibadan@healthpass.test");
    const patient = await login("patient@healthpass.test");
    const reception = await login("reception@healthpass.test");
    const admin = await login("admin@healthpass.test");
    assert.equal((await clinician("/patients/patient-tunde")).status, 403);
    assert.equal((await patient("/patients/patient-tunde")).status, 403);
    assert.equal((await reception("/patients/patient-ade")).status, 403);
    assert.equal((await admin("/patients")).status, 403);
    assert.equal(
      (await reception("/encounters", "POST", { patient_id: "patient-ade", ...note })).status,
      403,
    );
    assert.equal(
      (await patient("/encounters", "POST", { patient_id: "patient-ade", ...note })).status,
      403,
    );
    const create = await clinician("/encounters", "POST", { patient_id: "patient-ade", ...note });
    await clinician(`/encounters/${create.data.id}/sign`, "POST", { version: 1 });
    assert.equal((await partner("/patients/patient-ade")).status, 403);
    const grant = await patient("/consents", "POST", {
      recipient_id: "org-ibadan",
      purpose: "Synthetic follow-up",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(grant.status, 200);
    assert.equal((await partner("/patients/patient-ade")).data.encounters.length, 1);
    assert.equal(
      (
        await partner(`/encounters/${create.data.id}/amend`, "POST", {
          ...note,
          version: 2,
          reason: "not mine",
        })
      ).status,
      403,
    );
    const partnerDraft = await partner("/encounters", "POST", {
      patient_id: "patient-ade",
      ...note,
    });
    assert.equal(partnerDraft.status, 200);
    // Presence of local care must not reveal a partner's signed chart without consent.
    await partner(`/encounters/${partnerDraft.data.id}/sign`, "POST", { version: 1 });
    assert.equal((await clinician("/patients/patient-ade")).data.encounters.length, 1);
    assert.equal((await patient("/patients/patient-ade")).data.encounters.length, 2);
    assert.equal((await patient(`/consents/${grant.data.id}/revoke`, "POST", {})).status, 200);
    assert.equal((await partner("/patients/patient-ade")).status, 403);
    assert.equal(
      (await partner(`/encounters/${partnerDraft.data.id}`, "PATCH", { ...note, version: 2 }))
        .status,
      403,
    );
    const expiring = await patient("/consents", "POST", {
      recipient_id: "org-ibadan",
      purpose: "Expiry test",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });
    await db.transaction((tx) =>
      tx.run("UPDATE consents SET expires_at=? WHERE id=?", [
        "2000-01-01T00:00:00.000Z",
        expiring.data.id,
      ]),
    );
    assert.equal((await partner("/patients/patient-ade")).status, 403);
    await db.transaction((tx) =>
      tx.run("UPDATE memberships SET active=0 WHERE user_id='doctor-lagos'"),
    );
    assert.equal((await clinician("/patients")).status, 403);
    const log = (await admin("/audit")).data.audits;
    assert.ok(log.some((a) => a.decision === "deny"));
  } finally {
    await db.close();
  }
});
test("identity, CSRF, unknown history, shared phones, logout and malformed input", async () => {
  const { db, login, client } = await fixture();
  try {
    const doctor = await login("doctor@healthpass.test");
    assert.equal(
      (
        await doctor(
          "/patients",
          "POST",
          { name: "Wrong origin" },
          { headers: { origin: "https://evil.example" } },
        )
      ).status,
      403,
    );
    assert.equal(
      (await doctor("/patients", "POST", { name: "Invalid date", dob: "2020-02-31" })).status,
      400,
    );
    const first = await doctor("/patients", "POST", {
      name: "Synthetic person",
      phone: "shared-phone",
    });
    const second = await doctor("/patients", "POST", {
      name: "Synthetic person",
      phone: "shared-phone",
    });
    assert.notEqual(first.data.id, second.data.id);
    const chart = (await doctor(`/patients/${first.data.id}`)).data;
    assert.equal(chart.patient.dob, null);
    assert.equal(chart.patient.allergy_status, "unknown");
    assert.equal(chart.encounters.length, 0);
    assert.equal(
      (
        await doctor(`/patients/${first.data.id}/profile`, "PATCH", {
          allergy_status: "reviewed",
          allergies: "",
        })
      ).status,
      400,
    );
    const self = client();
    const registered = await self("/auth/register", "POST", {
      email: "synthetic-new@healthpass.test",
      password,
      name: "Synthetic new patient",
      dob: "",
    });
    assert.equal(registered.status, 200);
    const me = await self("/auth/me");
    assert.equal(me.data.role, "patient");
    assert.equal(me.data.organization, null);
    const own = (await self("/patients")).data.patients;
    assert.equal(own.length, 1);
    await self("/auth/logout", "POST", {});
    assert.equal((await self("/patients")).status, 401);
  } finally {
    await db.close();
  }
});
test("concurrent writes cannot silently overwrite drafts or duplicate signing", async () => {
  const { db, login } = await fixture();
  try {
    const doctor = await login("doctor@healthpass.test");
    const { data } = await doctor("/encounters", "POST", { patient_id: "patient-ade", ...note });
    const saves = await Promise.all([
      doctor(`/encounters/${data.id}`, "PATCH", { ...note, plan: "A", version: 1 }),
      doctor(`/encounters/${data.id}`, "PATCH", { ...note, plan: "B", version: 1 }),
    ]);
    assert.deepEqual(saves.map((s) => s.status).sort(), [200, 409]);
    const signs = await Promise.all([
      doctor(`/encounters/${data.id}/sign`, "POST", { version: 2 }),
      doctor(`/encounters/${data.id}/sign`, "POST", { version: 2 }),
    ]);
    assert.deepEqual(signs.map((s) => s.status).sort(), [200, 409]);
    assert.equal(
      (
        await db.transaction((tx) =>
          tx.all("SELECT * FROM note_versions WHERE encounter_id=?", [data.id]),
        )
      ).length,
      1,
    );
  } finally {
    await db.close();
  }
});
test("production fails closed without hosted persistence and HTTPS", async () => {
  await assert.rejects(() => openDatabase({ NODE_ENV: "production" }), /DATABASE_URL/);
  assert.throws(
    () =>
      createApi(
        {},
        {
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://configured",
          PUBLIC_APP_ORIGIN: "http://localhost:3000",
        },
      ),
    /HTTPS/,
  );
});

test("authenticator secrets are encrypted and a code cannot authenticate twice", async () => {
  const db = await openTestDatabase();
  await seed(db, password);
  try {
    const api = createApi(db, {
      PUBLIC_APP_ORIGIN: "http://localhost:3000",
      HEALTHPASS_AUTH_KEY: "a".repeat(64),
    });
    let cookie = "";
    async function call(path, body) {
      const response = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method: "POST",
          headers: { origin: "http://localhost:3000", "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        }),
      );
      if (response.headers.has("set-cookie")) {
        cookie = response.headers.get("set-cookie").split(";")[0];
      }
      return { status: response.status, data: await response.json() };
    }
    await call("/auth/login", { email: "doctor@healthpass.test", password });
    assert.equal(
      (await call("/auth/mfa/verify", { code: totp("") })).status,
      401,
      "no empty-secret bypass",
    );
    const setup = await call("/auth/mfa/setup", {});
    const code = totp(setup.data.secret);
    const stored = await db.transaction((tx) =>
      tx.get("SELECT pending_totp FROM users WHERE id='doctor-lagos'"),
    );
    assert.ok(stored.pending_totp.startsWith("enc:"));
    assert.ok(!stored.pending_totp.includes(setup.data.secret));
    assert.equal((await call("/auth/mfa/verify", { code })).status, 200);
    assert.equal((await call("/auth/mfa/verify", { code })).status, 401);
  } finally {
    await db.close();
  }
});

test("local records and signed audit survive a database restart", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hp-persistence-"));
  const config = { HEALTHPASS_SQLITE_PATH: join(folder, "synthetic.sqlite") };
  let db = await openDatabase(config);
  try {
    await seed(db, password);
    await db.close();
    db = await openDatabase(config);
    const patient = await db.transaction((tx) =>
      tx.get("SELECT healthpass_id,name FROM patients WHERE id='patient-ade'"),
    );
    assert.equal(patient.healthpass_id, "HP-DEMO-001");
    assert.match(patient.name, /synthetic/);
    const version = await db.transaction((tx) =>
      tx.get("SELECT version FROM schema_migrations WHERE version='001'"),
    );
    assert.equal(version.version, "001");
  } finally {
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});
