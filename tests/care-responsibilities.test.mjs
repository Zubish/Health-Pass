import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.mjs";
import { createApi } from "../server/api.mjs";
import { seed } from "../server/seed.mjs";

const password = "synthetic-care-responsibility-password";
const branch = "main-org-lagos";
const note = {
  complaint: "Synthetic independent GP consultation",
  assessment: "Synthetic clinical assessment",
  plan: "Synthetic care plan",
};
async function fixture() {
  const db = await openTestDatabase();
  await seed(db, password);
  await db.transaction(async (tx) => {
    await tx.run("UPDATE memberships SET branch_id='main-' || organization_id");
    await tx.run(
      "INSERT INTO branches(id,organization_id,name) VALUES ('secondary-lagos','org-lagos','Synthetic second branch')",
    );
    for (const [id, email, role, scope] of [
      ["colleague", "responsibility-gp@synthetic.invalid", "clinician", "general"],
      ["nurse", "responsibility-nurse@synthetic.invalid", "nurse", "nursing"],
      ["tech", "responsibility-tech@synthetic.invalid", "pharmacy-technician", null],
      ["support", "responsibility-support@synthetic.invalid", "zed-support", null],
    ]) {
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,name,password_hash,verified,provider_support_verified) SELECT ?,?,?,'org-lagos',?,password_hash,1,? FROM users WHERE id='doctor-lagos'",
        [id, email, email, "Synthetic responsibility " + id, id === "support" ? 1 : 0],
      );
      await tx.run(
        "INSERT INTO memberships(id,user_id,organization_id,role,branch_id,clinical_verified,clinical_scopes,clinical_review_reference,access_expires_at) VALUES (?,?,'org-lagos','clinician',?,?,?,?,?)",
        [
          id + "-member",
          id,
          branch,
          scope ? 1 : 0,
          JSON.stringify(scope ? [scope] : []),
          scope ? "Synthetic reviewed credentials" : "",
          id === "support" ? new Date(Date.now() + 3600000).toISOString() : null,
        ],
      );
      await tx.run("INSERT INTO membership_roles(membership_id,role_id) VALUES (?,?)", [
        id + "-member",
        "role-org-lagos-" + role,
      ]);
    }
  });
  await db.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO care_areas(id,organization_id,branch_id,name,kind) VALUES ('responsibility-ward','org-lagos','main-org-lagos','Synthetic ward label','ward')",
    );
    await tx.run(
      "INSERT INTO care_admissions(id,patient_id,organization_id,branch_id,care_area_id,kind,active_key,created_by,created_at,request_key,request_payload) VALUES ('responsibility-admission','patient-ade','org-lagos','main-org-lagos','responsibility-ward','inpatient','org-lagos:patient-ade','admin',?,'synthetic-responsibility-admission','{}')",
      [new Date().toISOString()],
    );
    for (const id of ["doctor-lagos", "colleague"]) {
      await tx.run(
        "INSERT INTO admission_team_members(id,admission_id,user_id,duty) VALUES (?,'responsibility-admission',?,'doctor')",
        ["responsibility-team-" + id, id],
      );
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
      const set = response.headers.get("set-cookie");
      if (set) {
        cookie = set.split(";")[0];
      }
      return { status: response.status, data: await response.json() };
    };
  }
  async function login(email) {
    const call = client();
    assert.equal((await call("/auth/login", "POST", { email, password })).status, 200);
    if (email !== "patient@healthpass.test") {
      assert.equal((await call("/auth/mfa/skip", "POST", {})).status, 200);
    }
    return call;
  }
  const admin = await login("admin@healthpass.test");
  const doctor = await login("doctor@healthpass.test");
  const colleague = await login("responsibility-gp@synthetic.invalid");
  const nurse = await login("responsibility-nurse@synthetic.invalid");
  const tech = await login("responsibility-tech@synthetic.invalid");
  const support = await login("responsibility-support@synthetic.invalid");
  const reception = await login("reception@healthpass.test");
  const foreign = await login("ibadan@healthpass.test");
  const patient = await login("patient@healthpass.test");
  const body = {
    patient_id: "patient-ade",
    branch_id: branch,
    consultant_id: "doctor-lagos",
    service: "Synthetic general care service",
    ward: "Synthetic ward label",
    specialty_confirmed: true,
    specialty_review_reference: "Synthetic administrator-reviewed service competence",
    client_request_id: randomUUID(),
  };
  async function assign(extra = {}, call = admin) {
    return call("/care-responsibilities", "POST", { ...body, ...extra });
  }
  async function grant(user, contribute = true) {
    const result = await patient("/professional-access", "POST", {
      recipient_user_id: user,
      recipient_organization_id: "org-lagos",
      scopes: ["general"],
      include_profile: false,
      can_contribute: contribute,
      allow_delegation: false,
      allow_external_delegation: false,
      purpose: "Synthetic ongoing care authority",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      acknowledge_restriction: true,
      client_request_id: randomUUID(),
    });
    assert.equal(result.status, 200);
    return result.data.id;
  }
  return {
    db,
    client,
    admin,
    doctor,
    colleague,
    nurse,
    tech,
    support,
    reception,
    foreign,
    patient,
    body,
    assign,
    grant,
  };
}
const denied = (result) => assert.equal(result.status, 403, JSON.stringify(result.data));
const rejected = (result) =>
  assert.ok([400, 403, 404, 409].includes(result.status), JSON.stringify(result));

