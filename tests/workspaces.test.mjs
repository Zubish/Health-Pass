import test from "node:test";
import assert from "node:assert/strict";
import { openTestDatabase } from "./database.mjs";
import { createApi } from "../server/api.mjs";
import { totp } from "../server/security.mjs";
const password = "synthetic-workspace-password";
async function fixture() {
  const db = await openTestDatabase();
  const api = createApi(db, { PUBLIC_APP_ORIGIN: "http://localhost:3000" });
  function client() {
    let cookie = "";
    return async (path, method = "GET", body) => {
      const r = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method,
          headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      const c = r.headers.get("set-cookie");
      if (c) cookie = c.split(";")[0];
      return { status: r.status, data: await r.json() };
    };
  }
  async function mfa(c) {
    const setup = await c("/auth/mfa/setup", "POST", {});
    assert.equal(setup.status, 200);
    assert.equal(
      (await c("/auth/mfa/verify", "POST", { code: totp(setup.data.secret) })).status,
      200,
    );
  }
  async function facility(name, email = "owner@synthetic.invalid") {
    const c = client();
    const r = await c("/auth/facility-register", "POST", {
      name: "Synthetic Owner",
      email,
      password,
      facility_name: name,
      facility_type: "clinic",
      address: "Synthetic address",
      branch_name: "Main",
      authority: "confirmed",
    });
    assert.equal(r.status, 200);
    await mfa(c);
    return { c, code: r.data.workspace_code };
  }
  return { db, client, mfa, facility };
}
test("facility-scoped credentials permit reused email/password without crossing workspaces or patient identity", async () => {
  const { db, client, facility } = await fixture();
  try {
    const a = await facility("Synthetic A"),
      b = await facility("Synthetic B");
    const ca = await a.c("/auth/me"),
      cb = await b.c("/auth/me");
    assert.notEqual(ca.data.user.id, cb.data.user.id);
    assert.notEqual(ca.data.organization.id, cb.data.organization.id);
    const p = client();
    assert.equal(
      (
        await p("/auth/register", "POST", {
          name: "Synthetic Patient",
          email: "owner@synthetic.invalid",
          password,
        })
      ).status,
      200,
    );
    const login = client();
    assert.equal(
      (
        await login("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "professional",
          workspace_code: a.code,
        })
      ).status,
      200,
    );
    assert.equal((await login("/auth/me")).data.organization.id, ca.data.organization.id);
    const wrong = client();
    assert.equal(
      (
        await wrong("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "professional",
          workspace_code: "HP-NOTREAL",
        })
      ).status,
      401,
    );
    const noCode = client();
    assert.equal(
      (
        await noCode("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "professional",
        })
      ).status,
      400,
    );
    const patient = client();
    assert.equal(
      (
        await patient("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "patient",
        })
      ).status,
      200,
    );
    assert.equal((await patient("/auth/me")).data.organization, null);
    assert.equal(
      (await a.c("/patients")).status,
      403,
      "workspace ownership is not clinical access",
    );
  } finally {
    await db.close();
  }
});
test("codes request access only; reviewed approval, branch scopes and suspension enforce clinical boundaries", async () => {
  const { db, client, mfa, facility } = await fixture();
  try {
    const a = await facility("Synthetic A"),
      b = await facility("Synthetic B", "other-owner@synthetic.invalid");
    const staff = client();
    assert.equal(
      (
        await staff("/auth/workspace-register", "POST", {
          name: "Synthetic clinician",
          email: "staff@synthetic.invalid",
          password,
          workspace_code: a.code,
          profession: "Doctor",
          registration_number: "SYNTHETIC-ONLY",
        })
      ).status,
      200,
    );
    assert.equal((await staff("/auth/me")).data.pendingMembership, true);
    assert.equal((await staff("/patients")).status, 403);
    const settings = (await a.c("/workspace/settings")).data;
    const member = settings.members.find((m) => m.email === "staff@synthetic.invalid");
    const branch = settings.branches[0].id;
    assert.equal(
      (await b.c("/workspace/members/" + member.id, "PATCH", { action: "suspend" })).status,
      404,
    );
    assert.equal(
      (
        await a.c("/workspace/members/" + member.id, "PATCH", {
          role: "clinician",
          branch_id: branch,
          review_reference: "Synthetic review",
        })
      ).status,
      400,
    );
    const foreign = (await b.c("/workspace/settings")).data.branches[0].id;
    assert.equal(
      (
        await a.c("/workspace/members/" + member.id, "PATCH", {
          role: "clinician",
          branch_id: foreign,
          review_reference: "Synthetic review",
          verified: "confirmed",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await a.c("/workspace/members/" + member.id, "PATCH", {
          role: "clinician",
          branch_id: branch,
          review_reference: "Synthetic reviewed credentials",
          verified: "confirmed",
        })
      ).status,
      200,
    );
    assert.equal(
      (await staff("/patients")).status,
      403,
      "approved professionals choose authenticator verification or skip",
    );
    await mfa(staff);
    const patient = await staff("/patients", "POST", { name: "Synthetic branch patient" });
    assert.equal(patient.status, 200);
    assert.equal((await staff("/patients/" + patient.data.id)).status, 200);
    const draft = await staff("/encounters", "POST", {
      patient_id: patient.data.id,
      complaint: "Synthetic branch consultation",
    });
    assert.equal(draft.status, 200);
    assert.equal(
      (await staff("/patients/" + patient.data.id)).data.encounters[0].id,
      draft.data.id,
    );
    const second = (await a.c("/workspace/branches", "POST", { name: "Second branch" })).data.id;
    assert.equal(
      (
        await a.c("/workspace/members/" + member.id, "PATCH", {
          role: "clinician",
          branch_id: second,
          review_reference: "Synthetic reassignment",
          verified: "confirmed",
        })
      ).status,
      200,
    );
    assert.equal((await staff("/patients")).data.patients.length, 0);
    assert.equal((await staff("/patients/" + patient.data.id)).status, 403);
    assert.equal(
      (
        await staff("/encounters/" + draft.data.id, "PATCH", {
          version: draft.data.version,
          complaint: "Synthetic denied change",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await staff("/encounters/" + draft.data.id + "/sign", "POST", {
          version: draft.data.version,
        })
      ).status,
      403,
    );
    assert.equal(
      (await a.c("/workspace/members/" + member.id, "PATCH", { action: "suspend" })).status,
      200,
    );
    assert.equal((await staff("/patients")).status, 403);
    assert.equal((await staff("/auth/me")).data.pendingMembership, true);
  } finally {
    await db.close();
  }
});

test("sessions renew on activity and expire after thirty idle minutes", async () => {
  const { db, client } = await fixture();
  try {
    const c = client();
    assert.equal(
      (
        await c("/auth/register", "POST", {
          name: "Synthetic Idle",
          email: "idle@synthetic.invalid",
          password,
          dob: "1990-01-01",
        })
      ).status,
      200,
    );
    await db.transaction((tx) =>
      tx.run("UPDATE sessions SET last_seen_at=?", [
        new Date(Date.now() - 29 * 60000).toISOString(),
      ]),
    );
    assert.equal((await c("/auth/me")).status, 200);
    const session = await db.transaction((tx) => tx.get("SELECT last_seen_at FROM sessions"));
    assert.ok(Date.now() - Date.parse(session.last_seen_at) < 5000);
    await db.transaction((tx) =>
      tx.run("UPDATE sessions SET last_seen_at=?", [
        new Date(Date.now() - 31 * 60000).toISOString(),
      ]),
    );
    assert.equal((await c("/auth/me")).status, 401);
    assert.equal((await c("/patients")).status, 401);
    assert.equal(
      (
        await c("/auth/login", "POST", {
          email: "idle@synthetic.invalid",
          password,
          account_type: "patient",
        })
      ).status,
      200,
    );
    assert.equal((await c("/auth/me")).status, 200);
  } finally {
    await db.close();
  }
});

test("workspace confirmation identifies only the requested facility without granting access", async () => {
  const { db, client, facility } = await fixture();
  try {
    const a = await facility("Synthetic Confirmation A"),
      b = await facility("Synthetic Confirmation B");
    const anonymous = client();
    const checked = await anonymous("/auth/workspace-check", "POST", {
      workspace_code: a.code.toLowerCase(),
    });
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.data, {
      workspace: { name: "Synthetic Confirmation A", workspace_code: a.code },
    });
    assert.equal((await anonymous("/auth/me")).status, 401);
    assert.equal((await anonymous("/patients")).status, 401);
    const changed = await anonymous("/auth/workspace-check", "POST", { workspace_code: b.code });
    assert.equal(changed.data.workspace.name, "Synthetic Confirmation B");
    assert.equal(
      (await anonymous("/auth/workspace-check", "POST", { workspace_code: "HP-INVALID" })).status,
      400,
    );
    assert.equal((await anonymous("/auth/workspace-check", "POST", {})).status, 400);
  } finally {
    await db.close();
  }
});

test("facility creators can skip unfinished authenticator setup and sign back into their own workspace", async () => {
  const { db, client } = await fixture();
  try {
    const owner = client();
    const created = await owner("/auth/facility-register", "POST", {
      name: "Synthetic Creator",
      email: "creator@synthetic.invalid",
      password,
      facility_name: "Synthetic Creator Facility",
      facility_type: "hospital",
      address: "Synthetic address",
      branch_name: "Main",
      authority: "confirmed",
    });
    assert.equal(created.status, 200);
    const me = await owner("/auth/me");
    assert.equal(me.data.role, "administrator");
    assert.equal(me.data.pendingMembership, false);
    assert.equal(me.data.mfaRequired, true);
    assert.equal((await owner("/auth/mfa/setup", "POST", {})).status, 200);
    assert.equal((await owner("/auth/mfa/skip", "POST", {})).status, 200);
    assert.equal((await owner("/auth/me")).data.mfaRequired, false);
    assert.equal((await owner("/workspace/settings")).status, 200);
    assert.equal(
      (await owner("/patients")).status,
      403,
      "skipping cannot grant administrator clinical access",
    );
    const state = await db.transaction((tx) =>
      tx.get("SELECT mfa_verified,mfa_skipped FROM sessions"),
    );
    assert.deepEqual({ ...state }, { mfa_verified: 0, mfa_skipped: 1 });
    const event = await db.transaction((tx) =>
      tx.get("SELECT action FROM audits WHERE action='auth.mfa_skipped'"),
    );
    assert.equal(event.action, "auth.mfa_skipped");
    assert.equal((await owner("/auth/logout", "POST", {})).status, 200);
    assert.equal((await owner("/auth/mfa/skip", "POST", {})).status, 401);
    assert.equal(
      (
        await owner("/auth/login", "POST", {
          email: "creator@synthetic.invalid",
          password,
          account_type: "professional",
          workspace_code: created.data.workspace_code,
        })
      ).status,
      200,
    );
    assert.equal((await owner("/auth/me")).data.mfaRequired, true, "the choice is session-scoped");
    assert.equal((await owner("/auth/mfa/skip", "POST", {})).status, 200);
    assert.equal((await owner("/workspace/settings")).status, 200);
    await db.transaction((tx) =>
      tx.run("UPDATE sessions SET last_seen_at=?", [
        new Date(Date.now() - 31 * 60000).toISOString(),
      ]),
    );
    assert.equal((await owner("/auth/mfa/skip", "POST", {})).status, 401);
  } finally {
    await db.close();
  }
});
test("optional authenticator choice preserves enrollment and pending membership restrictions", async () => {
  const { db, client, facility } = await fixture();
  try {
    const owner = await facility("Synthetic Enrolled Owner");
    await owner.c("/auth/logout", "POST", {});
    assert.equal(
      (
        await owner.c("/auth/login", "POST", {
          email: "owner@synthetic.invalid",
          password,
          account_type: "professional",
          workspace_code: owner.code,
        })
      ).status,
      200,
    );
    assert.equal((await owner.c("/auth/me")).data.mfaEnrolled, true);
    assert.equal((await owner.c("/auth/mfa/skip", "POST", {})).status, 200);
    assert.equal((await owner.c("/auth/me")).data.mfaEnrolled, true);
    assert.equal((await owner.c("/workspace/settings")).status, 200);
    const login = {
      email: "owner@synthetic.invalid",
      password,
      account_type: "professional",
      workspace_code: owner.code,
    };
    await owner.c("/auth/logout", "POST", {});
    await owner.c("/auth/login", "POST", login);
    assert.equal((await owner.c("/auth/me")).data.mfaRequired, true);
    assert.equal((await owner.c("/auth/mfa/skip", "POST", { dont_show_again: true })).status, 200);
    await owner.c("/auth/logout", "POST", {});
    const freshDevice = client();
    assert.equal((await freshDevice("/auth/login", "POST", login)).status, 200);
    assert.equal((await freshDevice("/auth/me")).data.mfaRequired, false);
    assert.equal((await freshDevice("/auth/me")).data.mfaEnrolled, true);
    assert.equal((await freshDevice("/workspace/settings")).status, 200);
    const otherFacility = await facility("Synthetic Separate Facility", "owner@synthetic.invalid");
    await otherFacility.c("/auth/logout", "POST", {});
    await otherFacility.c("/auth/login", "POST", { ...login, workspace_code: otherFacility.code });
    assert.equal((await otherFacility.c("/auth/me")).data.mfaRequired, true);
    const staff = client();
    assert.equal(
      (
        await staff("/auth/workspace-register", "POST", {
          name: "Synthetic Pending",
          email: "pending@synthetic.invalid",
          password,
          workspace_code: owner.code,
          profession: "Pharmacy Technician",
        })
      ).status,
      200,
    );
    assert.equal((await staff("/auth/mfa/skip", "POST", {})).status, 403);
    assert.equal((await staff("/auth/mfa/skip", "POST", { dont_show_again: true })).status, 403);
    assert.equal((await staff("/patients")).status, 403);
    assert.equal((await client()("/auth/mfa/skip", "POST", {})).status, 401);
  } finally {
    await db.close();
  }
});

async function requestStaff(client, owner, code, email, profession = "Synthetic professional") {
  const staff = client();
  assert.equal(
    (
      await staff("/auth/workspace-register", "POST", {
        name: email,
        email,
        password,
        workspace_code: code,
        profession,
        registration_number: "SYNTHETIC-REVIEW-ONLY",
      })
    ).status,
    200,
  );
  const settings = (await owner("/workspace/settings")).data;
  return { staff, member: settings.members.find((m) => m.email === email), settings };
}
async function approveRole(owner, member, settings, roleIds, extra = {}) {
  return owner("/workspace/members/" + member.id, "PATCH", {
    role_ids: roleIds,
    branch_id: settings.branches[0].id,
    review_reference: "Synthetic identity review",
    verified: "confirmed",
    ...extra,
  });
}

test("workspace roles isolate tenants, revoke access immediately and retain creator administration", async () => {
  const { db, client, facility } = await fixture();
  try {
    const a = await facility("Synthetic Role A"),
      b = await facility("Synthetic Role B");
    const { staff, member, settings } = await requestStaff(
      client,
      a.c,
      a.code,
      "roles@synthetic.invalid",
    );
    for (const name of [
      "General practitioner",
      "Nurse / midwife",
      "Pharmacist",
      "Pharmacy technician",
    ])
      assert.ok(settings.roles.some((r) => r.name === name));
    const created = await a.c("/workspace/roles", "POST", {
      name: "Front desk coordinator",
      description: "Synthetic operational role",
      permissions: ["registry.view", "registry.create"],
    });
    assert.equal(created.status, 200);
    assert.equal(
      (await b.c("/workspace/settings")).data.roles.some((r) => r.id === created.data.id),
      false,
    );
    assert.equal(
      (
        await b.c("/workspace/roles/" + created.data.id, "PATCH", {
          name: "Cross tenant",
          permissions: [],
        })
      ).status,
      404,
    );
    const foreign = (await b.c("/workspace/settings")).data.roles[0].id;
    assert.equal((await approveRole(a.c, member, settings, [foreign])).status, 400);
    assert.equal(
      (
        await approveRole(a.c, member, settings, [
          created.data.id,
          settings.roles.find((r) => r.template_key === "accountant").id,
        ])
      ).status,
      200,
    );
    await staff("/auth/mfa/skip", "POST", {});
    assert.equal((await staff("/auth/me")).data.jobRoles.length, 2);
    assert.equal((await staff("/patients")).status, 200);
    assert.equal((await staff("/patients", "POST", { name: "Synthetic registered" })).status, 200);
    assert.equal(
      (await staff("/encounters", "POST", { patient_id: "missing", complaint: "Synthetic" }))
        .status,
      403,
    );
    assert.equal(
      (
        await staff("/workspace/roles", "POST", {
          name: "Escalation",
          permissions: ["roles.manage", "workspace.view"],
        })
      ).status,
      403,
    );
    assert.equal(
      (await a.c("/workspace/roles", "POST", { name: "front desk coordinator", permissions: [] }))
        .status,
      409,
    );
    assert.equal(
      (
        await a.c("/workspace/roles", "POST", {
          name: "Future prescription",
          permissions: ["prescriptions.sign"],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await a.c("/workspace/roles", "POST", {
          name: "Missing read dependency",
          permissions: ["notes.sign"],
          clinical_scope: "general",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await a.c("/workspace/roles/" + created.data.id, "PATCH", {
          name: "Front desk coordinator",
          permissions: [],
        })
      ).status,
      200,
    );
    assert.equal((await staff("/patients")).status, 403);
    assert.deepEqual((await staff("/auth/me")).data.permissions, []);
    const admin = settings.roles.find((r) => r.template_key === "administrator");
    assert.equal(
      (
        await a.c("/workspace/roles/" + admin.id, "PATCH", {
          name: admin.name,
          permissions: [],
          active: false,
        })
      ).status,
      200,
    );
    assert.equal((await a.c("/workspace/settings")).status, 200);
    assert.equal((await a.c("/patients")).status, 403);
    assert.equal(
      (
        await a.c("/workspace/roles", "POST", {
          name: "Owner retained administration",
          permissions: [],
        })
      ).status,
      200,
    );
    const audit = await db.transaction((tx) =>
      tx.get("SELECT action FROM audits WHERE action='role.updated'"),
    );
    assert.equal(audit.action, "role.updated");
  } finally {
    await db.close();
  }
});

test("clinical roles require reviewed scope and cannot sign other professionals or disciplines", async () => {
  const { db, client, facility } = await fixture();
  try {
    const a = await facility("Synthetic Clinical Roles");
    const gp = await requestStaff(
      client,
      a.c,
      a.code,
      "gp@synthetic.invalid",
      "General practitioner",
    );
    const gpRole = gp.settings.roles.find((r) => r.template_key === "gp");
    assert.equal((await approveRole(a.c, gp.member, gp.settings, [gpRole.id])).status, 400);
    assert.equal(
      (
        await approveRole(a.c, gp.member, gp.settings, [gpRole.id], {
          clinical_verified: "confirmed",
          clinical_review_reference: "Synthetic GP scope review",
        })
      ).status,
      200,
    );
    await gp.staff("/auth/mfa/skip", "POST", {});
    const patient = await gp.staff("/patients", "POST", {
      name: "Synthetic Clinical Scope Patient",
    });
    assert.equal(patient.status, 200);
    const note = {
      patient_id: patient.data.id,
      complaint: "Synthetic scope note",
      assessment: "Synthetic assessment",
      plan: "Synthetic plan",
    };
    const gnote = await gp.staff("/encounters", "POST", { ...note, note_kind: "general" });
    assert.equal(gnote.status, 200);
    assert.equal(
      (await gp.staff("/encounters", "POST", { ...note, note_kind: "medication" })).status,
      403,
    );
    const nurse = await requestStaff(client, a.c, a.code, "nurse@synthetic.invalid", "Nurse");
    const nurseRole = nurse.settings.roles.find((r) => r.template_key === "nurse");
    assert.equal(
      (
        await approveRole(a.c, nurse.member, nurse.settings, [nurseRole.id], {
          clinical_verified: "confirmed",
          clinical_review_reference: "Synthetic nursing scope review",
        })
      ).status,
      200,
    );
    await nurse.staff("/auth/mfa/skip", "POST", {});
    const nnote = await nurse.staff("/encounters", "POST", { ...note, note_kind: "nursing" });
    assert.equal(nnote.status, 200);
    assert.equal(
      (await nurse.staff("/encounters/" + gnote.data.id + "/sign", "POST", { version: 1 })).status,
      403,
    );
    assert.equal(
      (await gp.staff("/encounters/" + nnote.data.id + "/sign", "POST", { version: 1 })).status,
      403,
    );
    assert.equal(
      (await nurse.staff("/encounters/" + nnote.data.id + "/sign", "POST", { version: 1 })).status,
      200,
    );
    const tech = await requestStaff(
      client,
      a.c,
      a.code,
      "tech@synthetic.invalid",
      "Pharmacy technician",
    );
    const techRole = tech.settings.roles.find((r) => r.template_key === "pharmacy-technician");
    assert.equal((await approveRole(a.c, tech.member, tech.settings, [techRole.id])).status, 200);
    await tech.staff("/auth/mfa/skip", "POST", {});
    assert.equal((await tech.staff("/patients")).status, 200);
    assert.equal((await tech.staff("/patients/" + patient.data.id)).status, 403);
    assert.equal(
      (
        await a.c("/workspace/roles/" + techRole.id, "PATCH", {
          name: techRole.name,
          permissions: ["registry.view", "records.view"],
          clinical_scope: "general",
        })
      ).status,
      200,
    );
    assert.equal(
      (await tech.staff("/patients/" + patient.data.id)).status,
      403,
      "role editing does not establish clinical verification",
    );
    assert.equal(
      (
        await approveRole(a.c, tech.member, tech.settings, [techRole.id], {
          provider_support_verified: 1,
        })
      ).status,
      400,
    );
    const onlyView = await a.c("/workspace/roles", "POST", {
      name: "Registered record reviewer",
      permissions: ["registry.view", "records.view"],
      clinical_scope: "general",
    });
    assert.equal(
      (
        await approveRole(a.c, gp.member, gp.settings, [onlyView.data.id], {
          clinical_verified: "confirmed",
          clinical_review_reference: "Synthetic changed access",
        })
      ).status,
      200,
    );
    assert.equal((await gp.staff("/patients/" + patient.data.id)).status, 200);
    assert.equal(
      (await gp.staff("/encounters/" + gnote.data.id + "/sign", "POST", { version: 1 })).status,
      403,
    );
  } finally {
    await db.close();
  }
});

test("Zed Tech support requires operator identity verification and an expiring nonclinical facility grant", async () => {
  const { db, client, facility } = await fixture();
  try {
    const a = await facility("Synthetic Support Facility");
    const request = await requestStaff(
      client,
      a.c,
      a.code,
      "support@synthetic.invalid",
      "Zed Tech support",
    );
    const role = request.settings.roles.find((r) => r.template_key === "zed-support"),
      gp = request.settings.roles.find((r) => r.template_key === "gp");
    const future = new Date(Date.now() + 3600000).toISOString();
    assert.equal(
      (
        await approveRole(a.c, request.member, request.settings, [role.id], {
          access_expires_at: future,
          provider_support_verified: 1,
        })
      ).status,
      400,
    );
    await db.transaction((tx) =>
      tx.run("UPDATE users SET provider_support_verified=1 WHERE id=?", [request.member.user_id]),
    );
    assert.equal((await approveRole(a.c, request.member, request.settings, [role.id])).status, 400);
    assert.equal(
      (
        await approveRole(a.c, request.member, request.settings, [role.id], {
          access_expires_at: new Date(Date.now() + 48 * 3600000).toISOString(),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await approveRole(a.c, request.member, request.settings, [role.id, gp.id], {
          access_expires_at: future,
          clinical_verified: "confirmed",
          clinical_review_reference: "Synthetic review",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await a.c("/workspace/roles/" + role.id, "PATCH", {
          name: role.name,
          permissions: ["workspace.view", "records.view"],
          clinical_scope: "general",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await approveRole(a.c, request.member, request.settings, [role.id], {
          access_expires_at: future,
        })
      ).status,
      200,
    );
    await request.staff("/auth/mfa/skip", "POST", {});
    const info = await request.staff("/workspace/settings");
    assert.equal(info.status, 200);
    assert.deepEqual(info.data.members, []);
    assert.equal((await request.staff("/patients")).status, 403);
    assert.equal((await request.staff("/audit")).status, 403);
    assert.equal(
      (await request.staff("/workspace/branches", "POST", { name: "Escalation" })).status,
      403,
    );
    await db.transaction((tx) =>
      tx.run("UPDATE memberships SET access_expires_at=? WHERE id=?", [
        new Date(Date.now() - 1000).toISOString(),
        request.member.id,
      ]),
    );
    assert.equal((await request.staff("/auth/me")).data.accessExpired, true);
    assert.equal((await request.staff("/workspace/settings")).status, 403);
    const grant = await db.transaction((tx) =>
      tx.get("SELECT action FROM audits WHERE action='support.granted'"),
    );
    assert.equal(grant.action, "support.granted");
  } finally {
    await db.close();
  }
});
