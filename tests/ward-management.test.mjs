import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "./database.mjs";
import { seed } from "../server/seed.mjs";
import { createApi } from "../server/api.mjs";

async function fixture(t) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const password = "synthetic-ward-management-password";
  await seed(db, password);
  await db.transaction(async (tx) => {
    await tx.run("UPDATE memberships SET branch_id='main-'||organization_id");
    await tx.run(
      "INSERT INTO branches(id,organization_id,name) VALUES ('other-branch','org-lagos','Other synthetic branch')",
    );
  });
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  async function client(email, workspace = "HP-ORG-LAGOS") {
    let cookie = "";
    const call = async (path, method = "GET", body) => {
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
    await ok(
      call("/auth/login", "POST", {
        email,
        password,
        account_type: "professional",
        workspace_code: workspace,
      }),
    );
    await ok(call("/auth/mfa/skip", "POST", {}));
    return call;
  }
  const admin = await client("admin@healthpass.test");
  const head = await client("doctor@healthpass.test");
  const other = await client("ibadan@healthpass.test", "HP-ORG-IBADAN");
  const post = (c, path, body) => ok(c(path, "POST", body));
  const department = await post(admin, "/ward-management/departments", {
    branch_id: "main-org-lagos",
    name: "Medicine",
  });
  const second = await post(admin, "/ward-management/departments", {
    branch_id: "main-org-lagos",
    name: "Surgery",
  });
  const ward = await post(admin, "/ward-management/areas", {
    department_id: department.id,
    name: "Female ward",
    kind: "ward",
    quantity: 2,
    unit_kind: "room",
  });
  const outside = await post(admin, "/ward-management/areas", {
    department_id: second.id,
    name: "Surgical ward",
    kind: "ward",
  });
  const grant = await post(admin, "/ward-management/grants", {
    branch_id: "main-org-lagos",
    department_id: department.id,
    user_id: "doctor-lagos",
    capabilities: ["areas", "staff", "placement", "teams"],
    reason: "Synthetic department leadership",
  });
  return { db, admin, head, other, ward, outside, grant, department, post, client };
}
async function ok(p) {
  const r = await p;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

test("department heads are scoped, cannot redelegate, and revocation takes effect without sign-out", async (t) => {
  const { admin, head, other, ward, outside, grant, post } = await fixture(t);
  const summary = await ok(head("/ward-management"));
  assert.deepEqual(
    summary.areas.map((a) => a.id),
    [ward.id],
  );
  assert.equal(summary.units.length, 2);
  assert.equal((await head("/workspace/settings")).status, 403);
  await ok(
    admin(`/ward-management/grants/${grant.id}`, "PATCH", {
      version: 1,
      capabilities: ["placement"],
      reason: "Limit duties",
    }),
  );
  assert.equal(
    (
      await head("/ward-management/units", "POST", {
        care_area_id: ward.id,
        quantity: 1,
        kind: "room",
        prefix: "Not allowed",
      })
    ).status,
    403,
  );
  await ok(
    admin(`/ward-management/grants/${grant.id}`, "PATCH", {
      version: 2,
      capabilities: ["areas", "staff", "placement", "teams"],
      reason: "Restore reviewed duties",
    }),
  );
  assert.equal(
    (
      await head("/ward-management/units", "POST", {
        care_area_id: outside.id,
        quantity: 1,
        kind: "room",
        prefix: "Room",
      })
    ).status,
    403,
  );
  assert.equal(
    (await head("/ward-management/grants", "POST", { user_id: "reception" })).status,
    403,
  );
  assert.equal((await other("/ward-management")).status, 403);
  assert.equal(
    (
      await head("/ward-management/departments", "POST", {
        branch_id: "main-org-lagos",
        name: "Unauthorized",
      })
    ).status,
    403,
  );
  await post(admin, `/ward-management/grants/${grant.id}/revoke`, {
    version: 3,
    reason: "Synthetic reassignment",
  });
  assert.equal((await head("/ward-management")).status, 403);
  assert.equal(
    (
      await head("/ward-management/units", "POST", {
        care_area_id: ward.id,
        quantity: 1,
        kind: "room",
        prefix: "No",
      })
    ).status,
    403,
  );
});

test("room placement prevents double occupancy, preserves history, validates transfers and releases ended occupancy", async (t) => {
  const { admin, head, ward, outside, post, db } = await fixture(t);
  const units = (await ok(head("/ward-management"))).units;
  const a = await post(admin, "/admissions", {
    patient_id: "patient-ade",
    care_area_id: ward.id,
    client_request_id: randomUUID(),
  });
  const b = await post(admin, "/admissions", {
    patient_id: "patient-zainab",
    care_area_id: ward.id,
    client_request_id: randomUUID(),
  });
  const place = (id, version, unit, area = ward.id) =>
    head(`/ward-management/admissions/${id}/place`, "POST", {
      version,
      unit_id: unit,
      care_area_id: area,
      reason: "Synthetic bed allocation",
    });
  assert.equal((await ok(head("/notifications"))).counts.wards, 2);
  await ok(place(a.id, 1, units[0].id));
  assert.equal((await ok(head("/notifications"))).counts.wards, 1);
  assert.equal((await place(b.id, 1, units[0].id)).status, 409);
  assert.equal((await place(a.id, 1, units[1].id)).status, 409);
  assert.equal((await place(a.id, 2, null, outside.id)).status, 403);
  assert.equal(
    (
      await head(`/ward-management/units/${units[0].id}`, "PATCH", {
        version: 1,
        name: "Room Alpha",
        active: false,
        reason: "Close",
      })
    ).status,
    409,
  );
  await ok(
    head(`/ward-management/units/${units[0].id}`, "PATCH", {
      version: 1,
      name: "Room Alpha",
      active: true,
      reason: "Rename",
    }),
  );
  assert.equal(
    (
      await head("/ward-management/units", "POST", {
        care_area_id: ward.id,
        parent_id: units[0].id,
        quantity: 2,
        kind: "bed",
        prefix: "Alpha bed",
      })
    ).status,
    409,
  );
  await post(admin, `/admissions/${a.id}/end`, {
    version: 2,
    reason: "Synthetic episode ended",
    confirm_episode_end: true,
  });
  await ok(place(b.id, 1, units[0].id));
  const events = await db.transaction((tx) =>
    tx.all(
      "SELECT * FROM care_workflow_events WHERE object_id=? AND action='ward.patient_placed'",
      [a.id],
    ),
  );
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].payload).to_unit, units[0].id);
  await assert.rejects(() =>
    db.transaction((tx) => tx.run("DELETE FROM care_workflow_events WHERE id=?", [events[0].id])),
  );
});

