import test from "node:test";
import assert from "node:assert/strict";
import { openTestDatabase } from "./database.mjs";
import { createApi } from "../server/api.mjs";
import { seed } from "../server/seed.mjs";
import { revealSecret } from "../server/security.mjs";
import { deliverPatientEmails } from "../server/patient-email.mjs";

const password = "synthetic-onboarding-password";
const key = "ab".repeat(32);
const branch = "main-org-lagos";
const otherBranch = "main-org-ibadan";
async function fixture() {
  const db = await openTestDatabase();
  await seed(db, password);
  await db.transaction(async (tx) => {
    await tx.run("UPDATE memberships SET branch_id='main-' || organization_id");
    await tx.run(
      "INSERT INTO branches(id,organization_id,name) VALUES ('second-lagos','org-lagos','Synthetic second branch')",
    );
  });
  const config = { PUBLIC_APP_ORIGIN: "http://localhost:3000", HEALTHPASS_AUTH_KEY: key };
  const api = createApi(db, config);
  function client() {
    let cookie = "";
    return async (path, method = "GET", body) => {
      const response = await api(
        new Request("http://localhost:3000/api/healthpass" + path, {
          method,
          headers: { cookie, origin: config.PUBLIC_APP_ORIGIN, "content-type": "application/json" },
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
  const reception = await login("reception@healthpass.test");
  const doctor = await login("doctor@healthpass.test");
  const partner = await login("ibadan@healthpass.test");
  const admin = await login("admin@healthpass.test");
  const patient = await login("patient@healthpass.test");
  async function register(
    email = "new-provisional@synthetic.invalid",
    call = reception,
    overrides = {},
  ) {
    const result = await call("/patients", "POST", {
      name: "Synthetic provisional patient",
      dob: "1995-01-01",
      ...(email ? { email, identity_confirmed: true } : {}),
      ...overrides,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  async function invitation(patientId) {
    const row = await db.transaction((tx) =>
      tx.get(
        "SELECT c.*,o.encrypted_payload FROM patient_claims c JOIN patient_email_outbox o ON o.id=c.id WHERE c.patient_id=? AND c.consumed_at IS NULL AND c.revoked_at IS NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 1",
        [patientId],
      ),
    );
    assert.ok(row);
    const message = JSON.parse(revealSecret(row.encrypted_payload, key));
    const url = new URL(message.url);
    return {
      claim_id: row.id,
      token: new URLSearchParams(url.hash.slice(1)).get("claim-token"),
      row,
      message,
    };
  }
  async function claim(invite, call = client(), extra = {}) {
    return {
      call,
      ...(await call("/auth/patient-claim", "POST", {
        claim_id: invite.claim_id,
        token: invite.token,
        password,
        confirm_registration: true,
        keep_primary: false,
        ...extra,
      })),
    };
  }
  async function accessRequest(call = partner, email = "patient@healthpass.test", extra = {}) {
    return call("/facility-access-requests", "POST", {
      email,
      purpose: "Synthetic requested care",
      identity_confirmed: true,
      review_reference: "Synthetic patient-present identity check",
      ...extra,
    });
  }
  async function signed(call = doctor, patientId = "patient-ade") {
    const created = await call("/encounters", "POST", {
      patient_id: patientId,
      complaint: "Synthetic old facility history marker",
      assessment: "Synthetic assessment",
      plan: "Synthetic follow-up",
    });
    assert.equal(created.status, 200);
    assert.equal(
      (await call(`/encounters/${created.data.id}/sign`, "POST", { version: 1 })).status,
      200,
    );
    return created.data.id;
  }
  return {
    db,
    config,
    client,
    login,
    reception,
    doctor,
    partner,
    admin,
    patient,
    register,
    invitation,
    claim,
    accessRequest,
    signed,
  };
}
const reject = (result) =>
  assert.ok([400, 401, 403, 404, 409].includes(result.status), JSON.stringify(result));

test("facility provisional activation claims exactly its own identity and retains clinical provenance without leaking tokens", async () => {
  const f = await fixture();
  try {
    const registered = await f.register();
    assert.equal(registered.activation, "awaiting_email_configuration");
    assert.ok(registered.id);
    assert.ok(!JSON.stringify(registered).includes("claim-token"));
    const noteId = await f.signed(f.doctor, registered.id);
    const invite = await f.invitation(registered.id);
    assert.ok(invite.row.encrypted_payload.startsWith("enc:"));
    assert.notEqual(invite.row.token_hash, invite.token);
    assert.ok(
      !JSON.stringify(invite.row).replace(invite.row.encrypted_payload, "").includes(invite.token),
    );
    const metadata = await f.reception("/patient-activation?patient_id=" + registered.id);
    assert.equal(metadata.status, 200);
    assert.equal(metadata.data.delivery, "awaiting_email_configuration");
    assert.ok(!JSON.stringify(metadata.data).includes(invite.token));
    const anonymous = f.client();
    const preview = await anonymous("/auth/patient-claim", "POST", {
      claim_id: invite.claim_id,
      token: invite.token,
      review: true,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.name, "Synthetic provisional patient");
    assert.equal(Object.hasOwn(preview.data, "encounters"), false);
    assert.equal(Object.hasOwn(preview.data, "phone"), false);
    reject(
      await anonymous("/auth/patient-claim", "POST", {
        claim_id: invite.claim_id,
        token: invite.token,
        password,
        confirm_registration: false,
        keep_primary: false,
      }),
    );
    const claimed = await f.claim(invite, anonymous, { keep_primary: true });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
    assert.equal((await anonymous("/auth/me")).data.user.patient_id, registered.id);
    const chart = await anonymous("/patients/" + registered.id);
    assert.equal(chart.status, 200);
    assert.equal(chart.data.encounters[0].id, noteId);
    assert.equal(chart.data.encounters[0].author_id, "doctor-lagos");
    assert.equal(chart.data.encounters[0].versions.length, 1);
    assert.equal((await anonymous("/primary-care")).data.primary.organization_id, "org-lagos");
    const address = await f.db.transaction((tx) =>
      tx.get("SELECT * FROM patient_addresses WHERE patient_id=?", [registered.id]),
    );
    assert.ok(address.claimed_by && address.verified_at);
    reject(await f.claim(invite, f.client()));
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT id FROM users WHERE patient_id=?", [registered.id]),
        )
      ).length,
      1,
    );
    const audits = (await anonymous("/audit")).data.audits;
    assert.ok(audits.some((row) => row.action === "patient.account_claimed"));
    assert.ok(!JSON.stringify(audits).includes(invite.token));
  } finally {
    await f.db.close();
  }
});

test("activation resend, expiry, wrong tokens and scope checks cannot claim old charts or merge duplicate addresses", async () => {
  const f = await fixture();
  try {
    const registered = await f.register();
    const original = await f.invitation(registered.id);
    reject(
      await f.client()("/auth/patient-claim", "POST", {
        claim_id: original.claim_id,
        token: "0".repeat(64),
        review: true,
      }),
    );
    assert.equal((await f.partner("/patient-activation?patient_id=" + registered.id)).status, 404);
    assert.equal(
      (await f.reception("/patient-activation?patient_id=patient-zainab")).status,
      404,
      "legacy source records are not newly claimable",
    );
    reject(
      await f.reception("/patient-activation", "POST", {
        patient_id: registered.id,
        email: "new-provisional@synthetic.invalid",
        review_reference: "Synthetic check",
      }),
    );
    assert.equal(
      (
        await f.reception("/patient-activation", "POST", {
          patient_id: registered.id,
          email: "new-provisional@synthetic.invalid",
          identity_confirmed: true,
          review_reference: "Synthetic verified contact",
        })
      ).status,
      200,
    );
    const resent = await f.invitation(registered.id);
    assert.notEqual(resent.claim_id, original.claim_id);
    reject(await f.claim(original));
    await f.db.transaction((tx) =>
      tx.run("UPDATE patient_claims SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", [
        resent.claim_id,
      ]),
    );
    reject(await f.claim(resent));
    const noEmail = await f.register(null);
    assert.equal(noEmail.activation, "no_email");
    reject(
      await f.reception("/patient-activation", "POST", {
        patient_id: noEmail.id,
        email: "patient@healthpass.test",
        identity_confirmed: true,
        review_reference: "Synthetic duplicate contact",
      }),
    );
    assert.equal(
      (
        await f.reception("/patient-activation", "POST", {
          patient_id: noEmail.id,
          email: "attached-contact@synthetic.invalid",
          identity_confirmed: true,
          review_reference: "Synthetic checked own contact",
        })
      ).status,
      200,
    );
    reject(
      await f.reception("/patient-activation", "POST", {
        patient_id: noEmail.id,
        email: "different-contact@synthetic.invalid",
        identity_confirmed: true,
        review_reference: "Synthetic unsolicited email change",
      }),
    );
    const attached = await f.claim(await f.invitation(noEmail.id));
    assert.equal(attached.status, 200);
    assert.equal((await attached.call("/primary-care")).data.primary, null);
  } finally {
    await f.db.close();
  }
});

test("patient email reservations and concurrent claims preserve one identity while professional credentials remain independent", async () => {
  const f = await fixture();
  try {
    const professional = f.client();
    const email = "same-professional-patient@synthetic.invalid";
    assert.equal(
      (
        await professional("/auth/workspace-register", "POST", {
          workspace_code: "HP-ORG-LAGOS",
          name: "Synthetic separate professional",
          email,
          password,
          profession: "Synthetic role",
          registration_number: "SYNTHETIC-ONLY",
        })
      ).status,
      200,
    );
    const registered = await f.register(email);
    const invite = await f.invitation(registered.id);
    const attempts = await Promise.all([f.claim(invite), f.claim(invite)]);
    assert.equal(attempts.filter((result) => result.status === 200).length, 1);
    assert.ok(attempts.some((result) => [400, 409].includes(result.status)));
    const professionalMe = (await professional("/auth/me")).data;
    assert.equal(professionalMe.user.patient_id, null);
    const users = await f.db.transaction((tx) =>
      tx.all("SELECT id,account_scope,patient_id FROM users WHERE COALESCE(login_email,email)=?", [
        email,
      ]),
    );
    assert.equal(users.length, 2);
    assert.notEqual(users[0].id, users[1].id);
    const collision = await f.register(email);
    assert.equal(collision.existing_account, true);
    assert.equal(collision.id, undefined);
    const reserved = await f.register("reserved-address@synthetic.invalid");
    reject(
      await f.client()("/auth/register", "POST", {
        name: "Synthetic racing self-signup",
        email: "reserved-address@synthetic.invalid",
        password,
      }),
    );
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT id FROM users WHERE patient_id=?", [reserved.id]),
        )
      ).length,
      0,
    );
    const normalized = "concurrent-reservation@synthetic.invalid";
    const outcomes = await Promise.all([
      f.reception("/patients", "POST", {
        name: "Synthetic reservation one",
        email: normalized,
        identity_confirmed: true,
      }),
      f.partner("/patients", "POST", {
        name: "Synthetic reservation two",
        email: normalized.toUpperCase(),
        identity_confirmed: true,
      }),
    ]);
    assert.equal(outcomes.filter((result) => result.status === 200 && result.data.id).length, 1);
    const noEmailBody = {
      name: "Synthetic idempotent no-email intake",
      client_request_id: "same-raw-registration-key",
    };
    const repeated = await Promise.all([
      f.reception("/patients", "POST", noEmailBody),
      f.reception("/patients", "POST", noEmailBody),
    ]);
    assert.ok(repeated.every((response) => response.status === 200));
    assert.equal(repeated[0].data.id, repeated[1].data.id);
    assert.ok(repeated.some((response) => response.data.replayed === true));
    const laterRetry = await f.reception("/patients", "POST", noEmailBody);
    assert.equal(laterRetry.status, 200);
    assert.equal(laterRetry.data.id, repeated[0].data.id);
    assert.equal(laterRetry.data.replayed, true);
    assert.equal(
      (
        await f.reception("/patients", "POST", {
          ...noEmailBody,
          name: "Synthetic changed intake details",
        })
      ).status,
      409,
    );
    const anotherActor = await f.partner("/patients", "POST", noEmailBody);
    assert.equal(anotherActor.status, 200);
    assert.notEqual(
      anotherActor.data.id,
      repeated[0].data.id,
      "request identifiers are actor scoped rather than merging different facilities' records",
    );
    const keyedOrigins = await f.db.transaction((tx) =>
      tx.all("SELECT * FROM patient_origins WHERE patient_id IN (?,?)", [
        repeated[0].data.id,
        anotherActor.data.id,
      ]),
    );
    assert.equal(keyedOrigins.length, 2);
    assert.ok(
      keyedOrigins.every(
        (row) =>
          /^[a-f0-9]{64}$/.test(row.request_key) && /^[a-f0-9]{64}$/.test(row.request_payload_hash),
      ),
    );
    assert.ok(!JSON.stringify(keyedOrigins).includes(noEmailBody.client_request_id));
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT id FROM patients WHERE name=?", [noEmailBody.name]),
        )
      ).length,
      2,
      "retries create no duplicate no-email records",
    );
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT * FROM patient_addresses WHERE email=?", [normalized]),
        )
      ).length,
      1,
    );
  } finally {
    await f.db.close();
  }
});