test("an accountable consultant does not replace another GP's care, visit assignment or authored records", async () => {
  const f = await fixture();
  try {
    const assigned = await f.assign();
    assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
    const own = await f.patient("/care-responsibilities");
    assert.equal(own.status, 200);
    assert.equal(own.data.responsibilities[0].consultant_id, "doctor-lagos");
    assert.equal(own.data.responsibilities[0].patient_id, "patient-ade");
    const created = await f.colleague("/encounters", "POST", {
      patient_id: "patient-ade",
      ...note,
    });
    assert.equal(created.status, 200);
    assert.equal(
      (await f.colleague(`/encounters/${created.data.id}/sign`, "POST", { version: 1 })).status,
      200,
    );
    denied(
      await f.doctor(`/encounters/${created.data.id}/amend`, "POST", {
        version: 2,
        ...note,
        reason: "Lead is not the author",
      }),
    );
    const arrival = await f.reception("/visits", "POST", {
      patient_id: "patient-ade",
      branch_id: branch,
      assigned_user_id: "colleague",
      client_request_id: randomUUID(),
    });
    assert.equal(arrival.status, 200);
    const responsibility = (await f.admin("/care-responsibilities")).data.responsibilities[0];
    assert.equal(responsibility.consultant_id, "doctor-lagos");
    assert.equal(responsibility.status, "active");
    const view = await f.colleague("/care-responsibilities");
    assert.equal(view.status, 200);
    assert.equal(view.data.responsibilities[0].consultant_id, "doctor-lagos");
    assert.equal(
      (await f.reception(`/visits/${arrival.data.id}`)).data.visit.assigned_user_id,
      "colleague",
    );
    const end = await f.admin(`/care-responsibilities/${assigned.data.id}`, "PATCH", {
      version: assigned.data.version,
      action: "end",
      reason: "Synthetic service completed",
    });
    assert.equal(end.status, 200);
    assert.equal(
      (await f.reception(`/visits/${arrival.data.id}`)).data.visit.assigned_user_id,
      "colleague",
      "ending ongoing accountability does not terminate or reassign the visit",
    );
    const history = (await f.patient("/care-responsibilities")).data.responsibilities[0];
    assert.equal(history.status, "ended");
    assert.equal(history.consultant_id, "doctor-lagos");
    assert.ok(history.history.length >= 2);
    const records = (await f.patient("/patients/patient-ade")).data.encounters;
    assert.equal(records[0].id, created.data.id);
    assert.equal(records[0].author_id, "colleague");
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT * FROM professional_grants WHERE patient_id='patient-ade'"),
        )
      ).length,
      0,
      "assignment creates no patient-sharing grant",
    );
  } finally {
    await f.db.close();
  }
});

