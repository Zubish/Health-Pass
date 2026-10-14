import { hash, HttpError, requireCondition as check, text, timestamp } from "./security.mjs";
import { newId } from "./store.mjs";

export const iso = (instant) => new Date(instant).toISOString();
export function audit(state, actorId, action, resourceId, instant) {
  state.audit.push({ id: newId("audit"), actorId, action, resourceId, occurredAt: iso(instant) });
}
export function provider(user, config) {
  check(
    user.role === "provider" &&
      user.active &&
      user.verificationReference &&
      (!config.production || user.mfaSecret),
    403,
    "verified_prescriber_required",
  );
}
export function patientFor(state, user, id) {
  const patient = state.patients.find((p) => p.id === id);
  check(
    patient &&
      (user.role === "patient"
        ? user.patientId === id
        : user.role === "provider" && patient.providerIds.includes(user.id)),
    404,
    "patient_not_found",
  );
  return patient;
}
export function prescriptionFor(state, user, id) {
  const order = state.prescriptions.find((p) => p.prescriptionId === id);
  check(order, 404, "prescription_not_found");
  patientFor(state, user, order.patientId);
  return order;
}
export function consentFor(state, patientId, config, instant) {
  return state.consents.find(
    (c) =>
      c.patientId === patientId &&
      c.purpose === "prescription_fulfilment" &&
      !c.revokedAt &&
      Date.parse(c.expiresAt) > instant &&
      c.pharmacy.tenantId === config.pharmacyTenantId &&
      c.pharmacy.branchId === config.pharmacyBranchId,
  );
}
export function authorized(state, order, config, instant) {
  if (!order || order.orderStatus !== "active" || Date.parse(order.validUntil) <= instant)
    return false;
  const grant = state.consents.find((c) => c.id === order.consent?.grantId);
  return Boolean(
    grant &&
    !grant.revokedAt &&
    grant.version === order.consent.version &&
    Date.parse(grant.expiresAt) > instant &&
    grant.pharmacy.tenantId === config.pharmacyTenantId &&
    grant.pharmacy.branchId === config.pharmacyBranchId,
  );
}
function versionCheck(order, value) {
  check(
    value === order.version,
    409,
    "stale_version",
    "Refresh the signed version before continuing",
  );
}
function item(input) {
  const output = {};
  for (const field of [
    "id",
    "name",
    "form",
    "strength",
    "doseUnit",
    "route",
    "frequency",
    "duration",
    "dispensingUnit",
    "instructions",
    "substitutionPolicy",
  ])
    output[field] = text(input[field], field, field === "instructions" ? 2000 : 200);
  check(Number.isFinite(input.dose) && input.dose > 0, 400, "invalid_dose");
  output.dose = input.dose;
  check(
    Number.isFinite(input.quantity) && input.quantity > 0 && input.quantity <= 1000000,
    400,
    "invalid_quantity",
  );
  check(
    ["not_permitted", "prescriber_approval_required"].includes(output.substitutionPolicy),
    400,
    "invalid_substitution_policy",
  );
  return { ...output, quantity: input.quantity };
}
function queue(state, order, eventType, payload, action, instant) {
  const event = {
    eventId: newId("event"),
    eventType,
    schemaVersion: 1,
    occurredAt: iso(instant),
    producer: "healthpass",
    sourceOrganizationId: state.organizationId,
    correlationId: order.prescriptionId,
    aggregateId: order.prescriptionId,
    aggregateVersion: order.version,
    payload,
  };
  state.outbox.push({
    id: event.eventId,
    action,
    event,
    status: "queued",
    attempts: 0,
    nextAttemptAt: iso(instant),
  });
  return event;
}
function control(state, order, type, instant) {
  if (order.transport !== "not_dispatched") {
    queue(
      state,
      order,
      type,
      {
        prescriptionId: order.prescriptionId,
        version: order.version,
        patientLinkId: order.patientLinkId,
      },
      "receivePrescriptionControl",
      instant,
    );
    order.transport = "queued";
  }
}