test("existing-email facility requests stay private, require patient approval and do not release earlier facility notes", async () => {
  const f = await fixture();
  try {
    const sourceId = await f.signed();
    const known = await f.accessRequest();
    const unknown = await f.accessRequest(f.partner, "absent@synthetic.invalid");
    assert.equal(known.status, 200);
    assert.deepEqual(known.data, unknown.data);
    assert.equal(known.data.patient_id, undefined);
    const staffList = await f.partner("/facility-access-requests");
    assert.equal(staffList.status, 200);
    assert.equal(staffList.data.requests.length, 1);
    for (const field of ["patient_id", "patient_name", "email", "dob", "phone"]) {
      assert.equal(
        Object.hasOwn(staffList.data.requests[0], field),
        false,
        "pre-approval facility metadata omits " + field,
      );
    }
    const activity = (await f.partner("/audit")).data.audits.filter(
      (row) => row.action === "patient.facility_access_requested",
    );
    assert.equal(activity.length, 1);
    assert.equal(
      activity[0].patient_id,
      null,
      "the audit endpoint must not reveal the existing patient's opaque ID before approval",
    );
    assert.equal((await f.partner("/patients/patient-ade")).status, 403);
    const requests = (await f.patient("/facility-access-requests")).data.requests;
    const id = requests[0].id;
    assert.equal(requests.length, 1);
    const other = f.client();
    assert.equal(
      (
        await other("/auth/register", "POST", {
          name: "Synthetic unrelated account",
          email: "unrelated-approval@synthetic.invalid",
          password,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await other(`/facility-access-requests/${id}/accept`, "POST", {
          acknowledge_registration: true,
        })
      ).status,
      404,
    );
    assert.equal(
      (await f.patient(`/facility-access-requests/${id}/accept`, "POST", {})).status,
      400,
    );
    assert.equal(
      (
        await f.patient(`/facility-access-requests/${id}/accept`, "POST", {
          acknowledge_registration: true,
        })
      ).status,
      200,
    );
    const chart = await f.partner("/patients/patient-ade");
    assert.equal(chart.status, 200);
    assert.deepEqual(chart.data.encounters, []);
    for (const field of ["allergies", "allergy_status", "emergency_contact", "phone"]) {
      assert.equal(
        Object.hasOwn(chart.data.patient, field),
        false,
        "default registration approval does not expose prior clinical profile " + field,
      );
    }
    assert.ok(!JSON.stringify(chart.data).includes("Penicillin"));
    assert.equal(
      (
        await f.partner("/patients/patient-ade/profile", "PATCH", {
          allergy_status: "reviewed",
          allergies: "Synthetic forbidden profile edit",
          emergency_contact: "",
        })
      ).status,
      403,
    );
    assert.ok(!JSON.stringify(chart.data).includes("Synthetic old facility history marker"));
    assert.equal((await f.patient("/patients/patient-ade")).data.encounters[0].id, sourceId);
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT * FROM consents WHERE patient_id='patient-ade'"),
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT * FROM professional_grants WHERE patient_id='patient-ade'"),
        )
      ).length,
      0,
    );
    reject(
      await f.patient(`/facility-access-requests/${id}/accept`, "POST", {
        acknowledge_registration: true,
      }),
    );
    await f.db.transaction(async (tx) => {
      const member = await tx.get("SELECT id FROM memberships WHERE user_id='doctor-ibadan'");
      await tx.run(
        "INSERT INTO membership_roles(membership_id,role_id) VALUES (?,'role-org-ibadan-administrator')",
        [member.id],
      );
    });
    assert.equal(
      (
        await f.patient("/primary-care", "POST", {
          workspace_code: "HP-ORG-IBADAN",
          acknowledge_no_access_grant: true,
        })
      ).status,
      200,
    );
    const primaryRequest = (await f.patient("/primary-care")).data.requests.find(
      (row) => row.status === "pending",
    );
    assert.equal(
      (await f.partner(`/primary-care/requests/${primaryRequest.id}/accept`, "POST", {})).status,
      200,
    );
    const primaryChart = await f.partner("/patients/patient-ade");
    assert.equal(
      Object.hasOwn(primaryChart.data.patient, "allergies"),
      false,
      "primary designation cannot restore a denied clinical profile preference",
    );
    assert.equal(
      (
        await f.partner("/patients/patient-ade/profile", "PATCH", {
          allergy_status: "reviewed",
          allergies: "Synthetic still forbidden edit",
          emergency_contact: "",
        })
      ).status,
      403,
    );
    assert.equal((await f.accessRequest()).status, 200);
    const profileRequest = (await f.patient("/facility-access-requests")).data.requests.find(
      (row) => row.status === "pending",
    );
    assert.equal(
      (
        await f.patient(`/facility-access-requests/${profileRequest.id}/accept`, "POST", {
          acknowledge_registration: true,
          share_profile: true,
        })
      ).status,
      200,
    );
    const sharedProfile = await f.partner("/patients/patient-ade");
    assert.equal(
      sharedProfile.data.patient.allergies,
      "Penicillin — patient reports rash; verify before prescribing.",
    );
    assert.equal(Object.hasOwn(sharedProfile.data.patient, "emergency_contact"), true);
    assert.deepEqual(
      sharedProfile.data.encounters,
      [],
      "explicit profile sharing still does not release earlier facility notes",
    );
    assert.equal(
      (
        await f.partner("/patients/patient-ade/profile", "PATCH", {
          allergy_status: "reviewed",
          allergies: "Synthetic explicitly authorised profile review",
          emergency_contact: "",
        })
      ).status,
      200,
    );
    await f.db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO branches(id,organization_id,name) VALUES ('second-ibadan','org-ibadan','Synthetic second receiving branch')",
      );
      await tx.run(
        "INSERT INTO users(id,email,login_email,account_scope,name,password_hash,verified) SELECT 'branch-profile-user','branch-profile@synthetic.invalid','branch-profile@synthetic.invalid','org-ibadan','Synthetic second-branch GP',password_hash,1 FROM users WHERE id='doctor-ibadan'",
      );
      await tx.run(
        "INSERT INTO memberships(id,user_id,organization_id,role,branch_id,clinical_verified,clinical_scopes,clinical_review_reference) VALUES ('branch-profile-member','branch-profile-user','org-ibadan','clinician','second-ibadan',1,'[\"general\"]','Synthetic credential fixture')",
      );
      await tx.run(
        "INSERT INTO membership_roles(membership_id,role_id) VALUES ('branch-profile-member','role-org-ibadan-clinician')",
      );
    });
    const secondBranchDoctor = await f.login("branch-profile@synthetic.invalid");
    assert.equal((await f.accessRequest(secondBranchDoctor)).status, 200);
    const otherBranchRequest = (await f.patient("/facility-access-requests")).data.requests.find(
      (row) => row.status === "pending",
    );
    assert.equal(
      (
        await f.patient(`/facility-access-requests/${otherBranchRequest.id}/accept`, "POST", {
          acknowledge_registration: true,
        })
      ).status,
      200,
    );
    const branchPrivate = await secondBranchDoctor("/patients/patient-ade");
    assert.equal(branchPrivate.status, 200);
    assert.equal(
      Object.hasOwn(branchPrivate.data.patient, "allergies"),
      false,
      "another branch's profile approval does not expand branch-bound access",
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE memberships SET branch_id=NULL WHERE user_id='doctor-ibadan'"),
    );
    assert.equal(
      (await f.partner("/patients/patient-ade")).data.patient.allergies,
      "Synthetic explicitly authorised profile review",
      "workspace-wide authority can use a profile approval from a branch within its scope",
    );
    assert.equal(
      (await f.accessRequest(f.partner, "patient@healthpass.test", { branch_id: otherBranch }))
        .status,
      200,
    );
    const narrowedRequest = (await f.patient("/facility-access-requests")).data.requests.find(
      (row) => row.status === "pending",
    );
    assert.equal(
      (
        await f.patient(`/facility-access-requests/${narrowedRequest.id}/accept`, "POST", {
          acknowledge_registration: true,
          share_profile: false,
        })
      ).status,
      200,
    );
    assert.equal(
      Object.hasOwn((await f.partner("/patients/patient-ade")).data.patient, "allergies"),
      false,
      "all branch preferences denied means workspace-wide access cannot infer a profile grant",
    );
  } finally {
    await f.db.close();
  }
});

