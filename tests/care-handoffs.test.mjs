import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.mjs";
import { createApi } from "../server/api.mjs";
import { seed } from "../server/seed.mjs";

const password = "synthetic-handoff-test-password",
  branch = "main-org-lagos";
const clinicalNote = {
  complaint: "Synthetic nursing triage",
  assessment: "Synthetic reviewed triage assessment",
  plan: "Synthetic follow-up plan",
};
async function fixture({
  gpScopes = ["general", "nursing"],
  gpContribute = true,
  nurseGrant = true,
  gpGrant = true,
} = {}) {
  const db = await openTestDatabase();
  await seed(db, password);
  await db.transaction(async (tx) => {
    await tx.run("UPDATE memberships SET branch_id='main-' || organization_id");
    await tx.run(
      "INSERT INTO branches(id,organization_id,name) VALUES ('secondary-lagos','org-lagos','Synthetic second branch')",
    );
    for (const [id, email, scope, role] of [
      ["nurse", "handoff-nurse@synthetic.invalid", "nursing", "nurse"],
      ["colleague", "handoff-colleague@synthetic.invalid", "general", "clinician"],
    ]) {
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,name,password_hash,verified) SELECT ?,?,?,'org-lagos',?,password_hash,1 FROM users WHERE id='doctor-lagos'",
        [id, email, email, "Synthetic handoff " + id],
      );
      await tx.run(
        "INSERT INTO memberships(id,user_id,organization_id,role,branch_id,clinical_verified,clinical_scopes,clinical_review_reference) VALUES (?,?,'org-lagos','clinician',?,1,?,'Synthetic credential fixture')",
        [id + "-member", id, branch, JSON.stringify([scope])],
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
      const set = response.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: response.status, data: await response.json() };
    };
  }
  async function login(email) {
    const call = client();
    assert.equal((await call("/auth/login", "POST", { email, password })).status, 200);
    if (email !== "patient@healthpass.test")
      assert.equal((await call("/auth/mfa/skip", "POST", {})).status, 200);
    return call;
  }
  const patient = await login("patient@healthpass.test"),
    nurse = await login("handoff-nurse@synthetic.invalid"),
    gp = await login("doctor@healthpass.test"),
    colleague = await login("handoff-colleague@synthetic.invalid"),
    foreign = await login("ibadan@healthpass.test"),
    reception = await login("reception@healthpass.test");
  async function grant(userId, scopes, canContribute = true, overrides = {}) {
    const result = await patient("/professional-access", "POST", {
      recipient_user_id: userId,
      recipient_organization_id: "org-lagos",
      scopes,
      include_profile: false,
      can_contribute: canContribute,
      allow_delegation: false,
      allow_external_delegation: false,
      purpose: "Synthetic handoff authority",
      expires_at: new Date(Date.now() + 2 * 86400000).toISOString(),
      acknowledge_restriction: true,
      client_request_id: randomUUID(),
      ...overrides,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.id;
  }
  let nurseGrantId, gpGrantId;
  if (nurseGrant) nurseGrantId = await grant("nurse", ["nursing"]);
  if (gpGrant) gpGrantId = await grant("doctor-lagos", gpScopes, gpContribute);
  const checked = await reception("/visits", "POST", {
    patient_id: "patient-ade",
    branch_id: branch,
    assigned_user_id: "nurse",
    client_request_id: randomUUID(),
  });
  assert.equal(checked.status, 200, JSON.stringify(checked.data));
  const id = checked.data.id;
  const started = await nurse(`/visits/${id}`, "PATCH", {
    version: checked.data.version,
    status: "in-progress",
  });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  async function note(call, kind, overrides = {}) {
    const result = await call("/encounters", "POST", {
      patient_id: "patient-ade",
      visit_id: id,
      note_kind: kind,
      ...clinicalNote,
      ...overrides,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  const source = await note(nurse, "nursing");
  assert.equal(
    (await nurse(`/encounters/${source.id}/sign`, "POST", { version: source.version })).status,
    200,
  );
  async function version() {
    return (await reception(`/visits/${id}`)).data.visit.version;
  }
  async function request(overrides = {}) {
    const body = {
      version: await version(),
      to_user_id: "doctor-lagos",
      source_encounter_id: source.id,
      client_request_id: randomUUID(),
      ...overrides,
    };
    return { body, ...(await nurse(`/visits/${id}/handoffs`, "POST", body)) };
  }
  return {
    db,
    patient,
    nurse,
    gp,
    colleague,
    foreign,
    reception,
    id,
    source,
    nurseGrantId,
    gpGrantId,
    grant,
    note,
    version,
    request,
  };
}
const deny = (result) => assert.equal(result.status, 403, JSON.stringify(result.data));
const reject = (result) =>
  assert.ok([400, 403, 404, 409].includes(result.status), JSON.stringify(result));

test("nursing-to-GP handoff preserves scoped records and author ownership while changing care responsibility", async () => {
  const f = await fixture();
  try {
    const task = await f.nurse(`/visits/${f.id}/follow-ups`, "POST", {
      title: "Synthetic nurse-owned follow-up",
      due_at: new Date(Date.now() + 86400000).toISOString(),
      discipline: "nursing",
      client_request_id: randomUUID(),
    });
    assert.equal(task.status, 200);
    const requested = await f.request();
    assert.equal(requested.status, 200, JSON.stringify(requested.data));
    const pending = (await f.reception(`/visits/${f.id}`)).data.visit;
    assert.equal(pending.assigned_user_id, "nurse");
    assert.equal(
      (await f.gp(`/visits/${f.id}`)).data.clinicalAllowed,
      true,
      "recipient preview still requires existing patient authority",
    );
    const sourcePreview = await f.gp("/patients/patient-ade");
    assert.equal(sourcePreview.status, 200, JSON.stringify(sourcePreview.data));
    assert.ok(sourcePreview.data.encounters.some((note) => note.id === f.source.id));
    deny(
      await f.gp("/encounters", "POST", {
        patient_id: "patient-ade",
        visit_id: f.id,
        note_kind: "general",
        ...clinicalNote,
      }),
    );
    assert.equal(
      (
        await f.nurse(`/visits/${f.id}`, "PATCH", {
          version: requested.data.version,
          status: "completed",
        })
      ).status,
      409,
    );
    const accepted = await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
      version: requested.data.version,
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(
      (await f.reception(`/visits/${f.id}`)).data.visit.assigned_user_id,
      "doctor-lagos",
    );
    const retry = await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
      version: requested.data.version,
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.version, accepted.data.version);
    deny(
      await f.nurse("/encounters", "POST", {
        patient_id: "patient-ade",
        visit_id: f.id,
        note_kind: "nursing",
        ...clinicalNote,
      }),
    );
    deny(
      await f.nurse(`/visits/${f.id}/observations`, "POST", {
        values: { pulse: 75 },
        discipline: "nursing",
        client_request_id: randomUUID(),
      }),
    );
    deny(
      await f.nurse(`/visits/${f.id}/follow-ups`, "POST", {
        title: "Synthetic forbidden new task",
        due_at: new Date(Date.now() + 86400000).toISOString(),
        client_request_id: randomUUID(),
      }),
    );
    assert.equal(
      (
        await f.nurse(`/encounters/${f.source.id}/amend`, "POST", {
          version: 2,
          ...clinicalNote,
          reason: "Synthetic source clarification",
        })
      ).status,
      200,
    );
    deny(
      await f.gp(`/encounters/${f.source.id}/amend`, "POST", {
        version: 3,
        ...clinicalNote,
        reason: "Not my source note",
      }),
    );
    const detail = await f.gp(`/visits/${f.id}`);
    assert.ok(
      detail.data.followUps.some((row) => row.id === task.data.id && row.author_id === "nurse"),
    );
    assert.equal(
      (
        await f.gp(`/visits/${f.id}/follow-ups/${task.data.id}`, "PATCH", {
          version: 1,
          status: "completed",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.nurse(`/visits/${f.id}/follow-ups/${task.data.id}`, "PATCH", {
          version: 1,
          status: "completed",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.gp(`/visits/${f.id}`, "PATCH", {
          version: accepted.data.version,
          status: "completed",
        })
      ).status,
      409,
      "predecessor's signed nursing note cannot finish GP care",
    );
    const gpNote = await f.note(f.gp, "general", { complaint: "Synthetic GP consultation" });
    assert.equal(
      (await f.gp(`/encounters/${gpNote.id}/sign`, "POST", { version: gpNote.version })).status,
      200,
    );
    assert.equal(
      (
        await f.gp(`/visits/${f.id}`, "PATCH", {
          version: accepted.data.version,
          status: "completed",
        })
      ).status,
      200,
    );
    const patientNotes = (await f.patient("/patients/patient-ade")).data.encounters;
    assert.deepEqual(
      new Set(patientNotes.map((note) => note.id)),
      new Set([f.source.id, gpNote.id]),
    );
    assert.equal(patientNotes.find((note) => note.id === f.source.id).versions.length, 2);
    const former = await f.nurse(`/visits/${f.id}`);
    assert.equal(former.data.clinicalAllowed, true);
    assert.ok(!former.data.followUps.some((task) => task.author_id === "doctor-lagos"));
    const handoffs = (await f.reception(`/visits/${f.id}/handoffs`)).data;
    assert.equal(handoffs.handoffs[0].status, "accepted");
    assert.deepEqual(handoffs.sourceNotes, []);
    assert.deepEqual(handoffs.professionals, []);
    assert.ok(!JSON.stringify(handoffs).includes(clinicalNote.assessment));
  } finally {
    await f.db.close();
  }
});

test("handoff request never expands patient authority and rejects operational, foreign or unfinished care", async () => {
  const f = await fixture();
  try {
    const body = {
      version: await f.version(),
      to_user_id: "doctor-lagos",
      source_encounter_id: f.source.id,
      client_request_id: randomUUID(),
    };
    deny(await f.reception(`/visits/${f.id}/handoffs`, "POST", body));
    reject(await f.foreign(`/visits/${f.id}/handoffs`, "POST", body));
    deny(await f.colleague(`/visits/${f.id}/handoffs`, "POST", body));
    reject(await f.request({ to_user_id: "doctor-ibadan" }));
    const draft = await f.note(f.nurse, "nursing", {
      complaint: "Synthetic unfinished nursing draft",
    });
    assert.equal((await f.request()).status, 409);
    assert.equal(
      (await f.nurse(`/encounters/${draft.id}/sign`, "POST", { version: 1 })).status,
      200,
    );
    assert.equal(
      (await f.patient(`/professional-access/${f.gpGrantId}/revoke`, "POST", {})).status,
      200,
    );
    reject(await f.request());
    const readOnly = await f.grant("doctor-lagos", ["general", "nursing"], false);
    reject(await f.request());
    assert.equal(
      (await f.patient(`/professional-access/${readOnly}/revoke`, "POST", {})).status,
      200,
    );
    const narrow = await f.grant("doctor-lagos", ["general"], true);
    reject(await f.request());
    assert.equal(
      (await f.patient(`/professional-access/${narrow}/revoke`, "POST", {})).status,
      200,
    );
    const restoredGrant = await f.grant("doctor-lagos", ["general", "nursing"], true);
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id='secondary-lagos' WHERE user_id='doctor-lagos'"),
    );
    reject(await f.request());
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id=? WHERE user_id='doctor-lagos'", [branch]),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=0 WHERE user_id='doctor-lagos'"),
    );
    reject(await f.request());
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=1 WHERE user_id='doctor-lagos'"),
    );
    const requested = await f.request();
    assert.equal(requested.status, 200);
    assert.equal(
      (await f.patient(`/professional-access/${restoredGrant}/revoke`, "POST", {})).status,
      200,
    );
    const parent = await f.grant("colleague", ["general", "nursing"], true, {
      allow_delegation: true,
    });
    const child = await f.colleague(`/professional-access/${parent}/delegate`, "POST", {
      recipient_user_id: "doctor-lagos",
      recipient_organization_id: "org-lagos",
      scopes: ["general", "nursing"],
      include_profile: false,
      can_contribute: true,
      purpose: "Synthetic delegated handoff eligibility",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      client_request_id: randomUUID(),
    });
    assert.equal(child.status, 200);
    assert.equal(
      (await f.patient(`/professional-access/${parent}/revoke`, "POST", {})).status,
      200,
    );
    deny(
      await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
        version: requested.data.version,
      }),
    );
  } finally {
    await f.db.close();
  }
});

test("acceptance rechecks source version, outgoing drafts and both professionals' current patient authority", async () => {
  const f = await fixture();
  try {
    let requested = await f.request();
    assert.equal(requested.status, 200);
    assert.equal(
      (
        await f.nurse(`/encounters/${f.source.id}/amend`, "POST", {
          version: 2,
          ...clinicalNote,
          reason: "Synthetic clarification after handoff request",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
          version: requested.data.version,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.nurse(`/visits/${f.id}/handoffs/${requested.data.id}/withdraw`, "POST", {
          version: requested.data.version,
        })
      ).status,
      200,
    );
    requested = await f.request();
    assert.equal(requested.status, 200);
    const lateDraft = await f.note(f.nurse, "nursing", {
      complaint: "Synthetic later unfinished draft",
    });
    const draftPreview = await f.gp("/patients/patient-ade");
    assert.equal(draftPreview.status, 200, JSON.stringify(draftPreview.data));
    assert.ok(
      !JSON.stringify(draftPreview.data).includes("Synthetic later unfinished draft"),
      "recipient may preview signed source notes without reading the outgoing professional's draft",
    );
    assert.equal(
      (
        await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
          version: requested.data.version,
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.nurse(`/encounters/${lateDraft.id}/sign`, "POST", { version: 1 })).status,
      200,
    );
    assert.equal(
      (await f.patient(`/professional-access/${f.gpGrantId}/revoke`, "POST", {})).status,
      200,
    );
    deny(
      await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
        version: requested.data.version,
      }),
    );
    await f.grant("doctor-lagos", ["general", "nursing"], true);
    assert.equal(
      (await f.patient(`/professional-access/${f.nurseGrantId}/revoke`, "POST", {})).status,
      200,
    );
    reject(
      await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
        version: requested.data.version,
      }),
    );
    await f.grant("nurse", ["nursing"], true);
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=0 WHERE user_id='nurse'"),
    );
    reject(
      await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
        version: requested.data.version,
      }),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET clinical_verified=1 WHERE user_id='nurse'"),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id='secondary-lagos' WHERE user_id='doctor-lagos'"),
    );
    reject(
      await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
        version: requested.data.version,
      }),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id=? WHERE user_id='doctor-lagos'", [branch]),
    );
    const originalRole = await f.db.transaction((tx) =>
      tx.get("SELECT permissions FROM workspace_roles WHERE id='role-org-lagos-clinician'"),
    );
    const reducedPermissions = JSON.parse(originalRole.permissions).filter(
      (key) => key !== "visits.document",
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE workspace_roles SET permissions=? WHERE id='role-org-lagos-clinician'", [
        JSON.stringify(reducedPermissions),
      ]),
    );
    deny(
      await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
        version: requested.data.version,
      }),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE workspace_roles SET permissions=? WHERE id='role-org-lagos-clinician'", [
        originalRole.permissions,
      ]),
    );
    const accepted = await f.gp(`/visits/${f.id}/handoffs/${requested.data.id}/accept`, "POST", {
      version: requested.data.version,
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(
      (await f.reception(`/visits/${f.id}`)).data.visit.assigned_user_id,
      "doctor-lagos",
    );
  } finally {
    await f.db.close();
  }
});

