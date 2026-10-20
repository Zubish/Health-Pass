import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.mjs";
import { createApi } from "../server/api.mjs";
import { seed } from "../server/seed.mjs";

const password = "synthetic-professional-access-password";
const branch = "main-org-lagos";
const note = {
  complaint: "Synthetic permitted general note",
  assessment: "Synthetic reviewed assessment",
  plan: "Synthetic care plan",
};
const expiry = () => new Date(Date.now() + 2 * 86400000).toISOString();

async function fixture() {
  const db = await openTestDatabase();
  await seed(db, password);
  await db.transaction(async (tx) => {
    await tx.run("UPDATE memberships SET branch_id='main-' || organization_id");
    await tx.run(
      "INSERT INTO branches(id,organization_id,name) VALUES ('second-lagos','org-lagos','Synthetic second branch')",
    );
    for (const [id, email, name, kind, role] of [
      ["colleague", "colleague@synthetic.invalid", "Synthetic colleague", "general", "clinician"],
      ["nurse", "nurse@synthetic.invalid", "Synthetic nurse", "nursing", "nurse"],
    ]) {
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,name,password_hash,verified) SELECT ?,?,?,'org-lagos',?,password_hash,1 FROM users WHERE id='doctor-lagos'",
        [id, email, email, name],
      );
      await tx.run(
        "INSERT INTO memberships(id,user_id,organization_id,role,branch_id,clinical_verified,clinical_scopes,clinical_review_reference) VALUES (?,?,'org-lagos','clinician',?,1,?,'Synthetic reviewed fixture')",
        [id + "-member", id, branch, JSON.stringify([kind])],
      );
      await tx.run("INSERT INTO membership_roles(membership_id,role_id) VALUES (?,?)", [
        id + "-member",
        "role-org-lagos-" + role,
      ]);
    }
  });
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  function client() {
    let cookie = "";
    return async (path, method = "GET", body) => {
      const response = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method,
          headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const updated = response.headers.get("set-cookie");
      if (updated) {
        cookie = updated.split(";")[0];
      }
      return { status: response.status, data: await response.json() };
    };
  }
  async function login(email) {
    const request = client();
    assert.equal((await request("/auth/login", "POST", { email, password })).status, 200);
    if (email !== "patient@healthpass.test") {
      assert.equal((await request("/auth/mfa/skip", "POST", {})).status, 200);
    }
    return request;
  }
  const patient = await login("patient@healthpass.test");
  const doctor = await login("doctor@healthpass.test");
  const partner = await login("ibadan@healthpass.test");
  const colleague = await login("colleague@synthetic.invalid");
  const nurse = await login("nurse@synthetic.invalid");
  const reception = await login("reception@healthpass.test");
  async function grant(recipient = "doctor-lagos", overrides = {}) {
    const body = {
      recipient_user_id: recipient,
      recipient_organization_id: recipient === "doctor-ibadan" ? "org-ibadan" : "org-lagos",
      scopes: ["general"],
      include_profile: false,
      can_contribute: false,
      allow_delegation: false,
      allow_external_delegation: false,
      purpose: "Synthetic named access",
      expires_at: expiry(),
      acknowledge_restriction: true,
      client_request_id: randomUUID(),
      ...overrides,
    };
    return { body, ...(await patient("/professional-access", "POST", body)) };
  }
  async function signed(request, overrides = {}) {
    const created = await request("/encounters", "POST", {
      patient_id: "patient-ade",
      ...note,
      ...overrides,
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.equal(
      (await request(`/encounters/${created.data.id}/sign`, "POST", { version: 1 })).status,
      200,
    );
    return created.data.id;
  }
  async function visit() {
    const checked = await reception("/visits", "POST", {
      patient_id: "patient-ade",
      branch_id: branch,
      assigned_user_id: "doctor-lagos",
      client_request_id: randomUUID(),
    });
    assert.equal(checked.status, 200);
    assert.equal(
      (await doctor(`/visits/${checked.data.id}`, "PATCH", { version: 1, status: "in-progress" }))
        .status,
      200,
    );
    return checked.data.id;
  }
  return {
    db,
    patient,
    doctor,
    partner,
    colleague,
    nurse,
    reception,
    client,
    grant,
    signed,
    visit,
  };
}

function denied(result) {
  assert.equal(result.status, 403, JSON.stringify(result.data));
}
function rejected(result) {
  assert.ok([400, 403, 404, 409].includes(result.status), JSON.stringify(result));
}

test("named restriction immediately overrides facility and consent access without an author bypass or history deletion", async () => {
  const f = await fixture();
  try {
    const original = await f.signed(f.doctor);
    assert.equal(
      (
        await f.patient("/consents", "POST", {
          recipient_id: "org-ibadan",
          purpose: "Synthetic pre-existing facility sharing",
          expires_at: expiry(),
        })
      ).status,
      200,
    );
    assert.equal((await f.partner("/patients/patient-ade")).status, 200);
    const selected = await f.grant("colleague");
    assert.equal(selected.status, 200, JSON.stringify(selected.data));
    assert.equal(selected.data.restricted, true);
    denied(await f.doctor("/patients/patient-ade"));
    denied(await f.partner("/patients/patient-ade"));
    denied(
      await f.doctor(`/encounters/${original}/amend`, "POST", {
        version: 2,
        ...note,
        reason: "Synthetic denied author amendment",
      }),
    );
    assert.ok(
      (await f.reception("/patients")).data.patients.some((p) => p.id === "patient-ade"),
      "operational demographics remain registered",
    );
    assert.equal((await f.colleague("/patients/patient-ade")).data.encounters[0].id, original);
    assert.equal(
      (await f.patient(`/professional-access/${selected.data.id}/revoke`, "POST", {})).status,
      200,
    );
    denied(await f.colleague("/patients/patient-ade"));
    assert.equal(
      (await f.patient("/professional-access")).data.restricted,
      true,
      "final revocation must not restore broad access",
    );
    assert.equal((await f.patient("/patients/patient-ade")).data.encounters[0].id, original);
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT * FROM note_versions WHERE encounter_id=?", [original]),
        )
      ).length,
      1,
    );
  } finally {
    await f.db.close();
  }
});

