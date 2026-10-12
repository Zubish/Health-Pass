import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.mjs";
import { seed } from "../server/seed.mjs";
import { createApi } from "../server/api.mjs";
const password = "synthetic-care-operations-password",
  branch = "main-org-lagos";
const note = {
  complaint: "Synthetic consultation only",
  assessment: "Synthetic findings",
  plan: "Synthetic care plan",
};
async function fixture() {
  const db = await openTestDatabase();
  await seed(db, password);
  await db.transaction(async (tx) => {
    await tx.run("UPDATE memberships SET branch_id='main-'||organization_id");
    for (const [id, role, scope] of [
      ["consultant", "consultant", "general"],
      ["nurse-opd", "nurse", "nursing"],
      ["nurse-ward", "nurse", "nursing"],
      ["pharmacist", "pharmacist", "medication"],
    ]) {
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,name,password_hash,verified) SELECT ?,?,?,'org-lagos',?,password_hash,1 FROM users WHERE id='doctor-lagos'",
        [id, id + "@synthetic.invalid", id + "@synthetic.invalid", "Synthetic " + id],
      );
      await tx.run(
        "INSERT INTO memberships(id,user_id,organization_id,role,branch_id,clinical_verified,clinical_scopes,clinical_review_reference) VALUES (?,?,'org-lagos','clinician',?,1,?,'Synthetic credential review')",
        [id + "-member", id, branch, JSON.stringify([scope])],
      );
      await tx.run("INSERT INTO membership_roles(membership_id,role_id) VALUES (?,?)", [
        id + "-member",
        "role-org-lagos-" + role,
      ]);
    }
  });
  await db.transaction((tx) =>
    tx.run(
      "UPDATE memberships SET consultant_verified=1,consultant_review_reference='Synthetic reviewed consultant qualifications' WHERE user_id='consultant'",
    ),
  );
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  const client = () => {
    let cookie = "";
    return async (path, method = "GET", body) => {
      const r = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method,
          headers: { origin: "http://localhost:3000", cookie, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
      return { status: r.status, data: await r.json() };
    };
  };
  const clients = {};
  for (const [name, email, workspace] of [
    ["admin", "admin@healthpass.test", "HP-ORG-LAGOS"],
    ["adminTwin", "admin@healthpass.test", "HP-ORG-LAGOS"],
    ["gp", "doctor@healthpass.test", "HP-ORG-LAGOS"],
    ["consultant", "consultant@synthetic.invalid", "HP-ORG-LAGOS"],
    ["consultantTwin", "consultant@synthetic.invalid", "HP-ORG-LAGOS"],
    ["opd", "nurse-opd@synthetic.invalid", "HP-ORG-LAGOS"],
    ["ward", "nurse-ward@synthetic.invalid", "HP-ORG-LAGOS"],
    ["pharmacist", "pharmacist@synthetic.invalid", "HP-ORG-LAGOS"],
    ["foreign", "ibadan@healthpass.test", "HP-ORG-IBADAN"],
    ["patient", "patient@healthpass.test", null],
  ]) {
    const c = client();
    const login = await c("/auth/login", "POST", {
      email,
      password,
      ...(workspace
        ? { account_type: "professional", workspace_code: workspace }
        : { account_type: "patient" }),
    });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    if (workspace) assert.equal((await c("/auth/mfa/skip", "POST", {})).status, 200);
    clients[name] = c;
  }
  const ok = async (promise) => {
    const r = await promise;
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const area = async (name, kind) =>
    ok(clients.admin("/care-areas", "POST", { name, kind, branch_id: branch }));
  const admit = async (patientId, areaId) =>
    ok(
      clients.admin("/admissions", "POST", {
        patient_id: patientId,
        care_area_id: areaId,
        client_request_id: randomUUID(),
      }),
    );
  const restrict = async (member, denied = [], ids = [], version = 1) =>
    clients.admin("/workspace/members/" + member + "-member/restrictions", "PATCH", {
      version,
      denied_permissions: denied,
      care_area_restricted: !!ids.length,
      care_area_ids: ids,
      reason: "Synthetic approved work duties",
    });
  const sign = async (c, patient = "patient-ade", kind = "general", visit) => {
    const draft = await ok(
      c("/encounters", "POST", {
        patient_id: patient,
        note_kind: kind,
        ...note,
        ...(visit ? { visit_id: visit } : {}),
        client_request_id: randomUUID(),
      }),
    );
    await ok(c("/encounters/" + draft.id + "/sign", "POST", { version: draft.version, ...note }));
    return draft.id;
  };
  const visit = async (patientId = "patient-ade", areaId) => {
    const v = await ok(
      clients.gp("/visits", "POST", {
        patient_id: patientId,
        branch_id: branch,
        assigned_user_id: "doctor-lagos",
        care_area_id: areaId,
        client_request_id: randomUUID(),
      }),
    );
    const started = await ok(
      clients.gp("/visits/" + v.id, "PATCH", { version: v.version, status: "in-progress" }),
    );
    return { id: v.id, version: started.version };
  };
  const referral = async (source, kind = "advice") =>
    ok(
      clients.gp("/consultant-referrals", "POST", {
        source_encounter_id: source,
        consultant_id: "consultant",
        kind,
        client_request_id: randomUUID(),
      }),
    );
  return { db, ...clients, ok, area, admit, restrict, sign, visit, referral };
}

test("individual restrictions override every role, preserve other staff defaults and survive role edits", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.opd("/auth/me")).data.permissions.includes("notes.create"), true);
    await f.ok(
      f.restrict("nurse-opd", [
        "notes.create",
        "notes.edit",
        "notes.sign",
        "notes.amend",
        "observations.create",
        "visits.document",
        "followups.manage",
      ]),
    );
    assert.equal(
      (
        await f.opd("/encounters", "POST", {
          patient_id: "patient-ade",
          note_kind: "nursing",
          ...note,
        })
      ).status,
      403,
    );
    assert.ok(await f.sign(f.ward, "patient-ade", "nursing"));
    const settings = await f.ok(f.admin("/workspace/settings"));
    const nurse = settings.roles.find((r) => r.template_key === "nurse");
    await f.ok(
      f.admin("/workspace/roles/" + nurse.id, "PATCH", {
        name: nurse.name,
        description: nurse.description,
        clinical_scope: "nursing",
        permissions: [...JSON.parse(nurse.permissions), "referrals.create"],
      }),
    );
    assert.equal((await f.opd("/auth/me")).data.permissions.includes("notes.create"), false);
    assert.equal((await f.ward("/auth/me")).data.permissions.includes("notes.create"), true);
    assert.equal((await f.restrict("nurse-opd", [], [], 1)).status, 409);
    await f.ok(f.restrict("nurse-opd", ["records.view"], [], 2));
    const me = await f.ok(f.opd("/auth/me"));
    assert.equal(me.permissions.includes("referrals.create"), false);
    assert.equal(me.permissions.includes("notes.sign"), false);
    assert.equal(
      (
        await f.foreign("/workspace/members/nurse-opd-member/restrictions", "PATCH", {
          version: 3,
          denied_permissions: [],
          care_area_restricted: false,
          care_area_ids: [],
          reason: "Synthetic",
        })
      ).status,
      403,
    );
    const audit = await f.db.transaction((tx) =>
      tx.all("SELECT * FROM care_workflow_events WHERE action='membership.restrictions_changed'"),
    );
    assert.equal(audit.length, 2);
  } finally {
    await f.db.close();
  }
});