test("handoff retries, decline, withdrawal, expiry and operational cancellation resolve one pending responsibility", async () => {
  const f = await fixture();
  try {
    let pending = await f.request();
    assert.equal(pending.status, 200);
    const replay = await f.nurse(`/visits/${f.id}/handoffs`, "POST", pending.body);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.id, pending.data.id);
    assert.equal(
      (
        await f.nurse(`/visits/${f.id}/handoffs`, "POST", {
          ...pending.body,
          to_user_id: "colleague",
        })
      ).status,
      409,
    );
    assert.equal((await f.request()).status, 409);
    assert.equal(
      (await f.gp(`/visits/${f.id}/handoffs/${pending.data.id}/decline`, "POST", { version: 1 }))
        .status,
      409,
    );
    deny(
      await f.colleague(`/visits/${f.id}/handoffs/${pending.data.id}/accept`, "POST", {
        version: pending.data.version,
      }),
    );
    const declined = await f.gp(`/visits/${f.id}/handoffs/${pending.data.id}/decline`, "POST", {
      version: pending.data.version,
    });
    assert.equal(declined.status, 200);
    assert.equal((await f.reception(`/visits/${f.id}`)).data.visit.assigned_user_id, "nurse");
    pending = await f.request();
    assert.equal(pending.status, 200);
    deny(
      await f.gp(`/visits/${f.id}/handoffs/${pending.data.id}/withdraw`, "POST", {
        version: pending.data.version,
      }),
    );
    assert.equal(
      (
        await f.nurse(`/visits/${f.id}/handoffs/${pending.data.id}/withdraw`, "POST", {
          version: pending.data.version,
        })
      ).status,
      200,
    );
    pending = await f.request();
    assert.equal(pending.status, 200);
    const stored = await f.db.transaction((tx) =>
      tx.get("SELECT * FROM visit_handoffs WHERE id=?", [pending.data.id]),
    );
    assert.ok(Date.parse(stored.expires_at) - Date.parse(stored.created_at) <= 24 * 60 * 60 * 1000);
    await f.db.transaction((tx) =>
      tx.run("UPDATE visit_handoffs SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", [
        pending.data.id,
      ]),
    );
    reject(
      await f.gp(`/visits/${f.id}/handoffs/${pending.data.id}/accept`, "POST", {
        version: pending.data.version,
      }),
    );
    assert.equal((await f.gp(`/visits/${f.id}`)).data.clinicalAllowed, false);
    assert.equal(
      (
        await f.nurse(`/visits/${f.id}`, "PATCH", {
          version: await f.version(),
          status: "completed",
        })
      ).status,
      409,
      "expired pending request must be resolved before completion",
    );
    const fresh = await f.request();
    assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
    const interruptedDraft = await f.note(f.nurse, "nursing", {
      complaint: "Synthetic unfinished work retained after cancellation",
    });
    const cancelled = await f.reception(`/visits/${f.id}`, "PATCH", {
      version: fresh.data.version,
      status: "cancelled",
    });
    assert.equal(cancelled.status, 200);
    const pendingRows = await f.db.transaction((tx) =>
      tx.all("SELECT * FROM visit_handoffs WHERE visit_id=? AND status='pending'", [f.id]),
    );
    assert.equal(pendingRows.length, 0);
    reject(
      await f.gp(`/visits/${f.id}/handoffs/${fresh.data.id}/accept`, "POST", {
        version: cancelled.data.version,
      }),
    );
    assert.equal(
      (await f.patient("/patients/patient-ade")).data.encounters.length,
      1,
      "cancellation preserves signed nursing history",
    );
    const amended = await f.nurse(`/encounters/${f.source.id}/amend`, "POST", {
      version: 2,
      ...clinicalNote,
      reason: "Synthetic correction after operational cancellation",
    });
    assert.equal(amended.status, 200, JSON.stringify(amended.data));
    assert.equal((await f.patient("/patients/patient-ade")).data.encounters[0].versions.length, 2);
    assert.equal(
      (
        await f.nurse("/encounters", "POST", {
          patient_id: "patient-ade",
          visit_id: f.id,
          note_kind: "nursing",
          ...clinicalNote,
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.nurse(`/encounters/${f.source.id}/sign`, "POST", { version: amended.data.version }))
        .status,
      409,
    );
    assert.equal(
      (
        await f.nurse(`/encounters/${interruptedDraft.id}/sign`, "POST", {
          version: interruptedDraft.version,
        })
      ).status,
      409,
      "cancellation cannot be bypassed by signing an already saved draft",
    );
    const cancelledDraft = (await f.nurse("/patients/patient-ade")).data.encounters.find(
      (note) => note.id === interruptedDraft.id,
    );
    assert.equal(cancelledDraft.editable, false);
    deny(
      await f.gp(`/encounters/${f.source.id}/amend`, "POST", {
        version: amended.data.version,
        ...clinicalNote,
        reason: "Not my source after cancellation",
      }),
    );
    const retainedCancellation = (await f.reception(`/visits/${f.id}`)).data.visit;
    assert.equal(retainedCancellation.status, "cancelled");
    assert.equal(retainedCancellation.version, cancelled.data.version);
  } finally {
    await f.db.close();
  }
});

test("concurrent handoff requests and acceptance switch responsibility once and retain append-only event history", async () => {
  const f = await fixture();
  try {
    const body = {
      version: await f.version(),
      to_user_id: "doctor-lagos",
      source_encounter_id: f.source.id,
      client_request_id: randomUUID(),
    };
    const requested = await Promise.all([
      f.nurse(`/visits/${f.id}/handoffs`, "POST", body),
      f.nurse(`/visits/${f.id}/handoffs`, "POST", body),
    ]);
    assert.ok(requested.every((r) => r.status === 200));
    assert.equal(requested[0].data.id, requested[1].data.id);
    const id = requested[0].data.id,
      version = requested[0].data.version;
    const accepted = await Promise.all([
      f.gp(`/visits/${f.id}/handoffs/${id}/accept`, "POST", { version }),
      f.gp(`/visits/${f.id}/handoffs/${id}/accept`, "POST", { version }),
    ]);
    assert.ok(accepted.every((r) => r.status === 200));
    assert.equal(accepted[0].data.version, accepted[1].data.version);
    const stored = await f.db.transaction((tx) =>
      tx.all("SELECT * FROM visit_handoffs WHERE visit_id=?", [f.id]),
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, "accepted");
    assert.equal(stored[0].pending_key, null);
    const events = await f.db.transaction((tx) =>
      tx.all("SELECT * FROM visit_events WHERE visit_id=?", [f.id]),
    );
    assert.equal(
      events.filter((e) => e.action.includes("handoff") && e.action.includes("accepted")).length,
      1,
    );
    await assert.rejects(
      () => f.db.transaction((tx) => tx.run("DELETE FROM visit_events WHERE visit_id=?", [f.id])),
      /immutable|append-only/i,
    );
    await assert.rejects(
      () =>
        f.db.transaction((tx) =>
          tx.run("DELETE FROM note_versions WHERE encounter_id=?", [f.source.id]),
        ),
      /immutable/i,
    );
  } finally {
    await f.db.close();
  }
});

test("handoff acceptance and outgoing clinical writes serialize against the same visit responsibility", async () => {
  for (const [operation, writeFirst] of [
    ["draft", false],
    ["draft", true],
    ["amend", true],
    ["amend", false],
    ["observation", false],
    ["observation", true],
  ]) {
    const f = await fixture();
    try {
      const pending = await f.request();
      assert.equal(pending.status, 200);
      const accept = () =>
        f.gp(`/visits/${f.id}/handoffs/${pending.data.id}/accept`, "POST", {
          version: pending.data.version,
        });
      const write = () =>
        operation === "draft"
          ? f.nurse("/encounters", "POST", {
              patient_id: "patient-ade",
              visit_id: f.id,
              note_kind: "nursing",
              ...clinicalNote,
              complaint: "Synthetic racing draft",
              client_request_id: randomUUID(),
            })
          : operation === "amend"
            ? f.nurse(`/encounters/${f.source.id}/amend`, "POST", {
                version: 2,
                ...clinicalNote,
                reason: "Synthetic racing source clarification",
              })
            : f.nurse(`/visits/${f.id}/observations`, "POST", {
                values: { pulse: 72 },
                discipline: "nursing",
                client_request_id: randomUUID(),
              });
      const [first, second] = await Promise.all(
        writeFirst ? [write(), accept()] : [accept(), write()],
      );
      const accepted = writeFirst ? second : first,
        written = writeFirst ? first : second;
      const visit = (await f.reception(`/visits/${f.id}`)).data.visit;
      if (writeFirst && (operation === "draft" || operation === "amend")) {
        assert.equal(written.status, 200);
        assert.equal(accepted.status, 409);
        assert.equal(visit.assigned_user_id, "nurse");
      } else {
        assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
        assert.equal(visit.assigned_user_id, "doctor-lagos");
        if (operation === "amend" || writeFirst) assert.equal(written.status, 200);
        else deny(written);
      }
      const unfinished = await f.db.transaction((tx) =>
        tx.all(
          "SELECT id FROM encounters WHERE visit_id=? AND author_id='nurse' AND status='draft'",
          [f.id],
        ),
      );
      if (visit.assigned_user_id === "doctor-lagos")
        assert.equal(
          unfinished.length,
          0,
          "accepted transfer never leaves a newly created outgoing draft",
        );
      const sourceVersions = await f.db.transaction((tx) =>
        tx.all("SELECT version FROM note_versions WHERE encounter_id=? ORDER BY version", [
          f.source.id,
        ]),
      );
      assert.equal(sourceVersions.length, operation === "amend" ? 2 : 1);
    } finally {
      await f.db.close();
    }
  }
});
