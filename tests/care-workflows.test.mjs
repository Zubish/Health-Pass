import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.mjs";
import { createApi } from "../server/api.mjs";
import { seed } from "../server/seed.mjs";

const password = "synthetic-care-workflow-password";
const branch = "main-org-lagos";
const otherBranch = "main-org-ibadan";
const signedNote = {
  complaint: "Synthetic outpatient review",
  assessment: "Synthetic reviewed assessment",
  plan: "Synthetic reviewed follow-up plan",
};

async function fixture() {
  const db = await openTestDatabase();
  await seed(db, password);
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE memberships SET branch_id=? WHERE user_id IN ('doctor-lagos','reception')",
      [branch],
    );
    await tx.run("UPDATE memberships SET branch_id=? WHERE user_id='doctor-ibadan'", [otherBranch]);
    await tx.run(
      "INSERT INTO branches(id,organization_id,name) VALUES ('secondary-lagos','org-lagos','Synthetic second branch')",
    );
  });
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  function client() {
    let cookie = "";
    return async (path, method = "GET", body) => {
      const response = await api(
        new Request(`http://localhost:3000/api/healthpass${path}`, {
          method,
          headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const updated = response.headers.get("set-cookie");
      if (updated) cookie = updated.split(";")[0];
      return { status: response.status, data: await response.json() };
    };
  }
  async function login(email) {
    const request = client();
    assert.equal((await request("/auth/login", "POST", { email, password })).status, 200);
    if (email !== "patient@healthpass.test")
      assert.equal((await request("/auth/mfa/skip", "POST", {})).status, 200);
    return request;
  }
  async function checkIn(request, overrides = {}) {
    return request("/visits", "POST", {
      patient_id: "patient-ade",
      branch_id: branch,
      assigned_user_id: "doctor-lagos",
      client_request_id: randomUUID(),
      ...overrides,
    });
  }
  async function secondDoctor() {
    await db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,name,password_hash,verified) SELECT 'second-doctor','second@synthetic.invalid','second@synthetic.invalid','org-lagos','Synthetic second doctor',password_hash,1 FROM users WHERE id='doctor-lagos'",
      );
      await tx.run(
        "INSERT INTO memberships(id,user_id,organization_id,role,branch_id,clinical_verified,clinical_scopes,clinical_review_reference) VALUES ('second-member','second-doctor','org-lagos','clinician',?,1,'[\"general\"]','Synthetic credential review')",
        [branch],
      );
      await tx.run(
        "INSERT INTO membership_roles(membership_id,role_id) VALUES ('second-member','role-org-lagos-clinician')",
      );
    });
    return login("second@synthetic.invalid");
  }
  return { db, client, login, checkIn, secondDoctor };
}