test("OPD and ward scopes filter registry, charts and visits and cannot be overridden by an earlier OPD encounter", async () => {
  const f = await fixture();
  try {
    const opd = await f.area("Synthetic OPD", "outpatient"),
      ward = await f.area("Synthetic ward", "ward");
    await f.ok(f.restrict("nurse-opd", [], [opd.id]));
    await f.ok(f.restrict("nurse-ward", [], [ward.id]));
    const v = await f.visit("patient-ade", opd.id);
    await f.visit("patient-zainab", opd.id);
    await f.admit("patient-zainab", ward.id);
    assert.equal((await f.opd("/patients/patient-ade")).status, 200);
    assert.equal((await f.opd("/patients/patient-zainab")).status, 403);
    assert.equal((await f.ward("/patients/patient-zainab")).status, 200);
    assert.equal((await f.ward("/patients/patient-ade")).status, 403);
    const registry = await f.ok(f.opd("/patients"));
    assert.deepEqual(
      registry.patients.map((p) => p.id),
      ["patient-ade"],
    );
    assert.equal((await f.ward("/visits/" + v.id)).status, 404);
    const visits = await f.ok(f.ward("/visits"));
    assert.equal(visits.visits.length, 0);
    assert.equal(
      (
        await f.opd("/care-areas", "POST", {
          name: "Forbidden area",
          kind: "ward",
          branch_id: branch,
        })
      ).status,
      403,
    );
  } finally {
    await f.db.close();
  }
});