export function command(state, user, operation, id, body, config, instant = Date.now()) {
  if (operation === "createPatient") {
    provider(user, config);
    const patient = {
      id: newId("patient"),
      healthPassId: newId("HP"),
      name: text(body.name, "name", 200),
      providerIds: [user.id],
    };
    state.patients.push(patient);
    audit(state, user.id, "patient.created", patient.id, instant);
    return patient;
  }
  if (operation === "linkPatient") {
    provider(user, config);
    const patient = patientFor(state, user, id);
    check(!patient.patientLinkId, 409, "link_already_reviewed");
    const link = text(body.patientLinkId, "patientLinkId", 200);
    check(!state.patients.some((p) => p.patientLinkId === link), 409, "partner_link_already_used");
    patient.patientLinkId = link;
    patient.linkEvidence = text(body.evidence, "evidence", 2000);
    patient.linkReviewedBy = user.id;
    patient.linkReviewedAt = iso(instant);
    audit(state, user.id, "patient.link_reviewed", id, instant);
    return patient;
  }
  if (operation === "createEncounter") {
    provider(user, config);
    patientFor(state, user, body.patientId);
    const encounter = {
      id: newId("encounter"),
      patientId: body.patientId,
      note: text(body.note, "note", 12000),
      version: 1,
      status: "draft",
      authorId: user.id,
      createdAt: iso(instant),
    };
    state.encounters.push(encounter);
    audit(state, user.id, "encounter.created", encounter.id, instant);
    return encounter;
  }
  if (operation === "signEncounter") {
    provider(user, config);
    const encounter = state.encounters.find((e) => e.id === id);
    check(encounter, 404, "encounter_not_found");
    patientFor(state, user, encounter.patientId);
    check(
      encounter.authorId === user.id &&
        encounter.status === "draft" &&
        body.version === encounter.version,
      409,
      "encounter_version_conflict",
    );
    encounter.status = "signed";
    encounter.signedAt = iso(instant);
    encounter.digest = hash(
      JSON.stringify({
        id: encounter.id,
        version: encounter.version,
        note: encounter.note,
        authorId: user.id,
      }),
    );
    audit(state, user.id, "encounter.signed", id, instant);
    return encounter;
  }
  if (operation === "createConsent") {
    const patient = patientFor(state, user, body.patientId);
    check(
      user.role === "patient" && body.purpose === "prescription_fulfilment",
      403,
      "patient_consent_required",
    );
    check(config.pharmacyTenantId && config.pharmacyBranchId, 503, "pharmacy_not_configured");
    const expiresAt = timestamp(body.expiresAt, "expiresAt");
    check(
      Date.parse(expiresAt) > instant && Date.parse(expiresAt) <= instant + 90 * 86400000,
      400,
      "invalid_consent_expiry",
    );
    const grant = {
      id: newId("consent"),
      version: 1,
      patientId: patient.id,
      purpose: body.purpose,
      expiresAt,
      pharmacy: { tenantId: config.pharmacyTenantId, branchId: config.pharmacyBranchId },
      grantedBy: user.id,
      grantedAt: iso(instant),
    };
    state.consents.push(grant);
    audit(state, user.id, "consent.granted", patient.id, instant);
    return grant;
  }
  if (operation === "revokeConsent") {
    const grant = state.consents.find((c) => c.id === id);
    check(grant, 404, "consent_not_found");
    patientFor(state, user, grant.patientId);
    check(user.role === "patient", 403, "patient_consent_required");
    if (!grant.revokedAt) {
      grant.revokedAt = iso(instant);
      grant.version++;
      for (const order of state.prescriptions.filter((p) => p.consent?.grantId === id))
        control(state, order, "consent.revoked", instant);
      audit(state, user.id, "consent.revoked", grant.patientId, instant);
    }
    return grant;
  }
  if (operation === "createPrescription") {
    provider(user, config);
    patientFor(state, user, body.patientId);
    const encounter = state.encounters.find(
      (e) => e.id === body.encounterId && e.patientId === body.patientId,
    );
    check(
      encounter && encounter.authorId === user.id && encounter.status === "signed",
      409,
      "signed_encounter_required",
    );
    check(
      Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 30,
      400,
      "invalid_items",
    );
    const items = body.items.map(item);
    check(new Set(items.map((i) => i.id)).size === items.length, 400, "duplicate_item_id");
    const validUntil = timestamp(body.validUntil, "validUntil");
    check(Date.parse(validUntil) > instant, 400, "expired_prescription");
    const order = {
      prescriptionId: newId("prescription"),
      version: 1,
      patientId: body.patientId,
      encounterId: encounter.id,
      prescriber: {
        id: user.id,
        facilityId: state.organizationId,
        verificationReference: user.verificationReference,
      },
      validUntil,
      items,
      orderStatus: "draft",
      transport: "not_dispatched",
      review: "pending",
      fulfilment: "none",
      events: [],
      dispensed: {},
      createdAt: iso(instant),
      clinicalChecks: "unavailable",
    };
    state.prescriptions.push(order);
    audit(state, user.id, "prescription.created", order.prescriptionId, instant);
    return order;
  }
  const order = prescriptionFor(state, user, id);
  provider(user, config);
  versionCheck(order, body.version);
  check(order.prescriber.id === user.id, 403, "original_prescriber_required");
  if (operation === "signPrescription") {
    check(
      order.orderStatus === "draft" && Date.parse(order.validUntil) > instant,
      409,
      "prescription_not_signable",
    );
    order.orderStatus = "active";
    order.signedAt = iso(instant);
    order.signature = {
      algorithm: "sha256",
      keyId: "authenticated-prescriber-record",
      digest: hash(
        JSON.stringify({
          prescriptionId: order.prescriptionId,
          version: order.version,
          encounterId: order.encounterId,
          items: order.items,
          prescriber: order.prescriber,
          validUntil: order.validUntil,
          signedAt: order.signedAt,
        }),
      ),
    };
    audit(state, user.id, "prescription.signed", id, instant);
    return order;
  }
  if (operation === "dispatchPrescription") {
    check(
      order.orderStatus === "active" && Date.parse(order.validUntil) > instant,
      409,
      "signed_valid_prescription_required",
    );
    if (order.transport !== "not_dispatched") return order;
    check(
      config.serviceSecret?.length >= 32 && config.pharmacyTenantId && config.pharmacyBranchId,
      503,
      "pharmacy_not_configured",
    );
    const patient = patientFor(state, user, order.patientId),
      grant = consentFor(state, patient.id, config, instant);
    check(patient.patientLinkId && patient.linkReviewedBy, 409, "reviewed_patient_link_required");
    check(grant, 403, "active_patient_consent_required");
    order.patientLinkId = patient.patientLinkId;
    order.patient = { healthPassId: patient.healthPassId, name: patient.name };
    order.pharmacy = { tenantId: config.pharmacyTenantId, branchId: config.pharmacyBranchId };
    order.consent = {
      grantId: grant.id,
      version: grant.version,
      expiresAt: grant.expiresAt,
      purpose: grant.purpose,
    };
    const payload = {};
    for (const key of [
      "prescriptionId",
      "version",
      "patientLinkId",
      "patient",
      "encounterId",
      "prescriber",
      "signedAt",
      "validUntil",
      "pharmacy",
      "consent",
      "items",
      "signature",
    ])
      payload[key] = structuredClone(order[key]);
    queue(state, order, "prescription.dispatched", payload, "receivePrescription", instant);
    order.transport = "queued";
    audit(state, user.id, "prescription.dispatched", id, instant);
    return order;
  }
  if (operation === "cancelPrescription") {
    if (order.orderStatus !== "cancelled") {
      order.orderStatus = "cancelled";
      order.cancelledAt = iso(instant);
      control(state, order, "prescription.cancelled", instant);
      audit(state, user.id, "prescription.cancelled", id, instant);
    }
    return order;
  }
  throw new HttpError(404, "operation_not_found");
}