test("care team management and candidate eligibility enforce tenant, branch, role and reviewed specialty boundaries", async () => {
  const f = await fixture();
  try {
    const options = await f.admin("/care-responsibilities/options?branch_id=" + branch);
    assert.equal(options.status, 200);
    assert.ok(options.data.patients.some((patient) => patient.id === "patient-ade"));
    assert.ok(!options.data.patients.some((patient) => patient.id === "patient-tunde"));
    assert.ok(options.data.consultants.some((person) => person.id === "doctor-lagos"));
    for (const id of ["admin", "nurse", "tech", "support", "doctor-ibadan"]) {
      assert.ok(
        !options.data.consultants.some((person) => person.id === id),
        id + " is not a reviewed general lead candidate",
      );
    }
    for (const actor of [f.reception, f.nurse, f.tech, f.support, f.doctor]) {
      denied(await f.assign({}, actor));
    }
    assert.equal(
      (await f.nurse("/care-responsibilities")).status,
      200,
      "reviewed nursing staff may view team metadata without managing it",
    );
    for (const actor of [f.reception, f.tech, f.support]) {
      denied(await actor("/care-responsibilities"));
    }
    rejected(await f.assign({ consultant_id: "admin" }));
    rejected(await f.assign({ consultant_id: "nurse" }));
    rejected(await f.assign({ consultant_id: "support" }));
    rejected(await f.assign({ patient_id: "patient-tunde" }));
    rejected(await f.assign({ branch_id: "secondary-lagos" }));
    rejected(await f.assign({ consultant_id: "doctor-ibadan" }));
    rejected(await f.assign({ specialty_confirmed: false }));
    rejected(await f.assign({ specialty_review_reference: "" }));
    await f.db.transaction((tx) => tx.run("UPDATE users SET verified=0 WHERE id='colleague'"));
    const pendingOptions = await f.admin("/care-responsibilities/options?branch_id=" + branch);
    assert.ok(!pendingOptions.data.consultants.some((person) => person.id === "colleague"));
    rejected(await f.assign({ consultant_id: "colleague" }));
    await f.db.transaction((tx) => tx.run("UPDATE users SET verified=1 WHERE id='colleague'"));
    const assigned = await f.assign();
    assert.equal(assigned.status, 200);
    assert.equal((await f.foreign("/care-responsibilities")).data.responsibilities.length, 0);
    rejected(
      await f.foreign(`/care-responsibilities/${assigned.data.id}`, "PATCH", {
        version: 1,
        action: "end",
        reason: "Unrelated tenant",
      }),
    );
    const other = f.client();
    assert.equal(
      (
        await other("/auth/register", "POST", {
          name: "Synthetic unrelated patient",
          email: "responsibility-unrelated@synthetic.invalid",
          password,
        })
      ).status,
      200,
    );
    assert.deepEqual((await other("/care-responsibilities")).data.responsibilities, []);
    const metadata = (await f.admin("/care-responsibilities")).data;
    assert.ok(!JSON.stringify(metadata).includes(note.assessment));
    assert.equal(metadata.responsibilities[0].allergies, undefined);
  } finally {
    await f.db.close();
  }
});

test("consultant assignment cannot create patient authority and loss of authority keeps accountability history", async () => {
  const f = await fixture();
  try {
    const restricted = await f.grant("colleague");
    const unavailable = await f.assign();
    assert.equal(unavailable.status, 409, JSON.stringify(unavailable.data));
    const readOnly = await f.grant("doctor-lagos", false);
    assert.equal((await f.assign()).status, 409);
    const liveGrant = await f.grant("doctor-lagos", true);
    const assigned = await f.assign();
    assert.equal(assigned.status, 200);
    assert.equal(
      (await f.admin("/patients/patient-ade")).status,
      403,
      "administrative responsibility management has no clinical access",
    );
    assert.equal(
      (await f.patient(`/professional-access/${liveGrant}/revoke`, "POST", {})).status,
      200,
    );
    const state = (await f.admin("/care-responsibilities")).data.responsibilities[0];
    assert.equal(state.status, "active");
    assert.equal(state.consultant_id, "doctor-lagos");
    assert.equal(state.access_available, false);
    assert.equal(
      (await f.doctor("/encounters", "POST", { patient_id: "patient-ade", ...note })).status,
      403,
      "lead status cannot bypass a read-only named grant",
    );
    const reassigned = await f.admin(`/care-responsibilities/${assigned.data.id}`, "PATCH", {
      version: 1,
      action: "reassign",
      consultant_id: "colleague",
      reason: "Synthetic responsibility transfer",
      specialty_confirmed: true,
      specialty_review_reference: "Synthetic reviewed service competence",
    });
    assert.equal(reassigned.status, 200, JSON.stringify(reassigned.data));
    const next = (await f.patient("/care-responsibilities")).data.responsibilities[0];
    assert.equal(next.consultant_id, "colleague");
    assert.equal(
      next.service,
      f.body.service,
      "consultant-only reassignment retains the current service",
    );
    assert.equal(next.ward, f.body.ward);
    assert.equal(next.care_setting, "inpatient");
    assert.ok(next.history.length >= 2);
    assert.equal(
      (await f.patient(`/professional-access/${restricted}/revoke`, "POST", {})).status,
      200,
    );
    assert.equal(
      (await f.admin("/care-responsibilities")).data.responsibilities[0].access_available,
      false,
    );
    assert.equal(
      (await f.patient(`/professional-access/${readOnly}/revoke`, "POST", {})).status,
      200,
    );
  } finally {
    await f.db.close();
  }
});