test("admission teams require a real ward episode, retain a lead alongside supporting staff and preserve history on ending", async () => {
  const f = await fixture();
  try {
    const lead = {
      patient_id: "patient-ade",
      branch_id: branch,
      consultant_id: "consultant",
      service: "Synthetic Paediatrics",
      specialty_confirmed: true,
      specialty_review_reference: "Synthetic reviewed specialty",
      client_request_id: randomUUID(),
    };
    assert.equal((await f.admin("/care-responsibilities", "POST", lead)).status, 409);
    const ward = await f.area("Synthetic inpatient ward", "ward"),
      opd = await f.area("Synthetic outpatient", "outpatient");
    assert.equal(
      (
        await f.admin("/admissions", "POST", {
          patient_id: "patient-ade",
          care_area_id: opd.id,
          client_request_id: randomUUID(),
        })
      ).status,
      400,
    );
    const admission = await f.admit("patient-ade", ward.id);
    await f.ok(f.admin("/care-responsibilities", "POST", lead));
    let version = admission.version;
    for (const [user, duty] of [
      ["doctor-lagos", "doctor"],
      ["nurse-ward", "nurse"],
    ]) {
      const r = await f.ok(
        f.admin(`/admissions/${admission.id}/team`, "POST", {
          version,
          user_id: user,
          duty,
          reason: "Synthetic supporting care assignment",
        }),
      );
      version = r.version;
    }
    const chart = await f.ok(f.patient("/admissions"));
    assert.equal(chart.admissions[0].team.filter((t) => t.active).length, 2);
    assert.equal(chart.admissions[0].consultant.consultant_id, "consultant");
    const source = await f.sign(f.gp);
    await f.sign(f.ward, "patient-ade", "nursing");
    assert.equal(
      (
        await f.gp("/consultant-referrals", "POST", {
          source_encounter_id: source,
          consultant_id: "consultant",
          kind: "advice",
          client_request_id: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.foreign(`/admissions/${admission.id}/end`, "POST", {
          version,
          reason: "Synthetic",
          confirm_episode_end: true,
        })
      ).status,
      403,
    );
    await f.ok(
      f.admin(`/admissions/${admission.id}/end`, "POST", {
        version,
        reason: "Synthetic episode completion instruction recorded",
        confirm_episode_end: true,
      }),
    );
    const roster = await f.ok(f.patient("/admissions"));
    assert.equal(roster.admissions[0].status, "ended");
    assert.ok(roster.admissions[0].team.every((t) => !t.active));
    const responsibilities = await f.ok(f.patient("/care-responsibilities"));
    assert.equal(responsibilities.responsibilities[0].status, "ended");
    await assert.rejects(
      f.db.transaction((tx) => tx.run("UPDATE care_workflow_events SET action='tampered'")),
    );
    assert.equal(
      (await f.ok(f.patient("/patients/patient-ade"))).encounters.some((e) => e.id === source),
      true,
    );
  } finally {
    await f.db.close();
  }
});

test("consultant advice accepts now without transferring GP care; decline requires a reason and signed source stays immutable", async () => {
  const f = await fixture();
  try {
    const visit = await f.visit(),
      source = await f.sign(f.gp, "patient-ade", "general", visit.id),
      ref = await f.referral(source);
    assert.equal(
      (
        await f.gp(`/consultant-referrals/${ref.id}/accept`, "POST", {
          version: ref.version,
          decision: "now",
        })
      ).status,
      403,
    );
    const preview = await f.ok(f.consultant(`/consultant-referrals/${ref.id}/source`));
    assert.equal(preview.source.complaint, note.complaint);
    await f.ok(
      f.consultant(`/consultant-referrals/${ref.id}/accept`, "POST", {
        version: ref.version,
        decision: "now",
      }),
    );
    assert.equal((await f.ok(f.gp("/visits/" + visit.id))).visit.assigned_user_id, "doctor-lagos");
    const response = await f.sign(f.consultant);
    await f.ok(
      f.consultant(`/consultant-referrals/${ref.id}/complete`, "POST", {
        version: 2,
        response_encounter_id: response,
      }),
    );
    const second = await f.referral(source);
    assert.equal(
      (
        await f.consultant(`/consultant-referrals/${second.id}/decline`, "POST", {
          version: 1,
          reason: "",
        })
      ).status,
      400,
    );
    await f.ok(
      f.consultant(`/consultant-referrals/${second.id}/decline`, "POST", {
        version: 1,
        reason: "Synthetic service unavailable; alternative care arranged",
      }),
    );
    const patient = await f.ok(f.patient("/consultant-referrals"));
    assert.equal(
      patient.referrals.find((r) => r.id === second.id).decline_reason,
      "Synthetic service unavailable; alternative care arranged",
    );
    assert.equal((await f.foreign(`/consultant-referrals/${ref.id}/source`)).status, 404);
  } finally {
    await f.db.close();
  }
});

test("scheduled transfer retains GP responsibility until due and explicit start; consultant signs their own care and former GP retains authorship", async () => {
  const f = await fixture();
  try {
    const visit = await f.visit(),
      source = await f.sign(f.gp, "patient-ade", "general", visit.id),
      ref = await f.referral(source, "transfer");
    const future = new Date(Date.now() + 3600000).toISOString();
    await f.ok(
      f.consultant(`/consultant-referrals/${ref.id}/accept`, "POST", {
        version: 1,
        decision: "schedule",
        scheduled_at: future,
      }),
    );
    assert.equal((await f.ok(f.gp("/visits/" + visit.id))).visit.assigned_user_id, "doctor-lagos");
    assert.equal(
      (await f.consultant(`/consultant-referrals/${ref.id}/start`, "POST", { version: 2 })).status,
      409,
    );
    const before = await f.ok(f.gp("/visits/" + visit.id));
    assert.equal(
      (
        await f.gp("/visits/" + visit.id, "PATCH", {
          version: before.visit.version,
          status: "completed",
        })
      ).status,
      409,
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE consultant_referrals SET scheduled_at=? WHERE id=?", [
        new Date(Date.now() - 1000).toISOString(),
        ref.id,
      ]),
    );
    const started = await f.ok(
      f.consultant(`/consultant-referrals/${ref.id}/start`, "POST", { version: 2 }),
    );
    assert.equal(started.status, "accepted");
    const transferred = await f.ok(f.consultant("/visits/" + visit.id));
    assert.equal(transferred.visit.assigned_user_id, "consultant");
    assert.equal(
      (await f.consultant(`/consultant-referrals/${ref.id}/start`, "POST", { version: 2 })).status,
      409,
    );
    const gpChart = await f.ok(f.gp("/patients/patient-ade"));
    const own = gpChart.encounters.find((n) => n.id === source);
    assert.equal(own.author_id, "doctor-lagos");
    assert.equal(own.editable, true);
    const response = await f.sign(f.consultant, "patient-ade", "general", visit.id);
    assert.equal(
      (
        await f.consultant(`/consultant-referrals/${ref.id}/complete`, "POST", {
          version: 3,
          response_encounter_id: source,
        })
      ).status,
      400,
    );
    await f.ok(
      f.consultant(`/consultant-referrals/${ref.id}/complete`, "POST", {
        version: 3,
        response_encounter_id: response,
      }),
    );
    const final = await f.ok(f.patient("/patients/patient-ade"));
    assert.equal(final.encounters.find((n) => n.id === source).author_id, "doctor-lagos");
    assert.equal(final.encounters.find((n) => n.id === response).author_id, "consultant");
  } finally {
    await f.db.close();
  }
});