export function workspace(state, user, instant) {
  const patients = state.patients.filter((p) =>
    user.role === "patient"
      ? p.id === user.patientId
      : user.role === "provider" && p.providerIds.includes(user.id),
  );
  const ids = new Set(patients.map((p) => p.id));
  audit(state, user.id, "workspace.read", user.patientId || user.id, instant);
  const resourceIds = new Set([
    user.id,
    ...ids,
    ...state.prescriptions.filter((p) => ids.has(p.patientId)).map((p) => p.prescriptionId),
    ...state.encounters.filter((e) => ids.has(e.patientId)).map((e) => e.id),
  ]);
  return {
    patients: patients.map(({ providerIds, linkEvidence, ...p }) => ({ ...p, providerIds })),
    encounters: state.encounters.filter(
      (e) => ids.has(e.patientId) && (user.role !== "patient" || e.status === "signed"),
    ),
    prescriptions: state.prescriptions.filter(
      (p) => ids.has(p.patientId) && (user.role !== "patient" || p.orderStatus !== "draft"),
    ),
    consents: state.consents.filter((c) => ids.has(c.patientId)),
    audit: state.audit.filter((a) => resourceIds.has(a.resourceId)).slice(-100),
  };
}

export function receiveEvent(state, event, config, instant = Date.now()) {
  check(
    event &&
      typeof event.eventId === "string" &&
      event.eventId.length <= 200 &&
      event.producer === "rxledger" &&
      event.schemaVersion === 1,
    400,
    "invalid_event",
  );
  timestamp(event.occurredAt, "occurredAt");
  const digest = hash(JSON.stringify(event)),
    known = state.inbox.find((e) => e.eventId === event.eventId);
  if (known) {
    check(known.digest === digest, 409, "event_id_conflict");
    return { duplicate: true, eventId: event.eventId };
  }
  const payload = event.payload;
  check(
    payload && payload.prescriptionId === event.aggregateId,
    400,
    "event_prescription_mismatch",
  );
  const order = state.prescriptions.find((p) => p.prescriptionId === payload.prescriptionId);
  check(
    order &&
      order.patientLinkId === payload.patientLinkId &&
      payload.prescriptionVersion === order.version &&
      event.aggregateVersion === order.version,
    409,
    "event_version_or_link_mismatch",
  );
  check(
    payload.sourceTenantId === config.pharmacyTenantId &&
      payload.sourceBranchId === config.pharmacyBranchId,
    403,
    "event_pharmacy_scope_mismatch",
  );
  check(order.transport !== "not_dispatched", 409, "prescription_not_dispatched");
  if (event.eventType === "prescription.acknowledged") order.transport = "acknowledged";
  else if (event.eventType === "prescription.reviewed") {
    check(
      ["accepted", "clarification_required", "rejected"].includes(payload.status),
      400,
      "invalid_review",
    );
    order.review = payload.status;
  } else if (event.eventType === "dispense.recorded") {
    text(payload.sourceTransactionId, "sourceTransactionId", 200);
    text(payload.pharmacistReference, "pharmacistReference", 200);
    const occurred = timestamp(payload.dispensedAt, "dispensedAt");
    check(
      Date.parse(occurred) <= instant + 300000 &&
        Date.parse(occurred) >= Date.parse(order.signedAt) &&
        Date.parse(occurred) <= Date.parse(order.validUntil),
      409,
      "invalid_dispense_time",
    );
    const previous = order.events.find(
      (e) =>
        e.eventType === "dispense.recorded" &&
        e.payload.sourceTransactionId === payload.sourceTransactionId,
    );
    if (previous) {
      check(
        hash(JSON.stringify(previous.payload)) === hash(JSON.stringify(payload)),
        409,
        "transaction_id_conflict",
      );
      state.inbox.push({ eventId: event.eventId, digest, occurredAt: iso(instant) });
      return { duplicate: true, eventId: event.eventId };
    }
    check(
      Array.isArray(payload.items) &&
        payload.items.length > 0 &&
        payload.items.length <= order.items.length &&
        new Set(payload.items.map((i) => i.prescriptionItemId)).size === payload.items.length,
      400,
      "invalid_dispense_items",
    );
    for (const line of payload.items) {
      const expected = order.items.find((i) => i.id === line.prescriptionItemId);
      check(
        expected &&
          line.unit === expected.dispensingUnit &&
          typeof line.medicineId === "string" &&
          Number.isFinite(line.quantity) &&
          line.quantity > 0,
        400,
        "invalid_dispense_mapping_or_unit",
      );
      check(
        (order.dispensed[expected.id] || 0) + line.quantity <= expected.quantity + 1e-9,
        409,
        "over_supply",
      );
      const earlier = order.events
        .flatMap((e) => (e.eventType === "dispense.recorded" ? e.payload.items : []))
        .find((i) => i.prescriptionItemId === line.prescriptionItemId);
      check(!earlier || earlier.medicineId === line.medicineId, 409, "medicine_mapping_changed");
    }
    for (const line of payload.items)
      order.dispensed[line.prescriptionItemId] =
        (order.dispensed[line.prescriptionItemId] || 0) + line.quantity;
    order.fulfilment = order.items.every((i) => (order.dispensed[i.id] || 0) >= i.quantity - 1e-9)
      ? "complete"
      : "partial";
    // Actual supply remains factual even if revocation/cancellation arrived before feedback.
    if (!authorized(state, order, config, instant)) order.reconciliationRequired = true;
  } else throw new HttpError(400, "unsupported_event_type");
  order.events.push(structuredClone(event));
  state.inbox.push({ eventId: event.eventId, digest, occurredAt: iso(instant) });
  audit(state, "rxledger", event.eventType, order.prescriptionId, instant);
  return { eventId: event.eventId, duplicate: false };
}

export function operationalMetrics(state, user, startDate, endDate) {
  const patientIds = new Set(
    state.patients.filter((p) => p.providerIds.includes(user.id)).map((p) => p.id),
  );
  const orders = state.prescriptions.filter(
    (p) =>
      patientIds.has(p.patientId) &&
      p.orderStatus !== "draft" &&
      p.signedAt.slice(0, 10) >= startDate &&
      p.signedAt.slice(0, 10) <= endDate,
  );
  return {
    prescription_count: orders.length,
    dispatched_prescription_count: orders.filter((p) => p.transport !== "not_dispatched").length,
    acknowledged_prescription_count: orders.filter((p) => p.transport === "acknowledged").length,
    partially_dispensed_prescription_count: orders.filter((p) => p.fulfilment === "partial").length,
    dispensed_prescription_count: orders.filter((p) => p.fulfilment === "complete").length,
    cancelled_prescription_count: orders.filter((p) => p.orderStatus === "cancelled").length,
    pending_item_count: orders
      .filter((p) => p.orderStatus === "active")
      .reduce(
        (sum, p) => sum + p.items.filter((i) => (p.dispensed[i.id] || 0) < i.quantity).length,
        0,
      ),
  };
}