test("reassignment rechecks current credentials, role and branch and rejects stale concurrent changes", async () => {
  const f = await fixture();
  try {
    const assigned = await f.assign();
    assert.equal(assigned.status, 200);
    const reassign = {
      version: 1,
      action: "reassign",
      consultant_id: "colleague",
      reason: "Synthetic specialty reassignment",
      specialty_confirmed: true,
      specialty_review_reference: "Synthetic current service review",
    };
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=0 WHERE user_id='colleague'"),
    );
    rejected(await f.admin(`/care-responsibilities/${assigned.data.id}`, "PATCH", reassign));
    assert.equal(
      (await f.admin("/care-responsibilities")).data.responsibilities[0].consultant_id,
      "doctor-lagos",
    );
    await f.db.transaction((tx) =>
      tx.run(
        "UPDATE memberships SET clinical_verified=1,branch_id='secondary-lagos' WHERE user_id='colleague'",
      ),
    );
    rejected(await f.admin(`/care-responsibilities/${assigned.data.id}`, "PATCH", reassign));
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id=? WHERE user_id='colleague'", [branch]),
    );
    const role = await f.db.transaction((tx) =>
      tx.get("SELECT permissions FROM workspace_roles WHERE id='role-org-lagos-clinician'"),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE workspace_roles SET permissions=? WHERE id='role-org-lagos-clinician'", [
        JSON.stringify(JSON.parse(role.permissions).filter((key) => key !== "notes.sign")),
      ]),
    );
    rejected(await f.admin(`/care-responsibilities/${assigned.data.id}`, "PATCH", reassign));
    await f.db.transaction((tx) =>
      tx.run("UPDATE workspace_roles SET permissions=? WHERE id='role-org-lagos-clinician'", [
        role.permissions,
      ]),
    );
    const concurrent = await Promise.all([
      f.admin(`/care-responsibilities/${assigned.data.id}`, "PATCH", reassign),
      f.admin(`/care-responsibilities/${assigned.data.id}`, "PATCH", {
        version: 1,
        action: "end",
        reason: "Synthetic concurrent ending",
      }),
    ]);
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
    const changed = (await f.admin("/care-responsibilities")).data.responsibilities[0];
    assert.equal(changed.version, 2);
    assert.ok(["active", "ended"].includes(changed.status));
    assert.equal(
      (await f.admin(`/care-responsibilities/${assigned.data.id}`, "PATCH", reassign)).status,
      409,
    );
  } finally {
    await f.db.close();
  }
});

test("responsibility retries create one active record and preserve immutable responsibility events", async () => {
  const f = await fixture();
  try {
    const outcomes = await Promise.all([f.assign(), f.assign()]);
    assert.ok(
      outcomes.every((result) => result.status === 200),
      JSON.stringify(outcomes),
    );
    assert.equal(outcomes[0].data.id, outcomes[1].data.id);
    assert.ok(outcomes.some((result) => result.data.replayed === true));
    const id = outcomes[0].data.id;
    assert.equal((await f.assign()).data.id, id);
    assert.equal((await f.assign({ service: "Synthetic changed service" })).status, 409);
    assert.equal(
      (await f.assign({ client_request_id: randomUUID() })).status,
      409,
      "another request cannot create a second active lead in the same facility",
    );
    await f.db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO branch_patient_links(branch_id,patient_id) VALUES ('secondary-lagos','patient-ade')",
      );
      await tx.run(
        "UPDATE memberships SET branch_id='secondary-lagos' WHERE user_id IN ('admin','colleague')",
      );
    });
    assert.equal(
      (
        await f.assign({
          branch_id: "secondary-lagos",
          consultant_id: "colleague",
          client_request_id: randomUUID(),
        })
      ).status,
      409,
      "one active responsibility is facility-wide rather than one separate lead per branch",
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id=? WHERE user_id IN ('admin','colleague')", [branch]),
    );
    const records = await f.db.transaction((tx) =>
      tx.all(
        "SELECT * FROM care_responsibilities WHERE patient_id='patient-ade' AND organization_id='org-lagos'",
      ),
    );
    assert.equal(records.length, 1);
    const events = await f.db.transaction((tx) =>
      tx.all("SELECT * FROM care_responsibility_events"),
    );
    assert.equal(events.length, 1);
    await assert.rejects(
      () =>
        f.db.transaction((tx) => tx.run("UPDATE care_responsibility_events SET reason='tampered'")),
      /immutable|append-only/i,
    );
    await assert.rejects(
      () => f.db.transaction((tx) => tx.run("DELETE FROM care_responsibility_events")),
      /immutable|append-only/i,
    );
    const ended = await f.admin(`/care-responsibilities/${id}`, "PATCH", {
      version: 1,
      action: "end",
      reason: "Synthetic responsibility ended",
    });
    assert.equal(ended.status, 200);
    const next = await f.assign({ client_request_id: randomUUID() });
    assert.equal(next.status, 200);
    assert.notEqual(next.data.id, id);
    assert.equal(
      (await f.patient("/care-responsibilities")).data.responsibilities.length,
      2,
      "ended history remains alongside a new active responsibility",
    );
  } finally {
    await f.db.close();
  }
});