test("referrals cannot grant named patient access, unsupported capabilities or administrator clinical authority", async () => {
  const f = await fixture();
  try {
    const source = await f.sign(f.gp);
    assert.equal(
      (
        await f.admin("/consultant-referrals", "POST", {
          source_encounter_id: source,
          consultant_id: "consultant",
          kind: "advice",
          client_request_id: randomUUID(),
        })
      ).status,
      403,
    );
    await f.ok(
      f.patient("/professional-access", "POST", {
        recipient_user_id: "consultant",
        acknowledge_restriction: true,
        client_request_id: randomUUID(),
        recipient_organization_id: "org-lagos",
        scopes: ["general"],
        include_profile: false,
        can_contribute: true,
        allow_delegation: false,
        allow_external_delegation: false,
        purpose: "Synthetic named consultant access only",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      }),
    );
    assert.equal(
      (
        await f.gp("/consultant-referrals", "POST", {
          source_encounter_id: source,
          consultant_id: "consultant",
          kind: "advice",
          client_request_id: randomUUID(),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.admin("/workspace/roles", "POST", {
          name: "Invented capability",
          permissions: ["developer.override"],
          clinical_scope: null,
        })
      ).status,
      400,
    );
    assert.equal((await f.restrict("nurse-opd", ["invented.permission"])).status, 400);
  } finally {
    await f.db.close();
  }
});

test("an explicitly authorised nurse can refer within their own reviewed scope and consultants can reschedule or cancel with a reason", async () => {
  const f = await fixture();
  try {
    const source = await f.sign(f.ward, "patient-ade", "nursing");
    const fields = {
      source_encounter_id: source,
      consultant_id: "consultant",
      kind: "advice",
      client_request_id: randomUUID(),
    };
    assert.equal((await f.ward("/consultant-referrals", "POST", fields)).status, 403);
    const settings = await f.ok(f.admin("/workspace/settings"));
    const role = settings.roles.find((r) => r.template_key === "nurse");
    await f.ok(
      f.admin("/workspace/roles/" + role.id, "PATCH", {
        name: role.name,
        description: role.description,
        clinical_scope: "nursing",
        permissions: [...JSON.parse(role.permissions), "referrals.create"],
      }),
    );
    const ref = await f.ok(f.ward("/consultant-referrals", "POST", fields));
    const preview = await f.ok(f.consultant(`/consultant-referrals/${ref.id}/source`));
    assert.equal(preview.source.complaint, note.complaint);
    await f.ok(
      f.consultant(`/consultant-referrals/${ref.id}/accept`, "POST", {
        version: 1,
        decision: "schedule",
        scheduled_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    await f.ok(
      f.consultant(`/consultant-referrals/${ref.id}/reschedule`, "POST", {
        version: 2,
        scheduled_at: new Date(Date.now() + 7200000).toISOString(),
      }),
    );
    assert.equal(
      (
        await f.consultant(`/consultant-referrals/${ref.id}/cancel`, "POST", {
          version: 3,
          reason: "",
        })
      ).status,
      400,
    );
    await f.ok(
      f.consultant(`/consultant-referrals/${ref.id}/cancel`, "POST", {
        version: 3,
        reason: "Synthetic alternative service arranged",
      }),
    );
    const inbox = await f.ok(f.ward("/consultant-referrals"));
    assert.equal(inbox.referrals[0].status, "cancelled");
  } finally {
    await f.db.close();
  }
});

test("moving an admission changes current area access, blocks invalid archive or type changes, and removed team members lose care-write authority", async () => {
  const f = await fixture();
  try {
    const first = await f.area("Synthetic ward A", "ward"),
      second = await f.area("Synthetic observation B", "observation");
    await f.ok(f.restrict("nurse-ward", [], [first.id]));
    const admission = await f.admit("patient-ade", first.id);
    await f.ok(
      f.admin(`/admissions/${admission.id}/team`, "POST", {
        version: 1,
        user_id: "nurse-ward",
        duty: "nurse",
        reason: "Synthetic ward staffing",
      }),
    );
    await f.sign(f.ward, "patient-ade", "nursing");
    assert.equal(
      (
        await f.admin(`/care-areas/${first.id}`, "PATCH", {
          name: "Synthetic ward A",
          active: false,
        })
      ).status,
      409,
    );
    await f.ok(
      f.admin(`/admissions/${admission.id}/move`, "POST", {
        version: 2,
        care_area_id: second.id,
        reason: "Synthetic observation transfer",
      }),
    );
    assert.equal((await f.ward("/patients/patient-ade")).status, 403);
    await f.ok(f.restrict("nurse-ward", [], [second.id], 2));
    assert.equal((await f.ward("/patients/patient-ade")).status, 200);
    await f.ok(
      f.admin(`/admissions/${admission.id}/team`, "POST", {
        version: 3,
        user_id: "nurse-ward",
        action: "remove",
        reason: "Synthetic rotation ended",
      }),
    );
    assert.equal(
      (
        await f.ward("/encounters", "POST", {
          patient_id: "patient-ade",
          note_kind: "nursing",
          ...note,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.admin(`/care-areas/${second.id}`, "PATCH", {
          name: "Changed purpose",
          kind: "outpatient",
        })
      ).status,
      400,
    );
    await f.ok(
      f.admin(`/care-areas/${first.id}`, "PATCH", {
        name: "Synthetic archived ward A",
        active: false,
      }),
    );
    const events = await f.db.transaction((tx) =>
      tx.all("SELECT action FROM care_workflow_events WHERE object_id=?", [admission.id]),
    );
    assert.ok(events.some((e) => e.action === "admission.moved"));
  } finally {
    await f.db.close();
  }
});

test("separate-session concurrent admissions and consultant decisions create one episode and one transfer event", async () => {
  const f = await fixture();
  try {
    const area = await f.area("Synthetic concurrency ward", "ward");
    const admissions = await Promise.all(
      [f.admin, f.adminTwin].map((c) =>
        c("/admissions", "POST", {
          patient_id: "patient-zainab",
          care_area_id: area.id,
          client_request_id: randomUUID(),
        }),
      ),
    );
    assert.deepEqual(admissions.map((r) => r.status).sort(), [200, 409]);
    const saved = await f.db.transaction((tx) =>
      tx.all(
        "SELECT id FROM care_admissions WHERE patient_id='patient-zainab' AND status='active'",
      ),
    );
    assert.equal(saved.length, 1);
    const visit = await f.visit(),
      source = await f.sign(f.gp, "patient-ade", "general", visit.id),
      ref = await f.referral(source, "transfer");
    const decisions = await Promise.all(
      [f.consultant, f.consultantTwin].map((c) =>
        c(`/consultant-referrals/${ref.id}/accept`, "POST", { version: 1, decision: "now" }),
      ),
    );
    assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
    const events = await f.db.transaction((tx) =>
      tx.all(
        "SELECT id FROM visit_events WHERE visit_id=? AND action='visit.consultant_transfer'",
        [visit.id],
      ),
    );
    assert.equal(events.length, 1);
  } finally {
    await f.db.close();
  }
});

test("inpatient medication team preserves pharmacist scope and cannot expand into general or nursing care", async () => {
  const f = await fixture();
  try {
    const area = await f.area("Synthetic medication ward", "ward"),
      admission = await f.admit("patient-ade", area.id);
    const body = {
      patient_id: "patient-ade",
      note_kind: "medication",
      ...note,
      client_request_id: randomUUID(),
    };
    assert.equal((await f.pharmacist("/encounters", "POST", body)).status, 403);
    await f.ok(
      f.admin(`/admissions/${admission.id}/team`, "POST", {
        version: admission.version,
        user_id: "pharmacist",
        duty: "medication",
        reason: "Synthetic inpatient medication review",
      }),
    );
    await f.sign(f.pharmacist, "patient-ade", "medication");
    for (const kind of ["general", "nursing"])
      assert.equal(
        (
          await f.pharmacist("/encounters", "POST", {
            ...body,
            note_kind: kind,
            client_request_id: randomUUID(),
          })
        ).status,
        403,
      );
    await f.ok(f.restrict("pharmacist", ["notes.create"]));
    assert.equal(
      (await f.pharmacist("/encounters", "POST", { ...body, client_request_id: randomUUID() }))
        .status,
      403,
    );
  } finally {
    await f.db.close();
  }
});

test("cancelling an outpatient visit closes scheduled transfer requests without deleting referral history", async () => {
  const f = await fixture();
  try {
    const visit = await f.visit(),
      source = await f.sign(f.gp, "patient-ade", "general", visit.id),
      ref = await f.referral(source, "transfer");
    await f.ok(
      f.consultant(`/consultant-referrals/${ref.id}/accept`, "POST", {
        version: ref.version,
        decision: "schedule",
        scheduled_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    await f.ok(
      f.gp(`/visits/${visit.id}`, "PATCH", {
        version: visit.version,
        status: "cancelled",
        reason: "Synthetic cancelled visit",
      }),
    );
    const result = await f.ok(f.patient("/consultant-referrals"));
    assert.equal(result.referrals.find((r) => r.id === ref.id).status, "cancelled");
    assert.equal(
      (await f.consultant(`/consultant-referrals/${ref.id}/start`, "POST", { version: 2 })).status,
      409,
    );
  } finally {
    await f.db.close();
  }
});