test("named reads filter complete signed payloads by category and omit clinical profile and draft metadata", async () => {
  const f = await fixture();
  try {
    const general = await f.signed(f.doctor);
    const nursing = await f.signed(f.nurse, {
      note_kind: "nursing",
      complaint: "Synthetic nursing-only content",
    });
    const draft = await f.doctor("/encounters", "POST", {
      patient_id: "patient-ade",
      complaint: "Synthetic private draft marker",
      client_request_id: randomUUID(),
    });
    assert.equal(draft.status, 200);
    const visitId = await f.visit();
    const linked = await f.signed(f.doctor, {
      visit_id: visitId,
      complaint: "Synthetic linked general consultation",
    });
    const selected = await f.grant("colleague", { scopes: ["nursing"] });
    assert.equal(selected.status, 200, JSON.stringify(selected.data));
    const chart = await f.colleague("/patients/patient-ade");
    assert.equal(chart.status, 200);
    assert.deepEqual(
      chart.data.encounters.map((e) => e.id),
      [nursing],
    );
    for (const key of ["phone", "sex", "allergy_status", "allergies", "emergency_contact"]) {
      assert.equal(
        Object.hasOwn(chart.data.patient, key),
        false,
        key + " must be omitted without profile scope",
      );
    }
    assert.ok(!JSON.stringify(chart.data).includes("Synthetic permitted general note"));
    assert.ok(!JSON.stringify(chart.data).includes("Synthetic private draft marker"));
    for (const encounter of chart.data.encounters) {
      assert.equal(Object.hasOwn(encounter, "create_request_payload"), false);
      assert.equal(Object.hasOwn(encounter, "client_request_id"), false);
      assert.ok(
        encounter.versions.every((v) => v.payload.complaint === "Synthetic nursing-only content"),
      );
    }
    const expanded = await f.grant("colleague", { scopes: ["general"], include_profile: true });
    assert.equal(expanded.status, 200);
    const union = await f.colleague("/patients/patient-ade");
    assert.equal(union.status, 200);
    assert.deepEqual(
      new Set(union.data.encounters.map((e) => e.id)),
      new Set([general, nursing, linked]),
    );
    assert.equal(Object.hasOwn(union.data.patient, "allergies"), true);
    const chartReads = await f.db.transaction((tx) =>
      tx.all("SELECT purpose FROM audits WHERE actor_id='colleague' AND action='chart.read'"),
    );
    const unionAudit = chartReads
      .map((row) => JSON.parse(row.purpose))
      .find((entry) => entry.active_professional_grant_ids?.includes(expanded.data.id));
    assert.deepEqual(
      new Set(unionAudit.active_professional_grant_ids),
      new Set([selected.data.id, expanded.data.id]),
    );
    assert.equal(
      Object.hasOwn(unionAudit, "professional_grant_id"),
      false,
      "audit records all active grants rather than misleadingly claiming the first as sole authority",
    );
    const nurseRead = await f.grant("nurse", { scopes: ["general"] });
    assert.equal(nurseRead.status, 200);
    assert.ok(
      (await f.nurse("/patients/patient-ade")).data.encounters.some((e) => e.id === general),
      "reviewed discipline limits contributions rather than category reads",
    );
  } finally {
    await f.db.close();
  }
});