test("room coverage enforces current patient location and removing last coverage fails closed", async (t) => {
  const { admin, head, ward, post, db } = await fixture(t);
  const units = (await ok(admin("/ward-management"))).units.filter(
    (u) => u.care_area_id === ward.id,
  );
  const a = await post(admin, "/admissions", {
    patient_id: "patient-ade",
    care_area_id: ward.id,
    client_request_id: randomUUID(),
  });
  await post(admin, `/ward-management/admissions/${a.id}/place`, {
    version: 1,
    care_area_id: ward.id,
    unit_id: units[0].id,
    reason: "Synthetic allocation",
  });
  const coverage = await post(admin, "/ward-management/staff", {
    care_area_id: ward.id,
    unit_id: units[0].id,
    user_id: "doctor-lagos",
    duty: "doctor",
    reason: "Synthetic coverage",
  });
  assert.equal((await head("/patients/patient-ade")).status, 200);
  assert.equal((await head("/patients/patient-zainab")).status, 403);
  await post(admin, `/ward-management/admissions/${a.id}/place`, {
    version: 2,
    care_area_id: ward.id,
    unit_id: units[1].id,
    reason: "Synthetic transfer",
  });
  assert.equal((await head("/patients/patient-ade")).status, 403);
  await post(admin, `/ward-management/staff/${coverage.id}/remove`, {
    version: 1,
    reason: "Coverage ended",
  });
  assert.equal((await head("/patients/patient-ade")).status, 403);
  const m = await db.transaction((tx) =>
    tx.get("SELECT ward_assignment_required FROM memberships WHERE user_id='doctor-lagos'"),
  );
  assert.equal(m.ward_assignment_required, 1);
  await post(admin, "/ward-management/staff/doctor-lagos/unrestrict", {
    reason: "Return to outpatient work",
  });
  assert.equal((await head("/patients/patient-ade")).status, 200);
});