test("patient-issued facility registration is explicit, audited, nonmerging and tenant scoped", async () => {
  const { db, login } = await fixture();
  try {
    const patient = await login("patient@healthpass.test");
    const reception = await login("reception@healthpass.test");
    const partner = await login("ibadan@healthpass.test");
    const doctor = await login("doctor@healthpass.test");
    assert.equal(
      (
        await reception("/patient-link-invitations", "POST", {
          workspace_code: "HP-ORG-IBADAN",
          branch_id: otherBranch,
          acknowledge_registration: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await patient("/patient-link-invitations", "POST", {
          workspace_code: "HP-ORG-IBADAN",
          branch_id: otherBranch,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await patient("/patient-link-invitations", "POST", {
          workspace_code: "HP-ORG-IBADAN",
          branch_id: branch,
          acknowledge_registration: true,
        })
      ).status,
      400,
    );
    const options = await patient("/patient-link-options?workspace_code=HP-ORG-IBADAN");
    assert.equal(options.status, 200);
    assert.equal(options.data.facility.id, "org-ibadan");
    const note = await doctor("/encounters", "POST", { patient_id: "patient-ade", ...signedNote });
    assert.equal(
      (await doctor(`/encounters/${note.data.id}/sign`, "POST", { version: 1 })).status,
      200,
    );
    const issued = await patient("/patient-link-invitations", "POST", {
      workspace_code: "HP-ORG-IBADAN",
      branch_id: otherBranch,
      acknowledge_registration: true,
    });
    assert.equal(issued.status, 200);
    assert.ok(issued.data.code);
    assert.equal(
      (await reception("/patient-link-invitations/review", "POST", { code: issued.data.code }))
        .status,
      404,
    );
    const reviewed = await partner("/patient-link-invitations/review", "POST", {
      code: issued.data.code,
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.data.patient.id, "patient-ade");
    assert.equal(reviewed.data.patient.phone, undefined);
    assert.equal(reviewed.data.patient.allergies, undefined);
    assert.equal(
      (
        await partner("/patient-link-invitations/redeem", "POST", {
          code: issued.data.code,
          review_reference: "Synthetic patient-present review",
        })
      ).status,
      400,
    );
    const linked = await partner("/patient-link-invitations/redeem", "POST", {
      code: issued.data.code,
      identity_confirmed: true,
      review_reference: "Synthetic patient-present review",
    });
    assert.equal(linked.status, 200);
    assert.equal(linked.data.id, "patient-ade");
    assert.equal(
      (
        await partner("/patient-link-invitations/redeem", "POST", {
          code: issued.data.code,
          identity_confirmed: true,
          review_reference: "Synthetic replay",
        })
      ).status,
      404,
    );
    assert.equal(
      (await partner("/patients/patient-ade")).data.encounters.length,
      0,
      "registration does not release another facility's chart",
    );
    assert.equal((await patient("/patients/patient-ade")).data.encounters.length, 1);
    const list = await patient("/patient-link-invitations");
    assert.equal(list.data.invitations[0].status, "redeemed");
    assert.ok(!JSON.stringify(list.data).includes(issued.data.code));
    const identities = await db.transaction((tx) =>
      tx.all("SELECT id FROM patients WHERE id='patient-ade'"),
    );
    assert.equal(identities.length, 1);
    const links = await db.transaction((tx) =>
      tx.all("SELECT * FROM patient_links WHERE patient_id='patient-ade'"),
    );
    assert.equal(links.length, 2);
    const audit = (await patient("/audit")).data.audits;
    assert.ok(
      audit.some((row) => row.action === "registry.patient_linked"),
      "registration decisions retained in audit",
    );
  } finally {
    await db.close();
  }
});

test("patient link expiry, cancellation, branch scope, shared contacts and duplicate review fail safely", async () => {
  const { db, login, client } = await fixture();
  try {
    const patient = await login("patient@healthpass.test");
    const partner = await login("ibadan@healthpass.test");
    const reception = await login("reception@healthpass.test");
    const body = {
      workspace_code: "HP-ORG-IBADAN",
      branch_id: otherBranch,
      acknowledge_registration: true,
    };
    const expired = await patient("/patient-link-invitations", "POST", body);
    assert.equal(expired.status, 200);
    await db.transaction((tx) =>
      tx.run(
        "UPDATE patient_link_invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
        [expired.data.invitation.id],
      ),
    );
    assert.equal(
      (await partner("/patient-link-invitations/review", "POST", { code: expired.data.code }))
        .status,
      404,
    );
    const cancelled = await patient("/patient-link-invitations", "POST", body);
    assert.equal(
      (
        await patient(
          `/patient-link-invitations/${cancelled.data.invitation.id}/revoke`,
          "POST",
          {},
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await partner("/patient-link-invitations/redeem", "POST", {
          code: cancelled.data.code,
          identity_confirmed: true,
          review_reference: "Synthetic cancelled review",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await reception(
          `/patient-link-invitations/${cancelled.data.invitation.id}/revoke`,
          "POST",
          {},
        )
      ).status,
      403,
    );
    const issued = await patient("/patient-link-invitations", "POST", body);
    await db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id='secondary-lagos' WHERE user_id='doctor-ibadan'"),
    );
    assert.equal(
      (await partner("/patient-link-invitations/review", "POST", { code: issued.data.code }))
        .status,
      404,
    );
    await db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id=? WHERE user_id='doctor-ibadan'", [otherBranch]),
    );
    await db.transaction(async (tx) => {
      await tx.run(
        "UPDATE patients SET name=(SELECT name FROM patients WHERE id='patient-ade'),dob=(SELECT dob FROM patients WHERE id='patient-ade'),phone='SYNTHETIC-SHARED' WHERE id='patient-tunde'",
      );
      await tx.run("UPDATE patients SET phone='SYNTHETIC-SHARED' WHERE id='patient-ade'");
    });
    const duplicate = await partner("/patient-link-invitations/review", "POST", {
      code: issued.data.code,
    });
    assert.equal(duplicate.data.possible_duplicates[0].id, "patient-tunde");
    const redeem = {
      code: issued.data.code,
      identity_confirmed: true,
      review_reference: "Synthetic explicit duplicate review",
    };
    assert.equal((await partner("/patient-link-invitations/redeem", "POST", redeem)).status, 409);
    assert.equal(
      (
        await partner("/patient-link-invitations/redeem", "POST", {
          ...redeem,
          duplicate_reviewed: true,
        })
      ).status,
      200,
    );
    const intact = await db.transaction((tx) =>
      tx.all("SELECT id FROM patients WHERE phone='SYNTHETIC-SHARED'"),
    );
    assert.equal(intact.length, 2, "matching names/DOB/contacts are not a merge authority");
    const otherPatient = client();
    assert.equal(
      (
        await otherPatient("/auth/register", "POST", {
          name: "Synthetic separate patient",
          email: "separate@synthetic.invalid",
          password,
          phone: "SYNTHETIC-SHARED",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await otherPatient(
          `/patient-link-invitations/${issued.data.invitation.id}/revoke`,
          "POST",
          {},
        )
      ).status,
      404,
    );
    assert.equal((await otherPatient("/patient-link-invitations")).data.invitations.length, 0);
  } finally {
    await db.close();
  }
});

test("concurrent patient-code redemption creates only one registration and stored tokens are hashed", async () => {
  const { db, login } = await fixture();
  try {
    const patient = await login("patient@healthpass.test");
    const partner = await login("ibadan@healthpass.test");
    const issued = await patient("/patient-link-invitations", "POST", {
      workspace_code: "HP-ORG-IBADAN",
      branch_id: otherBranch,
      acknowledge_registration: true,
    });
    const redeem = {
      code: issued.data.code,
      identity_confirmed: true,
      review_reference: "Synthetic concurrent review",
    };
    const outcomes = await Promise.all([
      partner("/patient-link-invitations/redeem", "POST", redeem),
      partner("/patient-link-invitations/redeem", "POST", redeem),
    ]);
    assert.deepEqual(outcomes.map((item) => item.status).sort(), [200, 404]);
    const invitations = await db.transaction((tx) =>
      tx.all("SELECT * FROM patient_link_invitations WHERE id=?", [issued.data.invitation.id]),
    );
    assert.ok(!JSON.stringify(invitations).includes(issued.data.code));
    const links = await db.transaction((tx) =>
      tx.all(
        "SELECT * FROM patient_links WHERE patient_id='patient-ade' AND organization_id='org-ibadan'",
      ),
    );
    assert.equal(links.length, 1);
  } finally {
    await db.close();
  }
});

test("outpatient queue keeps operational data separate, scopes assignments and retries once", async () => {
  const { db, login, checkIn } = await fixture();
  try {
    const reception = await login("reception@healthpass.test");
    const doctor = await login("doctor@healthpass.test");
    const foreign = await login("ibadan@healthpass.test");
    const patient = await login("patient@healthpass.test");
    const admin = await login("admin@healthpass.test");
    assert.equal((await patient("/visits")).status, 403);
    assert.equal((await admin("/visits")).status, 403);
    const team = await reception(`/visits/team?branch_id=${branch}`);
    assert.equal(team.status, 200);
    assert.ok(team.data.professionals.some((person) => person.id === "doctor-lagos"));
    assert.ok(!team.data.professionals.some((person) => person.id === "doctor-ibadan"));
    const requestId = randomUUID();
    const created = await checkIn(reception, { client_request_id: requestId });
    assert.equal(created.status, 200);
    assert.equal(created.data.version, 1);
    const retry = await checkIn(reception, { client_request_id: requestId });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.id, created.data.id);
    assert.equal(retry.data.existing, true);
    assert.equal(
      (await checkIn(reception)).status,
      409,
      "duplicate active arrival must not create another visit",
    );
    assert.equal(
      (await checkIn(reception, { client_request_id: requestId, patient_id: "patient-zainab" }))
        .status,
      409,
    );
    assert.equal(
      (
        await checkIn(reception, {
          patient_id: "patient-zainab",
          assigned_user_id: "doctor-ibadan",
        })
      ).status,
      403,
    );
    assert.equal((await checkIn(reception, { branch_id: "secondary-lagos" })).status, 403);
    assert.equal((await checkIn(reception, { patient_id: "patient-tunde" })).status, 403);
    const queue = await reception("/visits?limit=1");
    assert.equal(queue.status, 200);
    assert.equal(queue.data.visits.length, 1);
    assert.equal(queue.data.visits[0].id, created.data.id);
    for (const key of [
      "complaint",
      "assessment",
      "allergies",
      "observations",
      "followUps",
      "phone",
    ])
      assert.equal(
        queue.data.visits[0][key],
        undefined,
        `${key} must not leak into operational queue`,
      );
    const detail = await reception(`/visits/${created.data.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.clinicalAllowed, false);
    assert.deepEqual(detail.data.observations, []);
    assert.deepEqual(detail.data.followUps, []);
    assert.equal((await foreign(`/visits/${created.data.id}`)).status, 404);
    assert.equal(
      (await foreign(`/visits/${created.data.id}`, "PATCH", { version: 1, status: "cancelled" }))
        .status,
      404,
    );
    assert.equal(
      (
        await reception(`/visits/${created.data.id}`, "PATCH", {
          version: 1,
          status: "in-progress",
        })
      ).status,
      403,
    );
    assert.equal(
      (await doctor(`/visits/${created.data.id}`, "PATCH", { version: 0, status: "in-progress" }))
        .status,
      409,
    );
    const started = await doctor(`/visits/${created.data.id}`, "PATCH", {
      version: 1,
      status: "in-progress",
    });
    assert.equal(started.status, 200);
    assert.equal(started.data.version, 2);
    assert.equal(
      (
        await reception(`/visits/${created.data.id}`, "PATCH", {
          version: 2,
          assigned_user_id: "doctor-lagos",
        })
      ).status,
      409,
    );
    const cancelled = await reception(`/visits/${created.data.id}`, "PATCH", {
      version: 2,
      status: "cancelled",
    });
    assert.equal(cancelled.status, 200);
    assert.equal(
      (await doctor(`/visits/${created.data.id}`, "PATCH", { version: 3, status: "in-progress" }))
        .status,
      409,
    );
    assert.equal((await reception("/visits")).data.visits.length, 0);
    assert.equal((await reception("/visits?status=cancelled")).data.visits.length, 1);
    const rows = await db.transaction((tx) => tx.all("SELECT * FROM care_visits"));
    assert.equal(rows.length, 1);
  } finally {
    await db.close();
  }
});

test("assigned outpatient care signs a source note before completion and keeps clinical output from reception", async () => {
  const { db, login, checkIn } = await fixture();
  try {
    const reception = await login("reception@healthpass.test");
    const doctor = await login("doctor@healthpass.test");
    const patient = await login("patient@healthpass.test");
    const visit = await checkIn(reception);
    assert.equal(visit.status, 200);
    const id = visit.data.id;
    assert.equal(
      (await doctor(`/visits/${id}/observations`, "POST", { values: { pulse: 72 } })).status,
      409,
    );
    assert.equal(
      (await doctor(`/visits/${id}`, "PATCH", { version: 1, status: "in-progress" })).status,
      200,
    );
    assert.equal(
      (await reception(`/visits/${id}/observations`, "POST", { values: { pulse: 72 } })).status,
      403,
    );
    assert.equal(
      (await doctor(`/visits/${id}/observations`, "POST", { values: { pulse: "72" } })).status,
      400,
    );
    assert.equal(
      (await doctor(`/visits/${id}/observations`, "POST", { values: { unknown_metric: 123 } }))
        .status,
      400,
    );
    assert.equal(
      (await doctor(`/visits/${id}/observations`, "POST", { values: { pulse: 1000 } })).status,
      400,
    );
    assert.equal(
      (
        await doctor(`/visits/${id}/observations`, "POST", {
          values: { systolic: 80, diastolic: 90 },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await doctor(`/visits/${id}/observations`, "POST", {
          values: { pulse: 72 },
          observed_at: "invalid-date",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await doctor(`/visits/${id}/observations`, "POST", {
          values: { pulse: 72 },
          observed_at: new Date(Date.now() + 86400000).toISOString(),
        })
      ).status,
      400,
    );
    const observationBody = {
      client_request_id: randomUUID(),
      values: { pulse: 72, temperature: 36.8, spo2: 98 },
    };
    const observation = await doctor(`/visits/${id}/observations`, "POST", observationBody);
    assert.equal(observation.status, 200);
    const repeatedObservation = await doctor(`/visits/${id}/observations`, "POST", observationBody);
    assert.equal(repeatedObservation.status, 200);
    assert.equal(repeatedObservation.data.id, observation.data.id);
    assert.equal(
      (
        await doctor(`/visits/${id}/observations`, "POST", {
          ...observationBody,
          values: { pulse: 80 },
        })
      ).status,
      409,
    );
    const taskBody = {
      client_request_id: randomUUID(),
      title: "Synthetic reviewed follow-up",
      due_at: new Date(Date.now() + 86400000).toISOString(),
    };
    const followUp = await doctor(`/visits/${id}/follow-ups`, "POST", taskBody);
    assert.equal(followUp.status, 200);
    const repeatedTask = await doctor(`/visits/${id}/follow-ups`, "POST", taskBody);
    assert.equal(repeatedTask.status, 200);
    assert.equal(repeatedTask.data.id, followUp.data.id);
    assert.equal(
      (await doctor(`/visits/${id}/follow-ups`, "POST", { ...taskBody, title: "Changed task" }))
        .status,
      409,
    );
    assert.equal(
      (
        await reception(`/visits/${id}/follow-ups`, "POST", {
          title: "Denied",
          due_at: new Date(Date.now() + 86400000).toISOString(),
        })
      ).status,
      403,
    );
    assert.equal(
      (await doctor(`/visits/${id}`, "PATCH", { version: 2, status: "completed" })).status,
      409,
    );
    const noteBody = {
      patient_id: "patient-ade",
      visit_id: id,
      client_request_id: randomUUID(),
      ...signedNote,
      complaint: "Synthetic discarded initial draft wording",
    };
    const note = await doctor("/encounters", "POST", noteBody);
    assert.equal(note.status, 200);
    const repeatedNote = await doctor("/encounters", "POST", noteBody);
    assert.equal(repeatedNote.status, 200);
    assert.equal(repeatedNote.data.id, note.data.id);
    assert.equal(
      (await doctor("/encounters", "POST", { ...noteBody, complaint: "Different initial care" }))
        .status,
      409,
    );
    assert.equal((await patient("/patients/patient-ade")).data.encounters.length, 0);
    assert.equal(
      (await doctor(`/visits/${id}`, "PATCH", { version: 2, status: "completed" })).status,
      409,
      "draft alone cannot complete care",
    );
    assert.equal(
      (await doctor(`/encounters/${note.data.id}/sign`, "POST", { version: 1, ...signedNote }))
        .status,
      200,
    );
    const completed = await doctor(`/visits/${id}`, "PATCH", { version: 2, status: "completed" });
    assert.equal(completed.status, 200);
    assert.equal(
      (await doctor(`/visits/${id}/observations`, "POST", observationBody)).data.id,
      observation.data.id,
      "lost-response observation replay still works after completion",
    );
    const released = (await patient("/patients/patient-ade")).data.encounters;
    assert.equal(released.length, 1);
    assert.equal(released[0].visit_id, id);
    assert.equal(released[0].status, "signed");
    assert.equal(released[0].complaint, signedNote.complaint);
    assert.equal(Object.hasOwn(released[0], "create_request_payload"), false);
    assert.equal(Object.hasOwn(released[0], "client_request_id"), false);
    assert.ok(
      !JSON.stringify(released).includes(noteBody.complaint),
      "patient receives signed text without discarded draft retry metadata",
    );
    const ownChart = (await doctor("/patients/patient-ade")).data.encounters;
    assert.equal(Object.hasOwn(ownChart[0], "create_request_payload"), false);
    assert.equal(Object.hasOwn(ownChart[0], "client_request_id"), false);
    assert.equal(
      (await doctor(`/visits/${id}/observations`, "POST", { values: { pulse: 80 } })).status,
      409,
    );
    const clinical = await doctor(`/visits/${id}`);
    assert.equal(clinical.data.clinicalAllowed, true);
    assert.equal(clinical.data.observations.length, 1);
    assert.equal(clinical.data.followUps.length, 1);
    assert.equal(
      (
        await doctor(`/visits/${id}/follow-ups/${followUp.data.id}`, "PATCH", {
          version: 0,
          status: "completed",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await doctor(`/visits/${id}/follow-ups/${followUp.data.id}`, "PATCH", {
          version: 1,
          status: "completed",
        })
      ).status,
      200,
    );
    assert.equal(
      (await doctor(`/visits/${id}/follow-ups`, "POST", taskBody)).data.id,
      followUp.data.id,
      "task replay never reopens completed work",
    );
    const operational = await reception(`/visits/${id}`);
    assert.equal(operational.data.clinicalAllowed, false);
    assert.deepEqual(operational.data.observations, []);
    assert.deepEqual(operational.data.followUps, []);
    assert.equal(
      (await doctor(`/encounters/${note.data.id}`, "PATCH", { version: 2, ...signedNote })).status,
      409,
    );
    assert.equal(
      (
        await doctor(`/encounters/${note.data.id}/amend`, "POST", {
          version: 2,
          ...signedNote,
          reason: "Synthetic clarification",
        })
      ).status,
      200,
    );
    const versions = await db.transaction((tx) =>
      tx.all("SELECT * FROM note_versions WHERE encounter_id=?", [note.data.id]),
    );
    assert.equal(versions.length, 2);
    const createdNotes = await db.transaction((tx) =>
      tx.all("SELECT id FROM encounters WHERE visit_id=?", [id]),
    );
    assert.equal(createdNotes.length, 1);
    await assert.rejects(
      () =>
        db.transaction((tx) =>
          tx.run("UPDATE visit_observations SET values_json='{}' WHERE visit_id=?", [id]),
        ),
      /immutable/i,
    );
    await assert.rejects(
      () => db.transaction((tx) => tx.run("DELETE FROM visit_events WHERE visit_id=?", [id])),
      /immutable|append-only/i,
    );
  } finally {
    await db.close();
  }
});

test("visit assignment adds no clinical authority and hides other clinicians' drafts and consultation records", async () => {
  const { db, login, checkIn, secondDoctor } = await fixture();
  try {
    const reception = await login("reception@healthpass.test");
    const doctor = await login("doctor@healthpass.test");
    const colleague = await secondDoctor();
    const visit = await checkIn(reception);
    assert.equal(visit.status, 200);
    const id = visit.data.id;
    const unassigned = await colleague(`/visits/${id}`);
    assert.equal(unassigned.status, 200);
    assert.equal(unassigned.data.clinicalAllowed, false);
    assert.equal(
      (await colleague(`/visits/${id}`, "PATCH", { version: 1, status: "in-progress" })).status,
      403,
    );
    assert.equal(
      (
        await colleague("/encounters", "POST", {
          patient_id: "patient-ade",
          visit_id: id,
          ...signedNote,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await doctor("/encounters", "POST", {
          patient_id: "patient-zainab",
          visit_id: id,
          ...signedNote,
        })
      ).status,
      400,
    );
    assert.equal(
      (await doctor(`/visits/${id}`, "PATCH", { version: 1, status: "in-progress" })).status,
      200,
    );
    const note = await doctor("/encounters", "POST", {
      patient_id: "patient-ade",
      visit_id: id,
      ...signedNote,
    });
    assert.equal(note.status, 200);
    const legacyDraft = await doctor("/encounters", "POST", {
      patient_id: "patient-ade",
      ...signedNote,
    });
    assert.equal(legacyDraft.status, 200);
    assert.equal(
      (await colleague("/patients/patient-ade")).data.encounters.length,
      0,
      "even legacy drafts are author-specific",
    );
    assert.equal(
      (await doctor(`/encounters/${note.data.id}/sign`, "POST", { version: 1 })).status,
      200,
    );
    assert.equal(
      (await colleague("/patients/patient-ade")).data.encounters.length,
      0,
      "consultation-specific signed record stays with its author pending explicit delegation",
    );
    const member = await db.transaction((tx) =>
      tx.get("SELECT id FROM memberships WHERE user_id='doctor-lagos'"),
    );
    await db.transaction((tx) =>
      tx.run(
        "UPDATE workspace_roles SET permissions='[\"registry.view\",\"visits.view\"]' WHERE id='role-org-lagos-clinician'",
      ),
    );
    assert.equal(
      (await doctor(`/visits/${id}/observations`, "POST", { values: { pulse: 72 } })).status,
      403,
      "role revocation applies to current session",
    );
    const revoked = await doctor(`/visits/${id}`);
    assert.equal(revoked.data.clinicalAllowed, false);
    await db.transaction((tx) => tx.run("UPDATE memberships SET active=0 WHERE id=?", [member.id]));
    assert.equal((await doctor(`/visits/${id}`)).status, 403);
    const retained = await db.transaction((tx) =>
      tx.all("SELECT * FROM note_versions WHERE encounter_id=?", [note.data.id]),
    );
    assert.equal(retained.length, 1, "revocation retains signed source history");
  } finally {
    await db.close();
  }
});

test("visit routing rechecks reviewed membership and care relationships, paginates and survives concurrent check-in", async () => {
  const { db, login, checkIn, secondDoctor } = await fixture();
  try {
    const reception = await login("reception@healthpass.test");
    const doctor = await login("doctor@healthpass.test");
    const colleague = await secondDoctor();
    const requestId = randomUUID();
    const concurrent = await Promise.all([
      checkIn(reception, { client_request_id: requestId }),
      checkIn(reception, { client_request_id: requestId }),
    ]);
    assert.ok(concurrent.every((response) => response.status === 200));
    assert.equal(concurrent[0].data.id, concurrent[1].data.id);
    const id = concurrent[0].data.id;
    const next = await checkIn(reception, { patient_id: "patient-zainab" });
    assert.equal(next.status, 200);
    const page = await reception("/visits?limit=1");
    assert.ok(page.data.nextCursor);
    const pageTwo = await reception(`/visits?limit=1&cursor=${page.data.nextCursor}`);
    assert.equal(pageTwo.data.visits.length, 1);
    assert.notEqual(page.data.visits[0].id, pageTwo.data.visits[0].id);
    assert.equal((await reception("/visits?limit=101")).status, 400);
    assert.equal((await reception("/visits?branch_id=main-org-ibadan")).status, 403);
    const search = await reception(`/visits/patients?branch_id=${branch}&search=HP-DEMO-003`);
    assert.equal(search.status, 200);
    assert.equal(search.data.patients.length, 0);
    assert.equal((await reception(`/visits/patients?branch_id=${branch}&limit=51`)).status, 400);
    await db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=0 WHERE id='second-member'"),
    );
    assert.equal(
      (await reception(`/visits/${id}`, "PATCH", { version: 1, assigned_user_id: "second-doctor" }))
        .status,
      403,
    );
    assert.equal(
      (await reception(`/visits/team?branch_id=${branch}`)).data.professionals.some(
        (person) => person.id === "second-doctor",
      ),
      false,
    );
    await db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=1 WHERE id='second-member'"),
    );
    assert.equal(
      (await reception(`/visits/${id}`, "PATCH", { version: 1, assigned_user_id: "second-doctor" }))
        .status,
      200,
    );
    const replayAfterAssignment = await checkIn(reception, { client_request_id: requestId });
    assert.equal(replayAfterAssignment.status, 200);
    assert.equal(replayAfterAssignment.data.id, id);
    assert.equal(
      (await doctor(`/visits/${id}`, "PATCH", { version: 2, status: "in-progress" })).status,
      403,
    );
    await db.transaction((tx) =>
      tx.run("DELETE FROM branch_patient_links WHERE patient_id='patient-ade' AND branch_id=?", [
        branch,
      ]),
    );
    assert.equal((await colleague(`/visits/${id}`)).data.clinicalAllowed, false);
    assert.equal(
      (await colleague(`/visits/${id}`, "PATCH", { version: 2, status: "in-progress" })).status,
      403,
      "routing does not manufacture chart authority",
    );
    await db.transaction((tx) =>
      tx.run("UPDATE memberships SET active=0 WHERE id='second-member'"),
    );
    assert.equal((await colleague("/visits")).status, 403);
    const events = await db.transaction((tx) =>
      tx.all("SELECT * FROM visit_events WHERE visit_id=?", [id]),
    );
    assert.equal(events.filter((event) => event.action === "visit.check_in").length, 1);
    assert.equal(events.filter((event) => event.action === "visit.assign").length, 1);
  } finally {
    await db.close();
  }
});