test("read-only named grants deny all clinical writes even for note authors and assigned professionals", async () => {
  const f = await fixture();
  try {
    const signed = await f.signed(f.doctor);
    const visitId = await f.visit();
    const draft = await f.doctor("/encounters", "POST", {
      patient_id: "patient-ade",
      visit_id: visitId,
      ...note,
    });
    assert.equal(draft.status, 200);
    const selected = await f.grant();
    assert.equal(selected.status, 200);
    denied(await f.doctor("/encounters", "POST", { patient_id: "patient-ade", ...note }));
    denied(await f.doctor(`/encounters/${draft.data.id}`, "PATCH", { version: 1, ...note }));
    denied(await f.doctor(`/encounters/${draft.data.id}/sign`, "POST", { version: 1 }));
    denied(
      await f.doctor(`/encounters/${signed}/amend`, "POST", {
        version: 2,
        ...note,
        reason: "Synthetic forbidden rewrite",
      }),
    );
    denied(
      await f.doctor("/patients/patient-ade/profile", "PATCH", {
        allergy_status: "reviewed",
        allergies: "Synthetic denied context",
        emergency_contact: "",
      }),
    );
    denied(
      await f.doctor(`/visits/${visitId}/observations`, "POST", {
        values: { pulse: 72 },
        client_request_id: randomUUID(),
      }),
    );
    denied(
      await f.doctor(`/visits/${visitId}/follow-ups`, "POST", {
        title: "Synthetic forbidden task",
        due_at: expiry(),
        client_request_id: randomUUID(),
      }),
    );
    const wrongDiscipline = await f.grant("doctor-lagos", {
      scopes: ["nursing"],
      can_contribute: true,
    });
    assert.equal(wrongDiscipline.status, 200);
    denied(
      await f.doctor("/encounters", "POST", {
        patient_id: "patient-ade",
        note_kind: "general",
        ...note,
      }),
    );
    const contributing = await f.grant("doctor-lagos", { can_contribute: true });
    assert.equal(contributing.status, 200);
    assert.equal(
      (await f.doctor("/encounters", "POST", { patient_id: "patient-ade", ...note })).status,
      200,
    );
    const profileReadOnly = await f.grant("doctor-lagos", { include_profile: true });
    assert.equal(profileReadOnly.status, 200);
    assert.equal(
      Object.hasOwn((await f.doctor("/patients/patient-ade")).data.patient, "allergies"),
      true,
    );
    denied(
      await f.doctor("/patients/patient-ade/profile", "PATCH", {
        allergy_status: "reviewed",
        allergies: "Synthetic still outside scope",
        emergency_contact: "",
      }),
    );
    const writableProfile = await f.grant("doctor-lagos", {
      include_profile: true,
      can_contribute: true,
    });
    assert.equal(writableProfile.status, 200);
    assert.equal(
      (
        await f.doctor("/patients/patient-ade/profile", "PATCH", {
          allergy_status: "reviewed",
          allergies: "Synthetic permitted profile review",
          emergency_contact: "",
        })
      ).status,
      200,
    );
  } finally {
    await f.db.close();
  }
});