test("rooms with beds require bed placement and room coverage includes its beds", async (t) => {
  const { admin, head, ward, post } = await fixture(t);
  let summary = await ok(admin("/ward-management"));
  const room = summary.units.find((u) => u.care_area_id === ward.id);
  await post(head, "/ward-management/units", {
    care_area_id: ward.id,
    parent_id: room.id,
    kind: "bed",
    quantity: 2,
    prefix: "A bed",
  });
  summary = await ok(head("/ward-management"));
  const bed = summary.units.find((u) => u.parent_id === room.id);
  const a = await post(admin, "/admissions", {
    patient_id: "patient-ade",
    care_area_id: ward.id,
    client_request_id: randomUUID(),
  });
  assert.equal(
    (
      await head(`/ward-management/admissions/${a.id}/place`, "POST", {
        version: 1,
        care_area_id: ward.id,
        unit_id: room.id,
        reason: "Placement",
      })
    ).status,
    400,
  );
  await post(head, `/ward-management/admissions/${a.id}/place`, {
    version: 1,
    care_area_id: ward.id,
    unit_id: bed.id,
    reason: "Placement",
  });
  await post(admin, "/ward-management/staff", {
    care_area_id: ward.id,
    unit_id: room.id,
    user_id: "doctor-lagos",
    duty: "doctor",
    reason: "Cover room",
  });
  assert.equal((await head("/patients/patient-ade")).status, 200);
  await post(head, `/ward-management/admissions/${a.id}/team`, {
    version: 2,
    user_id: "doctor-lagos",
    duty: "doctor",
    reason: "Assigned doctor",
  });
  assert.equal(
    (
      await head(`/ward-management/units/${room.id}`, "PATCH", {
        version: 1,
        name: "A",
        active: false,
        reason: "Close",
      })
    ).status,
    409,
  );
});

test("branch managers can manage their branch but cannot reach other branches or edit roles", async (t) => {
  const { db, admin, head, grant, post } = await fixture(t);
  await post(admin, `/ward-management/grants/${grant.id}/revoke`, {
    version: 1,
    reason: "Change leadership scope",
  });
  await post(admin, "/ward-management/grants", {
    branch_id: "main-org-lagos",
    user_id: "doctor-lagos",
    capabilities: ["areas"],
    reason: "Synthetic branch manager",
  });
  await post(head, "/ward-management/departments", {
    branch_id: "main-org-lagos",
    name: "Paediatrics",
  });
  assert.equal(
    (
      await head("/ward-management/departments", "POST", {
        branch_id: "other-branch",
        name: "Not permitted",
      })
    ).status,
    404,
  );
  assert.equal(
    (await head("/workspace/roles", "POST", { name: "Escalate", permissions: ["roles.manage"] }))
      .status,
    403,
  );
  await db.transaction((tx) =>
    tx.run(
      "UPDATE memberships SET denied_permissions='[\"areas.manage\"]' WHERE user_id='doctor-lagos'",
    ),
  );
  assert.equal(
    (
      await head("/ward-management/departments", "POST", {
        branch_id: "main-org-lagos",
        name: "Denied",
      })
    ).status,
    403,
  );
});

test("assigned ward doctors can document but coverage never grants prescribing or other clinical scopes", async (t) => {
  const { admin, head, ward, post, db } = await fixture(t);
  const a = await post(admin, "/admissions", {
    patient_id: "patient-ade",
    care_area_id: ward.id,
    client_request_id: randomUUID(),
  });
  assert.ok(a.id);
  await post(admin, "/ward-management/staff", {
    care_area_id: ward.id,
    user_id: "doctor-lagos",
    duty: "doctor",
    reason: "Synthetic ward coverage",
  });
  const note = {
    patient_id: "patient-ade",
    note_kind: "general",
    complaint: "Synthetic follow-up",
    assessment: "Synthetic observation",
    plan: "Synthetic plan",
    client_request_id: randomUUID(),
  };
  await post(head, "/encounters", note);
  assert.equal(
    (
      await head("/encounters", "POST", {
        ...note,
        note_kind: "nursing",
        client_request_id: randomUUID(),
      })
    ).status,
    403,
  );
  await db.transaction((tx) =>
    tx.run(
      "UPDATE memberships SET denied_permissions='[\"records.view\"]' WHERE user_id='doctor-lagos'",
    ),
  );
  assert.equal((await head("/patients/patient-ade")).status, 403);
});