test("request approval respects named restrictions, branch permissions, withdrawal, expiry and single pending effects", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.patient("/professional-access", "POST", {
          recipient_user_id: "doctor-lagos",
          recipient_organization_id: "org-lagos",
          scopes: ["general"],
          include_profile: false,
          can_contribute: true,
          allow_delegation: false,
          allow_external_delegation: false,
          purpose: "Synthetic selected professional",
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          acknowledge_restriction: true,
          client_request_id: "onboarding-root",
        })
      ).status,
      200,
    );
    assert.equal((await f.accessRequest()).status, 200);
    assert.equal((await f.accessRequest()).status, 200);
    let pending = (await f.patient("/facility-access-requests")).data.requests;
    assert.equal(pending.length, 1);
    assert.equal(
      (await f.reception(`/facility-access-requests/${pending[0].id}/withdraw`, "POST", {})).status,
      404,
    );
    assert.equal(
      (await f.partner(`/facility-access-requests/${pending[0].id}/withdraw`, "POST", {})).status,
      200,
    );
    const withdrawal = (await f.partner("/audit")).data.audits.find(
      (row) => row.action === "patient.facility_access_withdrawn",
    );
    assert.equal(withdrawal.patient_id, null);
    assert.equal((await f.accessRequest()).status, 200);
    pending = (await f.patient("/facility-access-requests")).data.requests.filter(
      (row) => row.status === "pending",
    );
    assert.equal(pending.length, 1);
    await f.db.transaction((tx) =>
      tx.run(
        "UPDATE facility_access_requests SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
        [pending[0].id],
      ),
    );
    reject(
      await f.patient(`/facility-access-requests/${pending[0].id}/accept`, "POST", {
        acknowledge_registration: true,
      }),
    );
    assert.equal((await f.accessRequest()).status, 200);
    pending = (await f.patient("/facility-access-requests")).data.requests.filter(
      (row) => row.status === "pending",
    );
    assert.equal(pending.length, 1);
    const responses = await Promise.all([
      f.patient(`/facility-access-requests/${pending[0].id}/accept`, "POST", {
        acknowledge_registration: true,
        share_profile: true,
      }),
      f.patient(`/facility-access-requests/${pending[0].id}/accept`, "POST", {
        acknowledge_registration: true,
        share_profile: true,
      }),
    ]);
    assert.equal(responses.filter((result) => result.status === 200).length, 1);
    assert.equal(responses.filter((result) => result.status === 409).length, 1);
    assert.equal(
      (await f.partner("/patients/patient-ade")).status,
      403,
      "registration does not bypass selected-professional mode",
    );
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all(
            "SELECT * FROM patient_links WHERE patient_id='patient-ade' AND organization_id='org-ibadan'",
          ),
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await f.reception("/patients", "POST", {
          name: "Synthetic wrong branch",
          branch_id: otherBranch,
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.accessRequest(f.reception, "patient@healthpass.test", { branch_id: "second-lagos" }))
        .status,
      403,
    );
  } finally {
    await f.db.close();
  }
});