test("one-level delegation is narrower, patient-visible and controlled for other facilities", async () => {
  const f = await fixture();
  try {
    const general = await f.signed(f.doctor);
    const nursing = await f.signed(f.nurse, {
      note_kind: "nursing",
      complaint: "Synthetic shared nursing care",
    });
    const root = await f.grant("doctor-lagos", {
      scopes: ["general", "nursing"],
      can_contribute: true,
      allow_delegation: true,
    });
    assert.equal(root.status, 200);
    const childBody = {
      recipient_user_id: "nurse",
      recipient_organization_id: "org-lagos",
      scopes: ["nursing"],
      include_profile: false,
      can_contribute: true,
      purpose: "Synthetic consultation collaboration",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      client_request_id: randomUUID(),
    };
    denied(await f.colleague(`/professional-access/${root.data.id}/delegate`, "POST", childBody));
    rejected(
      await f.doctor(`/professional-access/${root.data.id}/delegate`, "POST", {
        ...childBody,
        scopes: ["medication"],
        client_request_id: randomUUID(),
      }),
    );
    rejected(
      await f.doctor(`/professional-access/${root.data.id}/delegate`, "POST", {
        ...childBody,
        include_profile: true,
        client_request_id: randomUUID(),
      }),
    );
    rejected(
      await f.doctor(`/professional-access/${root.data.id}/delegate`, "POST", {
        ...childBody,
        expires_at: new Date(Date.now() + 4 * 86400000).toISOString(),
        client_request_id: randomUUID(),
      }),
    );
    denied(
      await f.doctor(`/professional-access/${root.data.id}/delegate`, "POST", {
        ...childBody,
        recipient_user_id: "doctor-ibadan",
        recipient_organization_id: "org-ibadan",
        scopes: ["general"],
        client_request_id: randomUUID(),
      }),
    );
    denied(
      await f.doctor(
        "/professional-access/options?workspace_code=HP-ORG-IBADAN&patient_id=patient-ade",
      ),
    );
    const child = await f.doctor(
      `/professional-access/${root.data.id}/delegate`,
      "POST",
      childBody,
    );
    assert.equal(child.status, 200, JSON.stringify(child.data));
    const retry = await f.doctor(
      `/professional-access/${root.data.id}/delegate`,
      "POST",
      childBody,
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.data.id, child.data.id);
    rejected(
      await f.doctor(`/professional-access/${root.data.id}/delegate`, "POST", {
        ...childBody,
        purpose: "Changed delegation intent",
      }),
    );
    assert.deepEqual(
      (await f.nurse("/patients/patient-ade")).data.encounters.map((e) => e.id),
      [nursing],
    );
    denied(
      await f.nurse(`/professional-access/${child.data.id}/delegate`, "POST", {
        ...childBody,
        recipient_user_id: "colleague",
        client_request_id: randomUUID(),
      }),
    );
    const patientList = await f.patient("/professional-access");
    assert.ok(patientList.data.grants.some((g) => g.id === child.data.id));
    assert.equal(
      (await f.doctor(`/professional-access/${child.data.id}/revoke`, "POST", {})).status,
      200,
    );
    denied(await f.nurse("/patients/patient-ade"));
    const externalRoot = await f.grant("doctor-lagos", {
      can_contribute: true,
      allow_delegation: true,
      allow_external_delegation: true,
    });
    assert.equal(externalRoot.status, 200);
    const options = await f.doctor(
      "/professional-access/options?workspace_code=HP-ORG-IBADAN&patient_id=patient-ade",
    );
    assert.equal(options.status, 200);
    assert.ok(options.data.professionals.some((p) => p.id === "doctor-ibadan"));
    assert.ok(
      options.data.professionals.every(
        (p) => !Object.hasOwn(p, "email") && !Object.hasOwn(p, "registration_number"),
      ),
    );
    const external = await f.doctor(
      `/professional-access/${externalRoot.data.id}/delegate`,
      "POST",
      {
        ...childBody,
        recipient_user_id: "doctor-ibadan",
        recipient_organization_id: "org-ibadan",
        scopes: ["general"],
        client_request_id: randomUUID(),
      },
    );
    assert.equal(external.status, 200, JSON.stringify(external.data));
    assert.deepEqual(
      (await f.partner("/patients/patient-ade")).data.encounters.map((e) => e.id),
      [general],
    );
    assert.equal(
      (await f.partner("/encounters", "POST", { patient_id: "patient-ade", ...note })).status,
      200,
      "contribution does not rewrite source or require matching identity emails",
    );
    denied(
      await f.partner(`/encounters/${general}/amend`, "POST", {
        version: 2,
        ...note,
        reason: "Not my source",
      }),
    );
    assert.equal(
      (await f.patient(`/professional-access/${externalRoot.data.id}/revoke`, "POST", {})).status,
      200,
    );
    denied(await f.partner("/patients/patient-ade"));
  } finally {
    await f.db.close();
  }
});

