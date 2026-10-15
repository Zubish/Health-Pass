import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openTestDatabase } from "./database.mjs";
import { seed } from "../server/seed.mjs";
import { createApi } from "../server/api.mjs";
import { proxyPolicyVersion, verifyProxyEvidence } from "../server/emergency-proxies.mjs";

test("emergency proxy authority, approval, expiry, revocation, scope and immutable patient history", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  await seed(db, "synthetic-proxy-password");
  await db.transaction(async (tx) => {
    for (const id of ["role-org-lagos-clinician", "role-org-ibadan-clinician"]) {
      const r = await tx.get("SELECT permissions FROM workspace_roles WHERE id=?", [id]);
      await tx.run("UPDATE workspace_roles SET permissions=? WHERE id=?", [
        JSON.stringify([...JSON.parse(r.permissions), "emergency.request", "emergency.approve"]),
        id,
      ]);
    }
    await tx.run(
      "INSERT INTO users(id,email,login_email,account_scope,name,password_hash,verified) SELECT 'doctor-second','second@healthpass.test','second@healthpass.test','org-lagos','Second synthetic clinician',password_hash,1 FROM users WHERE id='doctor-lagos'",
    );
    await tx.run(
      "INSERT INTO memberships(id,user_id,organization_id,role,clinical_verified,clinical_scopes) VALUES ('second-membership','doctor-second','org-lagos','clinician',1,'[\"general\"]')",
    );
    await tx.run(
      "INSERT INTO membership_roles(membership_id,role_id) VALUES ('second-membership','role-org-lagos-clinician')",
    );
    await tx.run(
      "INSERT INTO medication_orders(id,patient_id,organization_id,branch_id,prescriber_id,medicine,dose,route,frequency,indication,instructions,starts_at,ends_at,created_at,request_key,request_payload) VALUES ('proxy-medicine','patient-ade','org-lagos','main-org-lagos','doctor-lagos','Synthetic medicine','1 unit','oral','daily','Synthetic indication','Synthetic instructions',?,?,?,'proxy-med-key','{}')",
      [
        new Date().toISOString(),
        new Date(Date.now() + 86400000).toISOString(),
        new Date().toISOString(),
      ],
    );
    await tx.run(
      "INSERT INTO primary_care(patient_id,organization_id,source,changed_at) VALUES ('patient-ade','org-lagos','first_registration',?)",
      [new Date().toISOString()],
    );
    await tx.run(
      "INSERT INTO encounters(id,patient_id,organization_id,author_id,status,note_kind,created_at,updated_at) VALUES ('signed-general','patient-ade','org-lagos','doctor-lagos','signed','general',?,?)",
      [new Date().toISOString(), new Date().toISOString()],
    );
    await tx.run(
      "INSERT INTO note_versions(id,encounter_id,version,author_id,payload,signature_hash,signed_at) VALUES ('signed-version','signed-general',1,'doctor-lagos',?,'synthetic',?)",
      [
        JSON.stringify({ complaint: "Synthetic headache", assessment: "Synthetic assessment" }),
        new Date().toISOString(),
      ],
    );
    await tx.run(
      "INSERT INTO encounters(id,patient_id,organization_id,author_id,status,note_kind,created_at,updated_at) VALUES ('private-draft','patient-ade','org-lagos','doctor-lagos','draft','general',?,?)",
      [new Date().toISOString(), new Date().toISOString()],
    );
  });
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  async function client(email, workspace) {
    let cookie = "";
    const call = async (path, method = "GET", body) => {
      const res = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method,
          headers: { origin: "http://localhost:3000", cookie, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      if (res.headers.get("set-cookie")) {
        cookie = res.headers.get("set-cookie").split(";")[0];
      }
      return { status: res.status, data: await res.json() };
    };
    assert.equal(
      (
        await call("/auth/login", "POST", {
          email,
          password: "synthetic-proxy-password",
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
  const secondClinician = await client("second@healthpass.test", "HP-ORG-LAGOS");
  const patient = await client("patient@healthpass.test");
  const gp = await client("doctor@healthpass.test", "HP-ORG-LAGOS");
  const foreign = await client("ibadan@healthpass.test", "HP-ORG-IBADAN");
  const admin = await client("admin@healthpass.test", "HP-ORG-LAGOS");
  const input = {
    kind: "person",
    email: "ibadan@healthpass.test",
    workspace_code: "HP-ORG-IBADAN",
    scopes: ["general", "medication"],
    include_profile: false,
    accept_policy: true,
    policy_version: proxyPolicyVersion,
  };
  assert.equal((await patient("/proxies", "POST", { ...input, accept_policy: false })).status, 400);
  assert.equal(
    (await patient("/proxies", "POST", { ...input, policy_version: "old" })).status,
    400,
  );
  const invite = await patient("/proxies", "POST", input);
  assert.equal(invite.status, 200, JSON.stringify(invite));
  const id = invite.data.id;
  assert.equal((await patient("/proxies", "POST", input)).status, 409);
  assert.equal((await gp("/proxies/" + id + "/accept", "POST", {})).status, 403);
  assert.equal((await foreign("/notifications")).data.counts.proxies, 1);
  assert.equal((await foreign("/proxies/" + id + "/accept", "POST", {})).status, 200);
  assert.equal(
    (await foreign("/patients/patient-ade")).status,
    403,
    "proxy appointment grants no record reading",
  );
  assert.equal((await admin("/emergency/options?healthpass_id=HP-DEMO-001")).status, 403);
  const options = await gp("/emergency/options?healthpass_id=HP-DEMO-001");
  assert.equal(options.status, 200);
  assert.equal(options.data.proxies.length, 1);
  const req = {
    appointment_id: id,
    scopes: ["general"],
    include_profile: false,
    reason: "Synthetic patient unable to consent; urgent care.",
    patient_unable_to_consent: true,
  };
  assert.equal((await gp("/emergency", "POST", { ...req, scopes: ["nursing"] })).status, 403);
  assert.equal((await gp("/emergency", "POST", { ...req, include_profile: true })).status, 403);
  assert.equal(
    (await gp("/emergency", "POST", { ...req, patient_unable_to_consent: false })).status,
    400,
  );
  assert.equal(
    (await foreign("/emergency", "POST", req)).status,
    403,
    "no self approval via own appointment",
  );
  const created = await gp("/emergency", "POST", req);
  assert.equal(created.status, 200, JSON.stringify(created));
  const request = created.data.id;
  assert.equal((await gp("/emergency", "POST", req)).status, 409);
  assert.equal((await gp("/emergency/" + request + "/records")).status, 403);
  assert.equal(
    (await gp("/emergency/" + request + "/approve", "POST", { reason: "Self" })).status,
    403,
  );
  assert.equal(
    (await foreign("/emergency/" + request + "/decline", "POST", { reason: "" })).status,
    400,
  );
  assert.equal(
    (
      await foreign("/emergency/" + request + "/approve", "POST", {
        reason: "Synthetic emergency confirmed.",
      })
    ).status,
    200,
  );
  assert.equal(
    (await foreign("/emergency/" + request + "/records")).status,
    403,
    "decision proxy still cannot view records",
  );
  assert.equal((await gp("/notifications")).data.counts.proxies, 1);
  const records = await gp("/emergency/" + request + "/records");
  assert.equal(
    (await gp("/notifications")).data.counts.proxies,
    0,
    "viewed emergency approval is no longer unread",
  );
  assert.equal(records.status, 200, JSON.stringify(records));
  assert.equal(records.data.records.length, 1);
  assert.equal(records.data.profile, null);
  assert.equal(
    records.data.summaries.length,
    0,
    "medicines are excluded from a general-only approval",
  );
  assert.equal(records.data.records[0].version_id, "signed-version");
  await db.transaction((tx) =>
    tx.run(
      "UPDATE memberships SET denied_permissions='[\"emergency.request\"]' WHERE user_id='doctor-lagos'",
    ),
  );
  assert.equal((await gp("/emergency/" + request + "/records")).status, 403);
  await db.transaction((tx) =>
    tx.run("UPDATE memberships SET denied_permissions='[]' WHERE user_id='doctor-lagos'"),
  );
  await db.transaction((tx) =>
    tx.run("UPDATE emergency_requests SET access_until='2000-01-01T00:00:00.000Z' WHERE id=?", [
      request,
    ]),
  );
  assert.equal((await gp("/emergency/" + request + "/records")).status, 403);
  const second = (await gp("/emergency", "POST", { ...req, scopes: ["medication"] })).data.id;
  await foreign("/emergency/" + second + "/approve", "POST", { reason: "Synthetic approval" });
  assert.equal((await gp("/notifications")).data.counts.proxies, 1);
  const medicationRecords = await gp("/emergency/" + second + "/records");
  assert.equal(medicationRecords.data.records.length, 0);
  assert.equal(medicationRecords.data.summaries[0].title, "Prescription");
  const unreadRequest = (await gp("/emergency", "POST", req)).data.id;
  await foreign("/emergency/" + unreadRequest + "/approve", "POST", {
    reason: "Synthetic unread approval",
  });
  assert.equal((await gp("/notifications")).data.counts.proxies, 1);
  assert.equal((await patient("/proxies/" + id + "/revoke", "POST", {})).status, 200);
  assert.equal((await gp("/emergency/" + second + "/records")).status, 403);
  assert.equal(
    (await gp("/notifications")).data.counts.proxies,
    0,
    "revoked access leaves no requester alert",
  );
  // Facility proxy decisions must come from an authorised clinician other than the requester.
  const facility = (await patient("/proxies", "POST", { ...input, kind: "facility" })).data.id;
  assert.equal(
    (await admin("/proxies/" + facility + "/accept", "POST", {})).status,
    403,
    "admin alone is not a clinical proxy responder",
  );
  assert.equal((await gp("/proxies/" + facility + "/accept", "POST", {})).status, 200);
  const own = (await gp("/emergency", "POST", { ...req, appointment_id: facility })).data.id;
  assert.equal(
    (await gp("/emergency/" + own + "/approve", "POST", { reason: "Self" })).status,
    403,
  );
  const simultaneous = await Promise.all([
    secondClinician("/emergency/" + own + "/approve", "POST", {
      reason: "Separate clinician confirms emergency",
    }),
    secondClinician("/emergency/" + own + "/decline", "POST", {
      reason: "Concurrent alternative decision",
    }),
  ]);
  assert.deepEqual(simultaneous.map((r) => r.status).sort(), [200, 409]);
  const other = (await foreign("/emergency", "POST", { ...req, appointment_id: facility })).data.id;
  assert.equal(
    (await gp("/emergency/" + other + "/approve", "POST", { reason: "Primary clinician approval" }))
      .status,
    200,
  );
  assert.equal((await foreign("/emergency/" + other + "/records")).status, 200);
  await db.transaction((tx) =>
    tx.run(
      "UPDATE memberships SET denied_permissions='[\"emergency.approve\"]' WHERE user_id='doctor-lagos'",
    ),
  );
  assert.equal(
    (await foreign("/emergency/" + other + "/records")).status,
    403,
    "recheck approver authority after permission revocation",
  );
  await db.transaction((tx) =>
    tx.run("UPDATE memberships SET denied_permissions='[]' WHERE user_id='doctor-lagos'"),
  );
  await db.transaction((tx) =>
    tx.run("UPDATE primary_care SET organization_id='org-ibadan' WHERE patient_id='patient-ade'"),
  );
  assert.equal(
    (await foreign("/emergency/" + other + "/records")).status,
    403,
    "primary facility change disables its authority",
  );
  await db.transaction((tx) =>
    tx.run(
      "INSERT INTO users(id,email,name,password_hash,patient_id,verified) SELECT 'patient-proxy','proxy-patient@healthpass.test','Synthetic patient proxy',password_hash,'patient-tunde',1 FROM users WHERE id='patient-user'",
    ),
  );
  const patientProxy = await client("proxy-patient@healthpass.test");
  const personal = (
    await patient("/proxies", "POST", {
      ...input,
      email: "proxy-patient@healthpass.test",
      workspace_code: undefined,
    })
  ).data.id;
  assert.equal((await patientProxy("/proxies/" + personal + "/accept", "POST", {})).status, 200);
  const personalRequest = (await gp("/emergency", "POST", { ...req, appointment_id: personal }))
    .data.id;
  assert.equal(
    (
      await patientProxy("/emergency/" + personalRequest + "/decline", "POST", {
        reason: "Unable to confirm this emergency",
      })
    ).status,
    200,
  );
  assert.equal((await gp("/emergency/" + personalRequest + "/records")).status, 403);
  assert.equal((await patientProxy("/patients/patient-ade")).status, 403);
  assert.equal(
    (await patientProxy("/proxies/history")).data.events.length,
    0,
    "proxy cannot read the main patient's private history",
  );
  assert.equal((await admin("/proxies/history")).status, 403);
  const history = (await patient("/proxies/history")).data.events;
  assert.ok(history.some((e) => e.action === "Emergency records viewed"));
  assert.ok(history.some((e) => e.action === "Proxy revoked"));
  let previous = "";
  for (const e of [...history].reverse()) {
    assert.equal(e.previous_hash, previous);
    const payload = {
      id: e.id,
      patient_id: e.patient_id,
      sequence: e.sequence,
      resource_id: e.resource_id,
      actor_id: e.actor_id,
      organization_id: e.organization_id,
      action: e.action,
      details: e.details,
      created_at: e.created_at,
      previous_hash: e.previous_hash,
    };
    assert.equal(e.hash, createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
    previous = e.hash;
  }
  const ordered = [...history].reverse();
  const head = { sequence: ordered.at(-1).sequence, hash: ordered.at(-1).hash };
  assert.equal(verifyProxyEvidence(ordered, head), true);
  assert.equal(verifyProxyEvidence(ordered.slice(0, -1), head), false, "detect missing tail");
  assert.equal(
    verifyProxyEvidence(
      ordered.map((e, i) => (i === 0 ? { ...e, action: "changed" } : e)),
      head,
    ),
    false,
    "detect altered evidence",
  );
  await assert.rejects(() =>
    db.transaction((tx) => tx.run("UPDATE proxy_events SET action='changed'")),
  );
  await assert.rejects(() => db.transaction((tx) => tx.run("DELETE FROM proxy_events")));
  await assert.rejects(() =>
    db.transaction((tx) => tx.run("UPDATE patient_proxies SET scopes_json='[]' WHERE id=?", [id])),
  );
  await assert.rejects(() =>
    db.transaction((tx) =>
      tx.run("UPDATE emergency_requests SET reason='rewritten' WHERE id=?", [request]),
    ),
  );
  assert.ok((await patient("/notifications")).data.counts.proxies > 0);
  await patient("/proxies/history/seen", "POST", { event_ids: history.map((e) => e.id) });
  assert.equal((await patient("/notifications")).data.counts.proxies, 0);
});