test("primary designation and facility acceptance never grant clinical access and can be replaced or cleared safely", async () => {
  const f = await fixture();
  try {
    await f.db.transaction(async (tx) => {
      const member = await tx.get("SELECT id FROM memberships WHERE user_id='doctor-ibadan'");
      await tx.run(
        "INSERT INTO membership_roles(membership_id,role_id) VALUES (?,'role-org-ibadan-administrator')",
        [member.id],
      );
    });
    const registered = await f.register("primary-choice@synthetic.invalid");
    const claimed = await f.claim(await f.invitation(registered.id));
    assert.equal(claimed.status, 200);
    const person = claimed.call;
    assert.equal((await person("/primary-care")).data.primary, null);
    assert.equal(
      (
        await person("/primary-care", "POST", {
          workspace_code: "HP-ORG-LAGOS",
          acknowledge_no_access_grant: true,
        })
      ).data.status,
      "accepted",
    );
    assert.equal((await person("/primary-care")).data.primary.organization_id, "org-lagos");
    assert.equal((await f.admin("/patients/" + registered.id)).status, 403);
    assert.equal(
      (await person("/primary-care", "POST", { workspace_code: "HP-ORG-IBADAN" })).status,
      400,
    );
    assert.equal(
      (
        await person("/primary-care", "POST", {
          workspace_code: "HP-ORG-IBADAN",
          acknowledge_no_access_grant: true,
        })
      ).data.status,
      "pending",
    );
    let requests = (await f.partner("/primary-care/requests")).data.requests;
    assert.equal(requests.length, 1);
    const id = requests[0].id;
    assert.equal((await f.reception("/primary-care/requests")).status, 403);
    assert.equal((await f.admin(`/primary-care/requests/${id}/accept`, "POST", {})).status, 404);
    assert.equal((await f.partner(`/primary-care/requests/${id}/accept`, "POST", {})).status, 200);
    assert.equal((await person("/primary-care")).data.primary.organization_id, "org-ibadan");
    assert.equal(
      (await f.partner("/patients/" + registered.id)).status,
      403,
      "primary status alone establishes no patient link or clinical grant",
    );
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT * FROM professional_grants WHERE patient_id=?", [registered.id]),
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT * FROM consents WHERE patient_id=?", [registered.id]),
        )
      ).length,
      0,
    );
    assert.equal((await person("/primary-care/clear", "POST", {})).status, 200);
    assert.equal((await person("/primary-care")).data.primary, null);
    assert.equal(
      (
        await person("/primary-care", "POST", {
          workspace_code: "HP-ORG-IBADAN",
          acknowledge_no_access_grant: true,
        })
      ).status,
      200,
    );
    requests = (await person("/primary-care")).data.requests.filter(
      (row) => row.status === "pending",
    );
    assert.equal(
      (await person(`/primary-care/requests/${requests[0].id}/withdraw`, "POST", {})).status,
      200,
    );
    assert.equal(
      (await f.partner(`/primary-care/requests/${requests[0].id}/accept`, "POST", {})).status,
      409,
    );
    assert.equal(
      (
        await person("/primary-care", "POST", {
          workspace_code: "HP-ORG-IBADAN",
          acknowledge_no_access_grant: true,
        })
      ).status,
      200,
    );
    requests = (await person("/primary-care")).data.requests.filter(
      (row) => row.status === "pending",
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE primary_care_requests SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", [
        requests[0].id,
      ]),
    );
    assert.equal(
      (await f.partner(`/primary-care/requests/${requests[0].id}/accept`, "POST", {})).status,
      409,
    );
  } finally {
    await f.db.close();
  }
});