test("effective named access rechecks recipient branch, reviewed roles and parent expiry or suspension", async () => {
  const f = await fixture();
  try {
    await f.signed(f.doctor);
    const chosen = await f.grant("colleague");
    assert.equal(chosen.status, 200);
    assert.equal((await f.colleague("/patients/patient-ade")).status, 200);
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id='second-lagos' WHERE id='colleague-member'"),
    );
    denied(await f.colleague("/patients/patient-ade"));
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id=? WHERE id='colleague-member'", [branch]),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=0 WHERE id='colleague-member'"),
    );
    denied(await f.colleague("/patients/patient-ade"));
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=1 WHERE id='colleague-member'"),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE professional_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", [
        chosen.data.id,
      ]),
    );
    denied(await f.colleague("/patients/patient-ade"));
    const root = await f.grant("doctor-lagos", {
      allow_delegation: true,
      allow_external_delegation: true,
    });
    assert.equal(root.status, 200);
    const delegate = async () =>
      f.doctor(`/professional-access/${root.data.id}/delegate`, "POST", {
        recipient_user_id: "doctor-ibadan",
        recipient_organization_id: "org-ibadan",
        scopes: ["general"],
        include_profile: false,
        can_contribute: false,
        purpose: "Synthetic authority recheck",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        client_request_id: randomUUID(),
      });
    const child = await delegate();
    assert.equal(child.status, 200);
    assert.equal((await f.partner("/patients/patient-ade")).status, 200);
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=0 WHERE user_id='doctor-lagos'"),
    );
    denied(await f.partner("/patients/patient-ade"));
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=1 WHERE user_id='doctor-lagos'"),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id='second-lagos' WHERE user_id='doctor-lagos'"),
    );
    denied(await f.partner("/patients/patient-ade"));
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id=? WHERE user_id='doctor-lagos'", [branch]),
    );
    const originalRole = await f.db.transaction((tx) =>
      tx.get("SELECT permissions FROM workspace_roles WHERE id='role-org-lagos-clinician'"),
    );
    await f.db.transaction((tx) =>
      tx.run(
        "UPDATE workspace_roles SET permissions='[\"registry.view\"]' WHERE id='role-org-lagos-clinician'",
      ),
    );
    denied(await f.partner("/patients/patient-ade"));
    await f.db.transaction((tx) =>
      tx.run("UPDATE workspace_roles SET permissions=? WHERE id='role-org-lagos-clinician'", [
        originalRole.permissions,
      ]),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET active=0 WHERE user_id='doctor-lagos'"),
    );
    denied(await f.partner("/patients/patient-ade"));
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET active=1 WHERE user_id='doctor-lagos'"),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE professional_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", [
        root.data.id,
      ]),
    );
    denied(await f.partner("/patients/patient-ade"));
    assert.equal((await f.patient("/patients/patient-ade")).data.encounters.length, 1);
  } finally {
    await f.db.close();
  }
});

