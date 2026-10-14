import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "./api.mjs";
import { emptyState, memoryStore, openStore } from "./store.mjs";
import { command, receiveEvent } from "./domain.mjs";
import { passwordHash, signedHeaders, totp } from "./security.mjs";

const secret = "synthetic-service-key-".repeat(3);
export function fixture() {
  const config = {
    organizationId: "facility",
    production: false,
    publicUrl: "https://healthpass.test",
    serviceSecret: secret,
    serviceKeyId: "test-key",
    pharmacyTenantId: "pharmacy",
    pharmacyBranchId: "a",
    rxledgerUrl: "https://rxledger.test/api/healthpass",
    raiEnabled: true,
    raiApiKey: "rai-incoming-".repeat(3),
    raiServiceKey: "hp-analytics-".repeat(3),
    raiUrl: "https://rai.test/api/rai/healthpass",
  };
  const state = emptyState(config.organizationId),
    password = "synthetic-password-for-tests";
  state.users.push(
    {
      id: "doctor",
      organizationId: "facility",
      role: "provider",
      name: "Synthetic clinician",
      email: "doctor@example.test",
      active: true,
      verificationReference: "synthetic-review-only",
      passwordHash: passwordHash(password),
    },
    {
      id: "patient-user",
      role: "patient",
      organizationId: "facility",
      name: "Synthetic patient",
      email: "patient@example.test",
      active: true,
      patientId: "patient",
      passwordHash: passwordHash(password),
    },
    {
      id: "other-user",
      role: "patient",
      organizationId: "facility",
      email: "other@example.test",
      active: true,
      patientId: "other-patient",
      passwordHash: passwordHash(password),
    },
  );
  state.patients.push(
    {
      id: "patient",
      healthPassId: "HP-stable",
      name: "Synthetic patient",
      providerIds: ["doctor"],
    },
    {
      id: "other-patient",
      healthPassId: "HP-other",
      name: "Other synthetic patient",
      providerIds: [],
    },
  );
  return { config, state, password, store: memoryStore(state) };
}
async function client(api, email, password) {
  const res = await api.handle(
    new Request("https://healthpass.test/api/v1/auth/login", {
      method: "POST",
      headers: { origin: "https://healthpass.test", "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  assert.equal(res.status, 200, await res.clone().text());
  const credentials = await res.json();
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return {
    credentials,
    cookie,
    async call(path, body, overrides = {}) {
      const res = await api.handle(
        new Request("https://healthpass.test/api/v1" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: "https://healthpass.test",
            cookie,
            "x-csrf-token": credentials.csrfToken,
            "content-type": "application/json",
            ...overrides,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return { status: res.status, data: await res.json() };
    },
  };
}
const items = [
  {
    id: "item",
    name: "Example",
    form: "tablet",
    strength: "5 mg",
    dose: 1,
    doseUnit: "tablet",
    route: "oral",
    frequency: "once daily",
    duration: "10 days",
    quantity: 10,
    dispensingUnit: "tablet",
    instructions: "Synthetic fixture; not medical advice",
    substitutionPolicy: "not_permitted",
  },
];
async function orderThroughApi(api, f) {
  const doctor = await client(api, "doctor@example.test", f.password),
    patient = await client(api, "patient@example.test", f.password);
  const link = await doctor.call("/patients/patient/link", {
    patientLinkId: "reviewed-link",
    evidence: "Synthetic partner identity reviewed with stable source identifier",
  });
  assert.equal(link.status, 200);
  const consent = await patient.call("/consents", {
    patientId: "patient",
    purpose: "prescription_fulfilment",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  assert.equal(consent.status, 200);
  const encounter = await doctor.call("/encounters", {
    patientId: "patient",
    note: "Synthetic clinical note must never reach Rai",
  });
  assert.equal(encounter.status, 200);
  assert.equal(
    (await doctor.call(`/encounters/${encounter.data.id}/sign`, { version: 1 })).status,
    200,
  );
  const order = await doctor.call("/prescriptions", {
    patientId: "patient",
    encounterId: encounter.data.id,
    validUntil: new Date(Date.now() + 3600000).toISOString(),
    items,
  });
  assert.equal(order.status, 200, JSON.stringify(order.data));
  assert.equal(
    (await doctor.call(`/prescriptions/${order.data.prescriptionId}/sign`, { version: 1 })).status,
    200,
  );
  assert.equal(
    (await doctor.call(`/prescriptions/${order.data.prescriptionId}/dispatch`, { version: 1 }))
      .status,
    200,
  );
  return { doctor, patient, order: order.data, consent: consent.data };
}

test("identity scope, patient-only consent, CSRF, immutable signatures and login throttling", async () => {
  const f = fixture(),
    api = createApi(f);
  const doctor = await client(api, "doctor@example.test", f.password),
    other = await client(api, "other@example.test", f.password);
  assert.equal(
    (
      await doctor.call(
        "/patients",
        { name: "New synthetic patient" },
        { "x-csrf-token": "forged" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await doctor.call("/encounters", { patientId: "other-patient", note: "Denied" })).status,
    404,
  );
  assert.equal(
    (
      await other.call("/consents", {
        patientId: "patient",
        purpose: "prescription_fulfilment",
        expiresAt: new Date(Date.now() + 100000).toISOString(),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await doctor.call("/consents", {
        patientId: "patient",
        purpose: "prescription_fulfilment",
        expiresAt: new Date(Date.now() + 100000).toISOString(),
      })
    ).status,
    403,
  );
  const view = await other.call("/workspace");
  assert.equal(view.data.patients.length, 1);
  assert.equal(view.data.patients[0].id, "other-patient");
  const encounter = await doctor.call("/encounters", {
    patientId: "patient",
    note: "Immutable signed synthetic note",
  });
  assert.equal(
    (await doctor.call(`/encounters/${encounter.data.id}/sign`, { version: 2 })).status,
    409,
  );
  assert.equal(
    (await doctor.call(`/encounters/${encounter.data.id}/sign`, { version: 1 })).status,
    200,
  );
  assert.equal(
    (await doctor.call(`/encounters/${encounter.data.id}/sign`, { version: 1 })).status,
    409,
  );
  for (let i = 0; i < 6; i++) {
    const reply = await api.handle(
      new Request("https://healthpass.test/api/v1/auth/login", {
        method: "POST",
        headers: { origin: "https://healthpass.test" },
        body: JSON.stringify({ email: "unknown@example.test", password: "wrong" }),
      }),
    );
    assert.equal(reply.status, i === 5 ? 429 : 401);
  }
});

test("prescription requires reviewed identity, signed encounter and active consent; dispatch retries remain one event", async () => {
  const f = fixture(),
    api = createApi(f),
    doctor = await client(api, "doctor@example.test", f.password);
  assert.equal(
    (
      await doctor.call("/prescriptions", {
        patientId: "patient",
        encounterId: "missing",
        validUntil: new Date(Date.now() + 100000).toISOString(),
        items,
      })
    ).status,
    409,
  );
  const { order, consent, patient } = await orderThroughApi(api, f);
  assert.equal(
    (await doctor.call(`/prescriptions/${order.prescriptionId}/dispatch`, { version: 1 })).status,
    200,
  );
  assert.equal(await f.store.transact((s) => s.outbox.length), 1);
  assert.equal(
    (await doctor.call(`/prescriptions/${order.prescriptionId}/sign`, { version: 1 })).status,
    409,
  );
  await patient.call(`/consents/${consent.id}/revoke`, {});
  const raw = JSON.stringify({
    prescriptionId: order.prescriptionId,
    version: 1,
    patientLinkId: "reviewed-link",
  });
  let reply = await api.handle(
    new Request("https://healthpass.test/api/v1/integrations/rxledger/authorization", {
      method: "POST",
      headers: signedHeaders(raw, f.config),
      body: raw,
    }),
  );
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).authorized, false);
  reply = await api.handle(
    new Request("https://healthpass.test/api/v1/integrations/rxledger/authorization", {
      method: "POST",
      headers: signedHeaders(raw + " ", f.config),
      body: raw,
    }),
  );
  assert.equal(reply.status, 401);
});

test("durable inbox deduplicates event and transaction IDs, rejects over-supply, units and old versions", async () => {
  const f = fixture(),
    api = createApi(f),
    { order } = await orderThroughApi(api, f);
  const base = {
    eventId: "dispense-event",
    eventType: "dispense.recorded",
    producer: "rxledger",
    sourceOrganizationId: "pharmacy",
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    aggregateId: order.prescriptionId,
    aggregateVersion: 1,
    payload: {
      prescriptionId: order.prescriptionId,
      prescriptionVersion: 1,
      patientLinkId: "reviewed-link",
      sourceTenantId: "pharmacy",
      sourceBranchId: "a",
      sourceTransactionId: "actual-sale",
      pharmacistReference: "pharmacist",
      dispensedAt: new Date().toISOString(),
      items: [{ prescriptionItemId: "item", medicineId: "med", quantity: 4, unit: "tablet" }],
    },
  };
  const apply = (event) => f.store.transact((s) => receiveEvent(s, event, f.config));
  assert.equal((await apply(base)).duplicate, false);
  assert.equal((await apply(base)).duplicate, true);
  assert.equal((await apply({ ...base, eventId: "different-envelope" })).duplicate, true);
  await assert.rejects(
    apply({ ...base, payload: { ...base.payload, sourceTransactionId: "changed" } }),
    /event_id_conflict/,
  );
  await assert.rejects(
    apply({
      ...base,
      eventId: "wrong-unit",
      payload: {
        ...base.payload,
        sourceTransactionId: "wrong-unit-sale",
        items: [{ ...base.payload.items[0], unit: "pack" }],
      },
    }),
    /invalid_dispense/,
  );
  await assert.rejects(apply({ ...base, eventId: "old", aggregateVersion: 2 }), /event_version/);
  await assert.rejects(
    apply({
      ...base,
      eventId: "over",
      payload: {
        ...base.payload,
        sourceTransactionId: "over-sale",
        items: [{ ...base.payload.items[0], quantity: 7 }],
      },
    }),
    /over_supply/,
  );
  assert.equal(await f.store.transact((s) => s.prescriptions[0].dispensed.item), 4);
  const before = await f.store.transact((s) => s.inbox.length);
  assert.equal(before, 2);
});

test("SQLite persists signed records and inbox across restart; failed transactions roll back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "healthpass-test-")),
    config = {
      organizationId: "facility",
      sqlitePath: join(directory, "test.sqlite"),
      production: false,
    };
  try {
    let store = await openStore(config);
    await store.transact((s) => {
      s.prescriptions.push({ prescriptionId: "durable-order", signature: { digest: "immutable" } });
      s.inbox.push({ eventId: "durable-event" });
    });
    await assert.rejects(
      store.transact((s) => {
        s.prescriptions.length = 0;
        throw Error("rollback");
      }),
    );
    store.close();
    store = await openStore(config);
    assert.equal(await store.transact((s) => s.prescriptions[0].signature.digest), "immutable");
    assert.equal(await store.transact((s) => s.inbox[0].eventId), "durable-event");
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production providers require MFA; accepted OTP cannot be replayed", async () => {
  const f = fixture(),
    instant = Date.now();
  f.config.production = true;
  f.state.users[0].mfaSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  f.store = memoryStore(f.state);
  const api = createApi({ ...f, now: () => instant });
  const login = (otp) =>
    api.handle(
      new Request("https://healthpass.test/api/v1/auth/login", {
        method: "POST",
        headers: { origin: "https://healthpass.test" },
        body: JSON.stringify({ email: "doctor@example.test", password: f.password, otp }),
      }),
    );
  assert.equal((await login(undefined)).status, 401);
  const otp = totp(f.state.users[0].mfaSecret, instant);
  assert.equal((await login(otp)).status, 200);
  assert.equal((await login(otp)).status, 401);
});

const ecosystemPresent =
  existsSync(new URL("../../RxLedger/scripts/healthpass-test-loader.mjs", import.meta.url)) &&
  existsSync(new URL("../../Rai/server/healthpass-analytics.mjs", import.meta.url));
if (process.env.HEALTHPASS_REQUIRE_ECOSYSTEM === "true" && !ecosystemPresent)
  throw Error("Clone RxLedger and Rai as sibling repositories for whole-ecosystem verification");
test(
  "HealthPass → actual RxLedger sale/stock → HealthPass partial and complete fulfilment → Rai aggregates",
  {
    skip:
      !ecosystemPresent && "Sibling RxLedger and Rai clones required for ecosystem verification",
  },
  async () => {
    const { workflow, actualActions } =
      await import("../../RxLedger/scripts/healthpass-test-loader.mjs");
    const { verifyServiceBody } = await import("../../RxLedger/server/healthpass/auth.ts");
    const { createHealthPassAnalytics } = await import("../../Rai/server/healthpass-analytics.mjs");
    const f = fixture(),
      pharmacist = {
        id: "pharmacist",
        role: "pharmacist",
        status: "active",
        branchIds: ["a"],
        managedBranchIds: [],
      },
      cashier = { ...pharmacist, id: "cashier", role: "cashier" };
    const db = {
      settings: { primaryAdminId: "admin" },
      users: [pharmacist, cashier],
      branches: [{ id: "a", active: true }],
      medicines: [
        {
          id: "med",
          active: true,
          brandName: "Example",
          strength: "5 mg",
          form: "tablet",
          sellableUnit: "tablet",
          sellingPrice: 2,
        },
      ],
      batches: [
        {
          id: "batch",
          medicineId: "med",
          branchId: "a",
          expiryDate: "2099-01-01",
          sellingPrice: 2,
        },
      ],
      ledger: [
        {
          id: "stock",
          batchId: "batch",
          medicineId: "med",
          type: "stock-in",
          quantity: 20,
          createdAt: new Date().toISOString(),
        },
      ],
      auditLogs: [],
      sales: [],
      products: [],
      stockSnapshot: [],
      ledgerSummary: { todayMovementCountsByBatchId: {}, todayMovementCountsByBranchId: {} },
      receipts: [],
      continuityRequests: [],
      requisitions: [],
      branchAccessRequests: [],
      chatMessages: [],
      passwordResetRequests: [],
      securityEvents: [],
      posDrafts: [],
    };
    const scope = { sourceOrganizationId: "facility", tenantId: "pharmacy", branchId: "a" };
    let api,
      analyze,
      modelInput,
      failDeliveryOnce = true;
    const fetchImpl = async (url, options) => {
      if (url.includes("rxledger.test")) {
        verifyServiceBody(options.body, options.headers, { secret, keyId: "test-key" });
        const body = JSON.parse(options.body);
        let result;
        if (body.action === "receivePrescription") {
          result = workflow.receivePrescription(db, body.event, scope);
          if (failDeliveryOnce) {
            failDeliveryOnce = false;
            throw Error("Lost receipt after committed pharmacy intake");
          }
        } else if (body.action === "receivePrescriptionControl")
          result = workflow.receivePrescriptionControl(db, body.event, scope);
        else if (body.action === "pullEvents")
          result = {
            events:
              db.healthpass?.outbox.filter((e) => !e.acknowledgedAt).map((e) => e.event) || [],
          };
        else if (body.action === "acknowledgeEvents") {
          for (const e of db.healthpass.outbox.filter((e) =>
            body.eventIds.includes(e.event.eventId),
          ))
            e.acknowledgedAt = new Date().toISOString();
          result = { acknowledged: body.eventIds.length };
        } else throw Error("Unknown real contract");
        return new Response(JSON.stringify(result));
      }
      if (url.includes("healthpass.test")) return api.handle(new Request(url, options));
      if (url.includes("rai.test"))
        return new Response(
          JSON.stringify(
            await analyze({ headers: options.headers, body: JSON.parse(options.body) }),
          ),
        );
      throw Error("Unexpected integration URL");
    };
    api = createApi({ ...f, fetchImpl });
    analyze = createHealthPassAnalytics({
      enabled: true,
      incomingKey: f.config.raiApiKey,
      serviceKey: f.config.raiServiceKey,
      baseUrl: "https://healthpass.test",
      fetchImpl,
      provider: {
        id: "synthetic-evaluation",
        chat: async (input) => {
          modelInput = input;
          return { text: "Synthetic aggregate explanation for review", model: "test-only" };
        },
      },
    });
    const { doctor, patient, order, consent } = await orderThroughApi(api, f);
    await doctor.call("/integrations/rxledger/deliver", {});
    assert.equal(db.healthpass.prescriptions.length, 1);
    assert.equal(
      db.ledger.reduce((n, e) => n + e.quantity, 0),
      20,
    );
    await f.store.transact((s) => {
      s.outbox[0].nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    });
    await doctor.call("/integrations/rxledger/deliver", {});
    assert.equal(db.healthpass.prescriptions.length, 1);
    workflow.reviewPrescription(db, pharmacist, {
      prescriptionId: order.prescriptionId,
      version: 1,
      status: "accepted",
      mappings: [{ prescriptionItemId: "item", medicineId: "med" }],
    });
    const sale = (quantity, operationId) =>
      actualActions.recordSale(db, cashier.id, cashier.role, {
        branchId: "a",
        items: [{ itemType: "medicine", itemId: "med", quantity }],
        healthpass: {
          prescriptionId: order.prescriptionId,
          version: 1,
          operationId,
          items: [{ prescriptionItemId: "item", medicineId: "med", quantity }],
        },
      });
    sale(4, "first-visit");
    sale(4, "first-visit");
    assert.equal(db.sales.length, 1);
    assert.equal(
      db.ledger.reduce((n, e) => n + e.quantity, 0),
      16,
    );
    await doctor.call("/integrations/rxledger/deliver", {});
    let view = await patient.call("/workspace");
    assert.equal(view.data.prescriptions[0].dispensed.item, 4);
    assert.equal(view.data.prescriptions[0].fulfilment, "partial");
    assert.throws(() => sale(7, "over-supply"), /remaining/);
    sale(6, "second-visit");
    await doctor.call("/integrations/rxledger/deliver", {});
    view = await patient.call("/workspace");
    assert.equal(view.data.prescriptions[0].dispensed.item, 10);
    assert.equal(view.data.prescriptions[0].fulfilment, "complete");
    assert.equal(
      db.ledger.reduce((n, e) => n + e.quantity, 0),
      10,
    );
    const today = new Date().toISOString().slice(0, 10);
    const analytics = await doctor.call("/rai/analytics", {
      message: "Explain pharmacy fulfilment counts",
      startDate: today,
      endDate: today,
    });
    assert.equal(analytics.status, 200, JSON.stringify(analytics.data));
    assert.equal(analytics.data.metrics.dispensed_prescription_count, 1);
    assert.equal(analytics.data.metrics.pending_item_count, 0);
    const modelText = JSON.stringify(modelInput);
    assert.ok(!modelText.includes("HP-stable"));
    assert.ok(!modelText.includes("Synthetic clinical note"));
    assert.ok(!modelText.includes(secret));
    await patient.call(`/consents/${consent.id}/revoke`, {});
    await doctor.call("/integrations/rxledger/deliver", {});
    assert.equal(db.healthpass.prescriptions[0].inactive, "consent_revoked");
    assert.equal(db.healthpass.prescriptions[0].supplied.item, 10);
    await doctor.call("/auth/logout", {});
    assert.equal((await doctor.call("/workspace")).status, 401);
  },
);
