import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.mjs";
import { seed } from "../server/seed.mjs";
import { createApi } from "../server/api.mjs";
const password = "synthetic-care-operations-password";
const branch = "main-org-lagos";
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
      if (r.headers.get("set-cookie")) {
        cookie = r.headers.get("set-cookie").split(";")[0];
      }
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
    if (workspace) {
      assert.equal((await c("/auth/mfa/skip", "POST", {})).status, 200);
    }
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
  return { db, api, ...clients, ok, area, admit, restrict, sign, visit, referral };
}

const base = "/treatment/patients/patient-ade";
async function ward(f) {
  const area = await f.area("Synthetic treatment ward", "ward");
  const a = await f.admit("patient-ade", area.id);
  let version = a.version;
  for (const [id, duty] of [
    ["doctor-lagos", "doctor"],
    ["nurse-ward", "nurse"],
  ]) {
    const r = await f.ok(
      f.admin(`/admissions/${a.id}/team`, "POST", {
        version,
        user_id: id,
        duty,
        reason: "Synthetic care team",
      }),
    );
    version = r.version;
  }
  return { ...a, version };
}
function rx(admission) {
  return {
    medicine: "Synthetic medicine 100 mg tablet",
    dose: "100 mg",
    route: "oral",
    frequency: "Every 8 hours",
    interval_hours: 8,
    prn: false,
    indication: "Synthetic fixture only",
    instructions: "Synthetic instruction",
    ends_at: new Date(Date.now() + 86400000).toISOString(),
    confirm_prescription: "confirmed",
    client_request_id: randomUUID(),
    ...(admission ? { admission_id: admission } : {}),
  };
}
test("physician admission/discharge decisions retain identity, reasons and timestamps, and do not grant administrative clinical power", async () => {
  const f = await fixture();
  try {
    const a = await ward(f);
    const body = {
      admission_id: a.id,
      kind: "admit",
      reason: "Synthetic physician reason",
      observations: "Synthetic observation",
      confirm_physician: "confirmed",
      client_request_id: randomUUID(),
    };
    assert.equal((await f.admin(base + "/decisions", "POST", body)).status, 403);
    assert.equal((await f.ward(base + "/decisions", "POST", body)).status, 403);
    const d = await f.ok(f.gp(base + "/decisions", "POST", body));
    assert.equal((await f.ok(f.gp(base + "/decisions", "POST", body))).id, d.id);
    assert.equal(
      (
        await f.admin(`/admissions/${a.id}/end`, "POST", {
          version: a.version,
          reason: "Synthetic end",
          confirm_episode_end: true,
        })
      ).status,
      409,
    );
    const discharge = await f.ok(
      f.gp(base + "/decisions", "POST", {
        ...body,
        kind: "discharge",
        reason: "Synthetic discharge reason",
        client_request_id: randomUUID(),
      }),
    );
    const rows = (await f.ok(f.patient(base))).decisions;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.physician_name && r.decided_at && r.created_at));
    assert.equal(rows.find((r) => r.id === discharge.id).reason, "Synthetic discharge reason");
    await assert.rejects(
      f.db.transaction((tx) => tx.run("UPDATE clinical_admission_decisions SET reason='tampered'")),
    );
    await f.ok(
      f.admin(`/admissions/${a.id}/end`, "POST", {
        version: a.version,
        reason: "Synthetic completed clinical decision",
        confirm_episode_end: true,
      }),
    );
  } finally {
    await f.db.close();
  }
});
test("outpatient signed prescribing validates courses, authorises physicians only, supports exact retries and immutable content", async () => {
  const f = await fixture();
  try {
    const body = rx();
    assert.equal((await f.ward(base + "/orders", "POST", body)).status, 403);
    const o = await f.ok(f.gp(base + "/orders", "POST", body));
    assert.equal((await f.ok(f.gp(base + "/orders", "POST", body))).id, o.id);
    assert.equal((await f.gp(base + "/orders", "POST", { ...body, dose: "changed" })).status, 409);
    await assert.rejects(
      f.db.transaction((tx) =>
        tx.run("UPDATE medication_orders SET dose=? WHERE id=?", ["tampered", o.id]),
      ),
    );
    assert.equal(
      (
        await f.ward(`${base}/orders/${o.id}/administrations`, "POST", {
          outcome: "given",
          dose: body.dose,
          client_request_id: randomUUID(),
        })
      ).status,
      400,
    );
    const patient = await f.ok(f.patient(base));
    assert.equal(patient.orders[0].prescriber_name, "Dr. Ada Nwosu");
    await f.ok(
      f.gp(`${base}/orders/${o.id}/stop`, "POST", {
        version: 1,
        reason: "Synthetic prescription replacement",
      }),
    );
    assert.equal((await f.ok(f.patient(base))).orders[0].status, "stopped");
  } finally {
    await f.db.close();
  }
});
test("inpatient dose outcomes need a current nurse team, medication sharing, valid slot and reason; duplicate administrations cannot occur", async () => {
  const f = await fixture();
  try {
    const a = await ward(f);
    const order = await f.ok(f.gp(base + "/orders", "POST", rx(a.id)));
    const o = (await f.ok(f.patient(base))).orders[0];
    const body = {
      outcome: "given",
      dose: o.dose,
      due_at: o.starts_at,
      observations: "Synthetic observation",
      client_request_id: randomUUID(),
    };
    assert.equal(
      (await f.opd(`${base}/orders/${order.id}/administrations`, "POST", body)).status,
      403,
    );
    await f.ok(f.ward(`${base}/orders/${order.id}/administrations`, "POST", body));
    await f.ok(f.ward(`${base}/orders/${order.id}/administrations`, "POST", body));
    assert.equal(
      (
        await f.ward(`${base}/orders/${order.id}/administrations`, "POST", {
          ...body,
          client_request_id: randomUUID(),
        })
      ).status,
      409,
    );
    const future = new Date(Date.parse(o.starts_at) + 8 * 3600000).toISOString();
    assert.equal(
      (
        await f.ward(`${base}/orders/${order.id}/administrations`, "POST", {
          ...body,
          due_at: future,
          client_request_id: randomUUID(),
        })
      ).status,
      400,
    );
    assert.equal((await f.ok(f.patient(base))).orders[0].administrations.length, 1);
    await assert.rejects(
      f.db.transaction((tx) => tx.run("DELETE FROM medication_administrations")),
    );
    await f.ok(f.restrict("nurse-ward", ["medication.administer"]));
    assert.equal(
      (
        await f.ward(`${base}/orders/${order.id}/administrations`, "POST", {
          ...body,
          client_request_id: randomUUID(),
        })
      ).status,
      403,
    );
  } finally {
    await f.db.close();
  }
});
test("ward observations form longitudinal records independent of visits with measured and recorded time and clinical category filtering", async () => {
  const f = await fixture();
  try {
    const a = await ward(f);
    const body = {
      admission_id: a.id,
      discipline: "nursing",
      values: { temperature: 37, pulse: 80 },
      observations: "Synthetic clinical observation",
      client_request_id: randomUUID(),
    };
    await f.ok(f.ward(base + "/observations", "POST", body));
    await f.ok(
      f.ward(base + "/observations", "POST", {
        ...body,
        values: { temperature: 37.2 },
        client_request_id: randomUUID(),
      }),
    );
    assert.equal((await f.opd(base + "/observations", "POST", body)).status, 403);
    assert.equal(
      (
        await f.ward(base + "/observations", "POST", {
          ...body,
          values: { temperature: 999 },
          client_request_id: randomUUID(),
        })
      ).status,
      400,
    );
    const chart = await f.ok(f.patient(base));
    assert.equal(chart.observations.length, 2);
    assert.ok(
      chart.observations.every(
        (o) => o.observed_at && o.created_at && o.author_name && o.observations,
      ),
    );
    await assert.rejects(
      f.db.transaction((tx) => tx.run("UPDATE ward_observations SET observations='tampered'")),
    );
  } finally {
    await f.db.close();
  }
});
test("fixed inactivity and thirty-day expiry coexist with user-optional eight-hour expiry", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.ok(f.gp("/account/security"))).eightHourLimit, true);
    await f.db.transaction((tx) =>
      tx.run("UPDATE sessions SET created_at=? WHERE user_id=?", [
        new Date(Date.now() - 9 * 3600000).toISOString(),
        "doctor-lagos",
      ]),
    );
    assert.equal((await f.gp("/auth/me")).status, 401);
    await f.ok(f.admin("/account/security", "PATCH", { eight_hour_limit: false }));
    await f.db.transaction((tx) =>
      tx.run("UPDATE sessions SET created_at=?,expires_at=? WHERE user_id=?", [
        new Date(Date.now() - 29 * 86400000).toISOString(),
        new Date(Date.now() + 86400000).toISOString(),
        "admin",
      ]),
    );
    await f.ok(f.admin("/auth/me"));
    await f.db.transaction((tx) =>
      tx.run("UPDATE sessions SET expires_at=? WHERE user_id=?", [
        new Date(Date.now() - 1000).toISOString(),
        "admin",
      ]),
    );
    assert.equal((await f.admin("/auth/me")).status, 401);
    await f.ok(f.patient("/account/security", "PATCH", { eight_hour_limit: false }));
    await f.db.transaction((tx) =>
      tx.run("UPDATE sessions SET last_seen_at=? WHERE user_id=?", [
        new Date(Date.now() - 31 * 60000).toISOString(),
        "patient-user",
      ]),
    );
    assert.equal((await f.patient("/auth/me")).status, 401);
  } finally {
    await f.db.close();
  }
});
test("session review and revocation are scoped to the authenticated identity", async () => {
  const f = await fixture();
  try {
    const s = await f.ok(f.admin("/account/security"));
    assert.ok(s.sessions.length >= 2);
    assert.ok(s.events.length >= 2);
    assert.ok(s.events.some((e) => e.risk.includes("new_device")));
    const other = s.sessions.find((x) => x.id !== s.currentSession);
    assert.equal(
      (await f.gp(`/account/security/sessions/${other.id}/revoke`, "POST", {})).status,
      404,
    );
    await f.ok(f.admin(`/account/security/sessions/${other.id}/revoke`, "POST", {}));
    assert.equal((await f.adminTwin("/auth/me")).status, 401);
    const warning = s.events.find((e) => e.risk.includes("new_device"));
    await f.ok(f.admin(`/account/security/events/${warning.id}/review`, "POST", {}));
    assert.ok(
      (await f.ok(f.admin("/account/security"))).events.find((e) => e.id === warning.id)
        .reviewed_at,
    );
  } finally {
    await f.db.close();
  }
});
async function extraClient(f, email, country = "GB") {
  let cookie = "";
  return async (path, method = "GET", body) => {
    const r = await f.api(
      new Request("http://localhost:3000/api/healthpass" + path, {
        method,
        headers: {
          origin: "http://localhost:3000",
          cookie,
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (Android) Chrome/100",
          "x-healthpass-country": country,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    for (const c of r.headers.getSetCookie()) {
      const pair = c.split(";")[0];
      const name = pair.split("=")[0];
      cookie = cookie
        .split("; ")
        .filter((x) => x && !x.startsWith(name + "="))
        .concat(pair)
        .join("; ");
    }
    return { status: r.status, data: await r.json() };
  };
}
test("new-device/country and failed-password signals are private, reviewable and do not replace credentials", async () => {
  const f = await fixture();
  try {
    const first = await extraClient(f, "doctor@healthpass.test", "GB");
    await f.ok(
      first("/auth/login", "POST", {
        email: "doctor@healthpass.test",
        password,
        workspace_code: "HP-ORG-LAGOS",
        account_type: "professional",
      }),
    );
    await f.ok(first("/auth/mfa/skip", "POST", {}));
    const second = await extraClient(f, "doctor@healthpass.test", "US");
    await f.ok(
      second("/auth/login", "POST", {
        email: "doctor@healthpass.test",
        password,
        workspace_code: "HP-ORG-LAGOS",
        account_type: "professional",
      }),
    );
    await f.ok(second("/auth/mfa/skip", "POST", {}));
    const history = await f.ok(second("/account/security"));
    assert.ok(
      history.events.some(
        (e) => e.risk.includes("country_changed") && e.risk.includes("new_device"),
      ),
    );
    assert.equal(
      (
        await second("/auth/login", "POST", {
          email: "doctor@healthpass.test",
          password: "synthetic-wrong-password",
          workspace_code: "HP-ORG-LAGOS",
          account_type: "professional",
        })
      ).status,
      401,
    );
    assert.ok(
      (await f.ok(second("/account/security"))).events.some((e) => e.action === "failed_signin"),
    );
    assert.ok((await f.ok(second("/auth/me"))).securityAlerts > 0);
    assert.ok(
      (await f.ok(second("/account/security"))).activity.some(
        (e) => e.action.includes("auth") && e.created_at,
      ),
    );
    const foreign = await f.ok(f.foreign("/account/security"));
    assert.ok(foreign.events.every((e) => e.country !== "US"));
  } finally {
    await f.db.close();
  }
});
test("two independent nurse sessions cannot record the same scheduled dose twice", async () => {
  const f = await fixture();
  try {
    const a = await ward(f);
    const order = await f.ok(f.gp(base + "/orders", "POST", rx(a.id)));
    const o = (await f.ok(f.patient(base))).orders[0];
    const other = await extraClient(f, "nurse-ward@synthetic.invalid");
    await f.ok(
      other("/auth/login", "POST", {
        email: "nurse-ward@synthetic.invalid",
        password,
        workspace_code: "HP-ORG-LAGOS",
        account_type: "professional",
      }),
    );
    await f.ok(other("/auth/mfa/skip", "POST", {}));
    const body = {
      outcome: "given",
      dose: o.dose,
      due_at: o.starts_at,
      reason: "",
      observations: "Synthetic dose",
    };
    const outcomes = await Promise.all([
      f.ward(`${base}/orders/${order.id}/administrations`, "POST", {
        ...body,
        client_request_id: randomUUID(),
      }),
      other(`${base}/orders/${order.id}/administrations`, "POST", {
        ...body,
        client_request_id: randomUUID(),
      }),
    ]);
    assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await f.ok(f.patient(base))).orders[0].administrations.length, 1);
  } finally {
    await f.db.close();
  }
});
test("patient category sharing immediately controls medication reads and nursing administration without exposing physician decisions", async () => {
  const f = await fixture();
  try {
    const a = await ward(f);
    const grant = async (id, scopes) =>
      f.ok(
        f.patient("/professional-access", "POST", {
          recipient_user_id: id,
          recipient_organization_id: "org-lagos",
          scopes,
          include_profile: false,
          can_contribute: true,
          allow_delegation: false,
          allow_external_delegation: false,
          purpose: "Synthetic category sharing",
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          acknowledge_restriction: true,
          client_request_id: randomUUID(),
        }),
      );
    await grant("doctor-lagos", ["general", "medication"]);
    await grant("nurse-ward", ["nursing"]);
    const order = await f.ok(f.gp(base + "/orders", "POST", rx(a.id)));
    const chart = await f.ok(f.ward(base));
    assert.equal(chart.orders.length, 0);
    assert.equal(chart.decisions.length, 0);
    await f.ok(
      f.ward(base + "/observations", "POST", {
        admission_id: a.id,
        discipline: "nursing",
        values: { pulse: 80 },
        observations: "Synthetic shared observation",
        client_request_id: randomUUID(),
      }),
    );
    const o = (await f.ok(f.patient(base))).orders[0];
    assert.equal(
      (
        await f.ward(`${base}/orders/${order.id}/administrations`, "POST", {
          outcome: "given",
          dose: o.dose,
          due_at: o.starts_at,
          reason: "",
          observations: "",
          client_request_id: randomUUID(),
        })
      ).status,
      403,
    );
  } finally {
    await f.db.close();
  }
});
test("durable sign-in attempt limits cannot be bypassed by workspace code letter case", async () => {
  const f = await fixture();
  try {
    const client = await extraClient(f, "unknown@synthetic.invalid");
    for (let n = 0; n < 11; n++) {
      const r = await client("/auth/login", "POST", {
        email: "unknown@synthetic.invalid",
        password: "synthetic-invalid-password",
        account_type: "professional",
        workspace_code: n % 2 ? "hp-org-lagos" : "HP-ORG-LAGOS",
      });
      assert.equal(r.status, n < 10 ? 401 : 429);
    }
    const row = await f.db.transaction((tx) =>
      tx.get("SELECT COUNT(*) AS count FROM signin_attempt_limits WHERE attempt_count>10"),
    );
    assert.equal(Number(row.count), 1);
  } finally {
    await f.db.close();
  }
});
test("patient treatment view includes outpatient vitals, observation comments and cancellation reason outside audit", async () => {
  const f = await fixture();
  try {
    const v = await f.visit();
    await f.ok(
      f.gp(`/visits/${v.id}/observations`, "POST", {
        values: { pulse: 75, temperature: 37 },
        observations: "Synthetic outpatient observation",
        client_request_id: randomUUID(),
      }),
    );
    await f.ok(
      f.gp(`/visits/${v.id}`, "PATCH", {
        version: v.version,
        status: "cancelled",
        reason: "Synthetic appointment cancelled at patient request",
      }),
    );
    const chart = await f.ok(f.patient(base));
    assert.ok(
      chart.observations.some(
        (o) =>
          o.source === "visit" &&
          o.observations === "Synthetic outpatient observation" &&
          o.created_at &&
          o.author_name,
      ),
    );
    assert.ok(
      chart.visitHistory.some(
        (e) =>
          e.action === "visit.cancelled" &&
          e.reason === "Synthetic appointment cancelled at patient request" &&
          e.actor_name &&
          e.created_at,
      ),
    );
  } finally {
    await f.db.close();
  }
});