test("patient grants use exact-payload idempotency, isolate identities and reject malformed authority", async () => {
  const f = await fixture();
  try {
    const directory = "/professional-access/options?workspace_code=HP-ORG-LAGOS&search=";
    const matched = await f.patient(directory + encodeURIComponent("Ada Nwosu"));
    assert.equal(matched.status, 200);
    assert.deepEqual(
      matched.data.professionals.map((person) => person.id),
      ["doctor-lagos"],
    );
    for (const query of ["No such synthetic professional", "%", "_"]) {
      const absent = await f.patient(directory + encodeURIComponent(query));
      assert.equal(absent.status, 200);
      assert.deepEqual(
        absent.data.professionals,
        [],
        "search wildcard is literal and cannot enumerate every professional",
      );
    }
    assert.equal((await f.patient(directory + "x".repeat(161))).status, 400);
    rejected(await f.grant("colleague", { acknowledge_restriction: false }));
    rejected(await f.grant("colleague", { scopes: ["emergency-all"] }));
    rejected(await f.grant("colleague", { can_contribute: "true" }));
    rejected(await f.grant("colleague", { recipient_organization_id: "org-ibadan" }));
    rejected(
      await f.grant("colleague", {
        expires_at: new Date(Date.now() + 91 * 86400000).toISOString(),
      }),
    );
    rejected(await f.grant("colleague", { unknown_permission: "all" }));
    const result = await f.grant("colleague");
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const replay = await f.patient("/professional-access", "POST", result.body);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.id, result.data.id);
    rejected(
      await f.patient("/professional-access", "POST", { ...result.body, can_contribute: true }),
    );
    const rows = await f.db.transaction((tx) =>
      tx.all(
        "SELECT * FROM professional_grants WHERE grantor_id='patient-user' AND client_request_id=?",
        [result.body.client_request_id],
      ),
    );
    assert.equal(rows.length, 1);
    const concurrentBody = {
      ...result.body,
      client_request_id: randomUUID(),
      purpose: "Synthetic concurrent grant",
    };
    const raced = await Promise.all([
      f.patient("/professional-access", "POST", concurrentBody),
      f.patient("/professional-access", "POST", concurrentBody),
    ]);
    assert.ok(raced.every((response) => response.status === 200));
    assert.equal(raced[0].data.id, raced[1].data.id);
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT id FROM professional_grants WHERE client_request_id=?", [
            concurrentBody.client_request_id,
          ]),
        )
      ).length,
      1,
    );
    denied(await f.doctor("/professional-access", "POST", result.body));
    denied(
      await f.reception(
        "/professional-access/options?workspace_code=HP-ORG-LAGOS&patient_id=patient-ade",
      ),
    );
    rejected(
      await f.colleague(
        "/professional-access/options?workspace_code=HP-ORG-LAGOS&patient_id=patient-tunde",
      ),
    );
    rejected(await f.colleague(`/professional-access/${result.data.id}/revoke`, "POST", {}));
    const unrelated = f.client();
    assert.equal(
      (
        await unrelated("/auth/register", "POST", {
          name: "Synthetic unrelated self-account",
          email: "unrelated@synthetic.invalid",
          password,
        })
      ).status,
      200,
    );
    rejected(await unrelated(`/professional-access/${result.data.id}/revoke`, "POST", {}));
    assert.equal((await unrelated("/professional-access")).data.grants.length, 0);
  } finally {
    await f.db.close();
  }
});