test("email delivery uses encrypted durable metadata, controlled retries and a lease to prevent duplicate sends", async () => {
  const f = await fixture();
  try {
    const registered = await f.register("delivery-only@synthetic.invalid");
    const invite = await f.invitation(registered.id);
    const ready = {
      ...f.config,
      RESEND_API_KEY: "synthetic-provider-key",
      HEALTHPASS_EMAIL_FROM: "synthetic@test.invalid",
    };
    let sends = 0;
    await deliverPatientEmails(f.db, ready, async (_url, options) => {
      sends++;
      const body = JSON.parse(options.body);
      assert.deepEqual(body.to, ["delivery-only@synthetic.invalid"]);
      assert.ok(body.text.includes(invite.message.url));
      assert.ok(!body.text.includes("allergies"));
      return new Response("synthetic failure", { status: 503 });
    });
    let outbox = await f.db.transaction((tx) =>
      tx.get("SELECT * FROM patient_email_outbox WHERE id=?", [invite.claim_id]),
    );
    assert.equal(outbox.sent_at, null);
    assert.equal(outbox.last_error, "provider_503");
    assert.equal(outbox.attempts, 1);
    await deliverPatientEmails(f.db, ready, async () => {
      sends++;
      return new Response("unexpected retry", { status: 200 });
    });
    assert.equal(sends, 1, "retry waits for its persisted deadline");
    await f.db.transaction((tx) =>
      tx.run("UPDATE patient_email_outbox SET retry_after='2000-01-01T00:00:00.000Z' WHERE id=?", [
        invite.claim_id,
      ]),
    );
    let release;
    let entered;
    const started = new Promise((resolve) => (entered = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    const first = deliverPatientEmails(f.db, ready, async () => {
      sends++;
      entered();
      await gate;
      return new Response("synthetic accepted", { status: 200 });
    });
    await started;
    await deliverPatientEmails(f.db, ready, async () => {
      sends++;
      return new Response("duplicate should not happen", { status: 200 });
    });
    release();
    await first;
    outbox = await f.db.transaction((tx) =>
      tx.get("SELECT * FROM patient_email_outbox WHERE id=?", [invite.claim_id]),
    );
    assert.equal(sends, 2);
    assert.ok(outbox.sent_at);
    assert.equal(outbox.last_error, null);
  } finally {
    await f.db.close();
  }
});

test("signup races and primary relationship transitions recheck current authority without duplicate ownership or restored access", async () => {
  const f = await fixture();
  try {
    const email = "signup-race@synthetic.invalid";
    const newPatient = f.client();
    const results = await Promise.all([
      newPatient("/auth/register", "POST", {
        name: "Synthetic simultaneous self-signup",
        email,
        password,
      }),
      f.reception("/patients", "POST", {
        name: "Synthetic simultaneous facility intake",
        email,
        identity_confirmed: true,
      }),
    ]);
    assert.ok(
      results.every((result) => [200, 409].includes(result.status)),
      JSON.stringify(results),
    );
    const reserved = await f.db.transaction((tx) =>
      tx.all("SELECT * FROM patient_addresses WHERE email=?", [email]),
    );
    assert.equal(reserved.length, 1);
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT id FROM patients WHERE name LIKE 'Synthetic simultaneous%'"),
        )
      ).length,
      1,
      "failed reservations roll back their provisional patient row",
    );
    assert.ok(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT id FROM users WHERE patient_id=?", [reserved[0].patient_id]),
        )
      ).length <= 1,
    );
    await f.db.transaction(async (tx) => {
      const member = await tx.get("SELECT id FROM memberships WHERE user_id='doctor-ibadan'");
      await tx.run(
        "INSERT INTO membership_roles(membership_id,role_id) VALUES (?,'role-org-ibadan-administrator')",
        [member.id],
      );
    });
    for (const clearFirst of [false, true]) {
      assert.equal(
        (
          await f.patient("/primary-care", "POST", {
            workspace_code: "HP-ORG-IBADAN",
            acknowledge_no_access_grant: true,
          })
        ).status,
        200,
      );
      const pending = (await f.patient("/primary-care")).data.requests.find(
        (row) => row.status === "pending",
      );
      assert.ok(pending);
      const approve = () => f.partner(`/primary-care/requests/${pending.id}/accept`, "POST", {});
      const clear = () => f.patient("/primary-care/clear", "POST", {});
      const outcomes = await Promise.all(clearFirst ? [clear(), approve()] : [approve(), clear()]);
      assert.ok(outcomes.every((result) => [200, 409].includes(result.status)));
      assert.equal(
        (await f.patient("/primary-care")).data.primary,
        null,
        "a clear action is not undone by a stale concurrent acceptance",
      );
      assert.equal(
        (
          await f.db.transaction((tx) =>
            tx.all(
              "SELECT * FROM primary_care_requests WHERE patient_id='patient-ade' AND status='pending'",
            ),
          )
        ).length,
        0,
      );
    }
    assert.equal(
      (
        await f.patient("/primary-care", "POST", {
          workspace_code: "HP-ORG-IBADAN",
          acknowledge_no_access_grant: true,
        })
      ).status,
      200,
    );
    let pending = (await f.patient("/primary-care")).data.requests.find(
      (row) => row.status === "pending",
    );
    const role = await f.db.transaction((tx) =>
      tx.get("SELECT permissions FROM workspace_roles WHERE id='role-org-ibadan-administrator'"),
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE workspace_roles SET permissions=? WHERE id='role-org-ibadan-administrator'", [
        JSON.stringify(
          JSON.parse(role.permissions).filter((permission) => permission !== "primary.manage"),
        ),
      ]),
    );
    assert.equal(
      (await f.partner(`/primary-care/requests/${pending.id}/accept`, "POST", {})).status,
      403,
      "role revocation applies to an existing session",
    );
    await f.db.transaction((tx) =>
      tx.run("UPDATE workspace_roles SET permissions=? WHERE id='role-org-ibadan-administrator'", [
        role.permissions,
      ]),
    );
    assert.equal(
      (await f.partner(`/primary-care/requests/${pending.id}/decline`, "POST", {})).status,
      200,
    );
    assert.equal((await f.patient("/primary-care")).data.primary, null);
    assert.equal(
      (
        await f.db.transaction((tx) =>
          tx.all("SELECT * FROM professional_grants WHERE patient_id='patient-ade'"),
        )
      ).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
