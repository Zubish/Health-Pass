import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.mjs";
import { seed } from "../server/seed.mjs";
import { createApi } from "../server/api.mjs";
async function fixture(t) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const password = "synthetic-department-password";
  await seed(db, password);
  await db.transaction(async (tx) => {
    await tx.run("UPDATE memberships SET branch_id='main-'||organization_id");
    for (const d of ["laboratory", "radiology", "radiographer", "pharmacist"]) {
      const scope = d === "pharmacist" ? "medication" : d === "radiographer" ? "radiology" : d;
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,name,password_hash,verified) SELECT ?,?,?,'org-lagos',?,password_hash,1 FROM users WHERE id='doctor-lagos'",
        [d, d + "@synthetic.invalid", d + "@synthetic.invalid", "Synthetic " + d],
      );
      await tx.run(
        "INSERT INTO memberships(id,user_id,organization_id,role,branch_id,clinical_verified,clinical_scopes) VALUES (?,?,'org-lagos','clinician','main-org-lagos',1,?)",
        [d, d, JSON.stringify([scope])],
      );
      await tx.run("INSERT INTO membership_roles(membership_id,role_id) VALUES (?,?)", [
        d,
        "role-org-lagos-" + d,
      ]);
    }
  });
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  const clients = {};
  for (const [id, email, workspace] of [
    ["gp", "doctor@healthpass.test", "HP-ORG-LAGOS"],
    ["admin", "admin@healthpass.test", "HP-ORG-LAGOS"],
    ["patient", "patient@healthpass.test", null],
    ["foreign", "ibadan@healthpass.test", "HP-ORG-IBADAN"],
    ...["laboratory", "radiology", "radiographer", "pharmacist"].map((d) => [
      d,
      d + "@synthetic.invalid",
      "HP-ORG-LAGOS",
    ]),
  ]) {
    let cookie = "";
    clients[id] = async (path, method = "GET", body) => {
      const r = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method,
          headers: { origin: "http://localhost:3000", cookie, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
      return { status: r.status, data: await r.json() };
    };
    assert.equal(
      (
        await clients[id]("/auth/login", "POST", {
          email,
          password,
          ...(workspace
            ? { account_type: "professional", workspace_code: workspace }
            : { account_type: "patient" }),
        })
      ).status,
      200,
    );
    if (workspace) assert.equal((await clients[id]("/auth/mfa/skip", "POST", {})).status, 200);
  }
  const ok = async (promise) => {
    const r = await promise;
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const order = async (department = "laboratory", extra = {}) =>
    ok(
      clients.gp("/departments/orders", "POST", {
        patient_id: "patient-ade",
        department,
        service: "Synthetic investigation",
        indication: "Synthetic clinical question",
        priority: "routine",
        client_request_id: randomUUID(),
        ...extra,
      }),
    );
  const act = async (client, id, action, extra = {}) => {
    const { order: o } = await ok(client("/departments/orders/" + id));
    return client("/departments/orders/" + id + "/" + action, "POST", {
      version: o.version,
      client_request_id: randomUUID(),
      ...extra,
    });
  };
  return { db, ...clients, ok, order, act };
}
test("laboratory request, collection, signed report, release, review and immutable amendment", async (t) => {
  const f = await fixture(t);
  const { id } = await f.order();
  assert.equal((await f.admin("/departments")).status, 403);
  assert.equal((await f.foreign("/departments/orders/" + id)).status, 404);
  assert.equal(
    (
      await f.radiology("/departments/orders/" + id + "/accept", "POST", {
        version: 1,
        client_request_id: randomUUID(),
      })
    ).status,
    403,
  );
  await f.ok(f.act(f.laboratory, id, "accept"));
  assert.equal((await f.act(f.laboratory, id, "report", { report: "too early" })).status, 409);
  await f.ok(f.act(f.laboratory, id, "start", { reference: "Synthetic specimen S1" }));
  assert.equal(
    (
      await f.act(f.laboratory, id, "report", {
        report: "Synthetic report",
        confirmed: true,
        reference: "Synthetic method",
        critical: true,
      })
    ).status,
    400,
  );
  await f.ok(
    f.act(f.laboratory, id, "report", {
      report: "Synthetic result 4 units; narrative interpretation",
      confirmed: true,
      reference: "Synthetic method",
      critical: true,
      critical_communication: "Synthetic prescriber contacted at recorded test time",
    }),
  );
  assert.equal((await f.ok(f.patient("/departments/orders/" + id))).order.reports.length, 0);
  await f.ok(f.act(f.laboratory, id, "release"));
  assert.equal((await f.ok(f.patient("/departments/orders/" + id))).order.reports.length, 1);
  await f.ok(
    f.act(f.gp, id, "acknowledge", { reason: "Reviewed synthetic result with follow-up plan" }),
  );
  await f.ok(
    f.act(f.laboratory, id, "amend", {
      report: "Corrected synthetic result",
      reference: "Synthetic method",
      reason: "Synthetic transcription correction",
      confirmed: true,
    }),
  );
  await f.ok(f.act(f.laboratory, id, "release"));
  const o = (await f.ok(f.patient("/departments/orders/" + id))).order;
  assert.equal(o.reports.length, 2);
  assert.ok(o.events.every((e) => e.created_at));
  await assert.rejects(
    f.db.transaction((tx) =>
      tx.run("UPDATE department_reports SET report='rewritten' WHERE order_id=?", [id]),
    ),
    /immutable/,
  );
});
test("radiology schedule, examination and release; stale versions and retry safety", async (t) => {
  const f = await fixture(t);
  const { id } = await f.order("radiology");
  const body = { version: 1, client_request_id: randomUUID() };
  await f.ok(f.radiology("/departments/orders/" + id + "/accept", "POST", body));
  assert.equal(
    (await f.ok(f.radiology("/departments/orders/" + id + "/accept", "POST", body))).replayed,
    true,
  );
  assert.equal(
    (
      await f.radiology("/departments/orders/" + id + "/start", "POST", {
        version: 1,
        client_request_id: randomUUID(),
        reference: "Synthetic exam",
      })
    ).status,
    409,
  );
  await f.ok(
    f.act(f.radiology, id, "schedule", {
      scheduled_at: new Date(Date.now() + 3600000).toISOString(),
    }),
  );
  await f.ok(f.act(f.radiology, id, "clarify", { reason: "Confirm synthetic clinical question" }));
  await f.ok(f.act(f.gp, id, "respond", { reason: "Synthetic question clarified" }));
  await f.ok(f.act(f.radiology, id, "start", { reference: "Synthetic examination" }));
  await f.ok(f.act(f.radiology, id, "complete", { reason: "Synthetic examination complete" }));
  await f.ok(
    f.act(f.radiology, id, "report", {
      report: "Synthetic imaging findings",
      reference: "Synthetic modality",
      confirmed: true,
    }),
  );
  await f.ok(f.act(f.radiology, id, "release"));
});
test("pharmacy review and actual fulfilment are separate from prescribing and retain supply history", async (t) => {
  const f = await fixture(t);
  const rx = await f.ok(
    f.gp("/treatment/patients/patient-ade/orders", "POST", {
      confirm_prescription: "confirmed",
      medicine: "Synthetic medicine",
      dose: "1 unit",
      route: "oral",
      frequency: "once daily",
      interval_hours: 24,
      prn: false,
      indication: "Synthetic only",
      instructions: "Synthetic instruction",
      starts_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 86400000).toISOString(),
      client_request_id: randomUUID(),
    }),
  );
  const { id } = await f.order("pharmacy", { medication_order_id: rx.id });
  assert.equal(
    (await f.order("pharmacy", { medication_order_id: rx.id }).catch((e) => ({ error: e })))
      .error instanceof Error,
    true,
  );
  await f.ok(f.act(f.pharmacist, id, "accept"));
  await f.ok(f.act(f.pharmacist, id, "start", { reference: "Synthetic medication review" }));
  await f.ok(
    f.act(f.pharmacist, id, "report", {
      report: "Synthetic review complete",
      reference: "Synthetic review",
      confirmed: true,
    }),
  );
  assert.equal((await f.act(f.pharmacist, id, "release", { quantity: 0 })).status, 400);
  await f.ok(
    f.act(f.pharmacist, id, "release", {
      quantity: 5,
      unit: "units",
      reference: "Synthetic dispense reference",
      counselling: "Synthetic counselling",
    }),
  );
  const o = (await f.ok(f.patient("/departments/orders/" + id))).order;
  assert.equal(JSON.parse(o.events.find((e) => e.action === "release").payload).quantity, 5);
});
test("patient restrictions, revoked permissions and diagnostic-only chart scope remain enforced", async (t) => {
  const f = await fixture(t);
  const { id } = await f.order();
  const chart = await f.ok(f.laboratory("/patients/patient-ade"));
  assert.deepEqual(chart.accessScope.scopes, ["laboratory"]);
  assert.equal(chart.accessScope.includeProfile, false);
  await f.db.transaction((tx) =>
    tx.run(
      "INSERT INTO patient_access_settings(patient_id,restricted,updated_at) VALUES ('patient-ade',1,?)",
      [new Date().toISOString()],
    ),
  );
  assert.equal((await f.laboratory("/departments/orders/" + id)).status, 403);
  assert.equal((await f.ok(f.laboratory("/departments"))).orders.length, 0);
  await f.db.transaction((tx) =>
    tx.run("UPDATE patient_access_settings SET restricted=0 WHERE patient_id='patient-ade'"),
  );
  await f.db.transaction((tx) =>
    tx.run(
      "UPDATE memberships SET denied_permissions='[\"laboratory.work\"]' WHERE id='laboratory'",
    ),
  );
  assert.equal((await f.act(f.laboratory, id, "accept")).status, 403);
});
test("decline and cancellation require reasons and do not erase requests", async (t) => {
  const f = await fixture(t);
  const { id } = await f.order();
  assert.equal((await f.act(f.laboratory, id, "decline")).status, 400);
  await f.ok(f.act(f.laboratory, id, "decline", { reason: "Synthetic service unavailable" }));
  assert.equal((await f.act(f.laboratory, id, "accept")).status, 409);
  const other = await f.order();
  await f.ok(f.act(f.gp, other.id, "cancel", { reason: "Synthetic duplicate clinical request" }));
  assert.equal((await f.ok(f.gp("/departments/orders/" + other.id))).order.status, "cancelled");
});

test("radiographers hand completed examinations to reporting professionals without gaining signing permission", async (t) => {
  const f = await fixture(t),
    { id } = await f.order("radiology");
  await f.ok(f.act(f.radiographer, id, "accept"));
  await f.ok(f.act(f.radiographer, id, "start", { reference: "Synthetic examination" }));
  await f.ok(f.act(f.radiographer, id, "complete", { reason: "Synthetic acquisition complete" }));
  assert.equal(
    (
      await f.act(f.radiographer, id, "report", {
        report: "Unpermitted",
        reference: "Synthetic",
        confirmed: true,
      })
    ).status,
    403,
  );
  await f.ok(f.act(f.radiology, id, "take-report"));
  await f.ok(
    f.act(f.radiology, id, "report", {
      report: "Synthetic interpretation",
      reference: "Synthetic examination",
      confirmed: true,
    }),
  );
  await f.ok(f.act(f.radiology, id, "release"));
  const o = (await f.ok(f.gp("/departments/orders/" + id))).order;
  assert.equal(o.assigned_to, "radiology");
  assert.equal(o.events.find((e) => e.action === "complete").actor_name, "Synthetic radiographer");
});