test("visit details obey named read scopes while assigned clinical actions require contribution authority", async () => {
  const f = await fixture();
  try {
    const visitId = await f.visit();
    const legacyIds = [randomUUID(), randomUUID()];
    await f.db.transaction(async (tx) => {
      for (const id of legacyIds) {
        await tx.run(
          "INSERT INTO visit_followups(id,visit_id,author_id,request_payload,title,due_at,status,created_at,updated_at) VALUES (?,?,'doctor-lagos','legacy-unknown-payload','Synthetic unclassified historical task marker',?,'open',?,?)",
          [id, visitId, expiry(), new Date().toISOString(), new Date().toISOString()],
        );
      }
    });
    const legacyView = await f.doctor(`/visits/${visitId}`);
    assert.equal(legacyView.data.followUps.length, 2);
    assert.ok(
      legacyView.data.followUps.every((task) => task.discipline === "unknown"),
      "migration never guesses an old task's clinical category",
    );
    assert.equal(
      (
        await f.doctor(`/visits/${visitId}/follow-ups/${legacyIds[0]}`, "PATCH", {
          version: 1,
          status: "completed",
        })
      ).status,
      200,
      "existing facility policy retains management of historical unclassified tasks",
    );
    const observation = await f.doctor(`/visits/${visitId}/observations`, "POST", {
      values: { pulse: 72 },
      client_request_id: randomUUID(),
    });
    assert.equal(observation.status, 200);
    const followup = await f.doctor(`/visits/${visitId}/follow-ups`, "POST", {
      title: "Synthetic general-only follow-up marker",
      due_at: expiry(),
      client_request_id: randomUUID(),
      discipline: "general",
    });
    assert.equal(followup.status, 200);
    await f.signed(f.doctor, { visit_id: visitId });
    const read = await f.grant("doctor-lagos", { scopes: ["general"] });
    assert.equal(read.status, 200);
    const readable = await f.doctor(`/visits/${visitId}`);
    assert.equal(readable.status, 200);
    assert.equal(readable.data.clinicalAllowed, true);
    assert.equal(readable.data.observations.length, 1);
    assert.equal(readable.data.followUps.length, 1);
    assert.ok(
      !JSON.stringify(readable.data).includes("Synthetic unclassified historical task marker"),
      "restricted general access cannot expose unclassified historical task text",
    );
    denied(await f.doctor(`/visits/${visitId}`, "PATCH", { version: 2, status: "completed" }));
    denied(
      await f.doctor(`/visits/${visitId}/follow-ups/${followup.data.id}`, "PATCH", {
        version: 1,
        status: "completed",
      }),
    );
    assert.equal(
      (await f.patient(`/professional-access/${read.data.id}/revoke`, "POST", {})).status,
      200,
    );
    const medication = await f.grant("doctor-lagos", {
      scopes: ["medication"],
      can_contribute: true,
    });
    assert.equal(medication.status, 200);
    const filtered = await f.doctor(`/visits/${visitId}`);
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.data.observations, []);
    assert.deepEqual(filtered.data.followUps, []);
    assert.ok(!JSON.stringify(filtered.data).includes("Synthetic general-only follow-up marker"));
    const clinicalReads = await f.db.transaction((tx) =>
      tx.all(
        "SELECT purpose FROM audits WHERE actor_id='doctor-lagos' AND action='visit.clinical.read'",
      ),
    );
    assert.ok(
      clinicalReads.some((row) =>
        JSON.parse(row.purpose).active_professional_grant_ids.includes(medication.data.id),
      ),
    );
    denied(await f.doctor(`/visits/${visitId}`, "PATCH", { version: 2, status: "completed" }));
    denied(
      await f.doctor(`/visits/${visitId}/follow-ups/${followup.data.id}`, "PATCH", {
        version: 1,
        status: "completed",
      }),
    );
    const contribute = await f.grant("doctor-lagos", { scopes: ["general"], can_contribute: true });
    assert.equal(contribute.status, 200);
    denied(
      await f.doctor(`/visits/${visitId}/follow-ups/${legacyIds[1]}`, "PATCH", {
        version: 1,
        status: "completed",
      }),
    );
    const allKnownCategories = await f.grant("doctor-lagos", {
      scopes: ["general", "nursing", "medication"],
      can_contribute: true,
    });
    assert.equal(allKnownCategories.status, 200);
    assert.ok(
      !JSON.stringify((await f.doctor(`/visits/${visitId}`)).data).includes(
        "Synthetic unclassified historical task marker",
      ),
      "granting all known categories never guesses access to unclassified historical text",
    );
    denied(
      await f.doctor(`/visits/${visitId}/follow-ups/${legacyIds[1]}`, "PATCH", {
        version: 1,
        status: "completed",
      }),
    );
    denied(
      await f.doctor(`/visits/${visitId}/observations`, "POST", {
        values: { pulse: 80 },
        discipline: "nursing",
        client_request_id: randomUUID(),
      }),
    );
    assert.equal(
      (await f.doctor(`/visits/${visitId}`, "PATCH", { version: 2, status: "completed" })).status,
      200,
    );
  } finally {
    await f.db.close();
  }
});
