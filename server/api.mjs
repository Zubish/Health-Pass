import { randomBytes } from "node:crypto";
import { newId, openStore } from "./store.mjs";
import {
  audit,
  authorized,
  command,
  iso,
  operationalMetrics,
  provider,
  receiveEvent,
  workspace,
} from "./domain.mjs";
import {
  date,
  equal,
  hash,
  HttpError,
  requireCondition as check,
  signedHeaders,
  token,
  verifyPassword,
  verifyService,
  verifyTotp,
} from "./security.mjs";

export function runtimeConfig(env = process.env) {
  return {
    production: env.NODE_ENV === "production",
    organizationId: env.HEALTHPASS_ORGANIZATION_ID || "development-facility",
    publicUrl: env.HEALTHPASS_PUBLIC_URL,
    databaseUrl: env.DATABASE_URL,
    sqlitePath: env.HEALTHPASS_SQLITE_PATH,
    serviceSecret: env.HEALTHPASS_SERVICE_SECRET,
    serviceKeyId: env.HEALTHPASS_SERVICE_KEY_ID || "healthpass-rxledger-v1",
    pharmacyTenantId: env.HEALTHPASS_PHARMACY_TENANT_ID,
    pharmacyBranchId: env.HEALTHPASS_PHARMACY_BRANCH_ID,
    rxledgerUrl: env.RXLEDGER_HEALTHPASS_URL,
    raiEnabled: env.HEALTHPASS_RAI_ENABLED === "true",
    raiUrl: env.RAI_HEALTHPASS_URL,
    raiApiKey: env.RAI_HEALTHPASS_API_KEY,
    raiServiceKey: env.HEALTHPASS_RAI_API_KEY,
  };
}
function endpoint(value, config) {
  check(value, 503, "integration_url_not_configured");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(503, "invalid_integration_url");
  }
  check(
    url.protocol === "https:" ||
      (!config.production &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
    503,
    "secure_integration_url_required",
  );
  check(!url.username && !url.password, 503, "url_credentials_forbidden");
  return url.href;
}
async function bodyText(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  let bytes = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 262144) {
      await reader.cancel();
      throw new HttpError(413, "body_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}
function jsonBody(raw) {
  try {
    const value = JSON.parse(raw || "{}");
    check(value && typeof value === "object" && !Array.isArray(value), 400, "invalid_json");
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json");
  }
}
function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    organizationId: user.organizationId,
    patientId: user.patientId,
  };
}
function session(state, request, instant) {
  const raw = request.headers.get("cookie") || "";
  const value = raw
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("healthpass_session="))
    ?.slice(19);
  const entry =
    value &&
    state.sessions.find(
      (s) =>
        equal(s.tokenHash, hash(value)) &&
        Date.parse(s.expiresAt) > instant &&
        Date.parse(s.lastSeenAt) > instant - 30 * 60000,
    );
  const user =
    entry &&
    state.users.find(
      (u) => u.id === entry.userId && u.active && u.organizationId === state.organizationId,
    );
  check(user, 401, "sign_in_required");
  entry.lastSeenAt = iso(instant);
  return { user, entry };
}
function origin(request, config) {
  const expected = config.publicUrl
    ? new URL(config.publicUrl).origin
    : new URL(request.url).origin;
  check(!config.production || config.publicUrl, 503, "public_url_not_configured");
  check(request.headers.get("origin") === expected, 403, "origin_denied");
}
function cookie(value, config, maxAge = 28800) {
  return `healthpass_session=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${config.production ? "; Secure" : ""}`;
}
function range(body) {
  const startDate = date(body.start_date || body.startDate),
    endDate = date(body.end_date || body.endDate);
  check(
    startDate <= endDate && Date.parse(endDate) - Date.parse(startDate) <= 366 * 86400000,
    400,
    "invalid_date_range",
  );
  return { startDate, endDate };
}

export function createApi({ store, config, fetchImpl = fetch, now = Date.now }) {
  const response = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...headers,
      },
    });
  async function partner(action, extra) {
    const raw = JSON.stringify({ action, ...extra });
    check(config.serviceSecret?.length >= 32, 503, "partner_not_configured");
    const reply = await fetchImpl(endpoint(config.rxledgerUrl, config), {
      method: "POST",
      headers: signedHeaders(raw, config, now()),
      body: raw,
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    check(reply.ok, 502, "rxledger_delivery_failed");
    const payload = await reply.json();
    return payload;
  }
  async function deliver(user) {
    const results = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const pending = await store.transact((state) => {
        provider(state.users.find((u) => u.id === user.id) || {}, config);
        const instant = now();
        const entry = state.outbox.find((e) => {
          const order = state.prescriptions.find((p) => p.prescriptionId === e.event.aggregateId);
          const owned =
            order &&
            state.patients.find((p) => p.id === order.patientId)?.providerIds.includes(user.id);
          return (
            owned &&
            (e.status === "queued" ||
              e.status === "retry_required" ||
              (e.status === "sending" && Date.parse(e.leaseUntil) <= instant)) &&
            Date.parse(e.nextAttemptAt) <= instant &&
            e.attempts < 8
          );
        });
        if (!entry) return null;
        const order = state.prescriptions.find((p) => p.prescriptionId === entry.event.aggregateId);
        check(
          order &&
            state.patients.find((p) => p.id === order.patientId)?.providerIds.includes(user.id),
          403,
          "delivery_scope_denied",
        );
        if (entry.action === "receivePrescription" && !authorized(state, order, config, instant)) {
          entry.status = "cancelled";
          return { skipped: true };
        }
        entry.status = "sending";
        entry.leaseId = newId("lease");
        entry.leaseUntil = iso(instant + 30000);
        entry.attempts++;
        return entry;
      });
      if (!pending) break;
      if (pending.skipped) continue;
      try {
        const ack = await partner(pending.action, { event: pending.event });
        check(
          ack.prescriptionId === pending.event.aggregateId &&
            ack.version === pending.event.aggregateVersion &&
            ack.status === "acknowledged",
          502,
          "invalid_pharmacy_acknowledgement",
        );
        await store.transact((state) => {
          const entry = state.outbox.find((e) => e.id === pending.id);
          if (entry.leaseId !== pending.leaseId) return;
          entry.status = "delivered";
          entry.deliveredAt = iso(now());
          const order = state.prescriptions.find(
            (p) => p.prescriptionId === pending.event.aggregateId,
          );
          if (pending.action === "receivePrescription") order.transport = "acknowledged";
          else if (
            !state.outbox.some(
              (e) =>
                e.event.aggregateId === order.prescriptionId &&
                ["queued", "sending", "retry_required"].includes(e.status),
            )
          )
            order.transport = "acknowledged";
          audit(state, user.id, "integration.delivered", order.prescriptionId, now());
        });
        results.push({ eventId: pending.id, status: "delivered" });
      } catch {
        await store.transact((state) => {
          const entry = state.outbox.find((e) => e.id === pending.id);
          if (entry.leaseId !== pending.leaseId) return;
          entry.status = entry.attempts >= 8 ? "dead_letter" : "retry_required";
          entry.nextAttemptAt = iso(now() + Math.min(3600000, 1000 * 2 ** entry.attempts));
          state.prescriptions.find(
            (p) => p.prescriptionId === pending.event.aggregateId,
          ).transport = "retry_required";
          audit(state, user.id, "integration.delivery_failed", pending.event.aggregateId, now());
        });
        results.push({ eventId: pending.id, status: "retry_required" });
        break;
      }
    }
    // Persist each accepted effect before acknowledging it. A crash only causes re-delivery.
    try {
      const reply = await partner("pullEvents", {});
      check(
        Array.isArray(reply.events) && reply.events.length <= 100,
        502,
        "invalid_pharmacy_events",
      );
      const accepted = await store.transact((state) => {
        const actor = state.users.find((u) => u.id === user.id);
        provider(actor || {}, config);
        const eventIds = [];
        for (const event of reply.events) {
          const order = state.prescriptions.find((p) => p.prescriptionId === event.aggregateId);
          // A provider only reconciles assigned patients; other events remain unacknowledged.
          if (
            !order ||
            !state.patients.find((p) => p.id === order.patientId)?.providerIds.includes(actor.id)
          )
            continue;
          receiveEvent(state, event, config, now());
          eventIds.push(event.eventId);
        }
        return eventIds;
      });
      if (accepted.length) await partner("acknowledgeEvents", { eventIds: accepted });
      return { results, received: accepted.length, reconciliation: "ok" };
    } catch {
      return { results, received: 0, reconciliation: "retry_required" };
    }
  }

  async function handle(request) {
    try {
      const path = new URL(request.url).pathname.replace(/\/$/, "");
      const method = request.method,
        instant = now();
      check(path.startsWith("/api/v1/"), 404, "route_not_found");
      check(method === "GET" || method === "POST", 405, "method_not_allowed");
      const raw = method === "POST" ? await bodyText(request) : "";
      const body = jsonBody(raw);
      if (
        path === "/api/v1/integrations/rxledger/authorization" ||
        path === "/api/v1/integrations/rxledger/dispense-events"
      ) {
        check(method === "POST", 405, "method_not_allowed");
        verifyService(request, raw, config, instant);
        return response(
          await store.transact((state) => {
            if (path.endsWith("/authorization")) {
              const order = state.prescriptions.find(
                (p) => p.prescriptionId === body.prescriptionId,
              );
              const valid =
                authorized(state, order, config, instant) &&
                order.version === body.version &&
                order.patientLinkId === body.patientLinkId;
              audit(
                state,
                "rxledger",
                "prescription.authorization_checked",
                body.prescriptionId || "unknown",
                instant,
              );
              return { authorized: Boolean(valid) };
            }
            return receiveEvent(state, body.event, config, instant);
          }),
        );
      }
      if (path === "/api/v1/integrations/rai/analytics-snapshot") {
        check(
          method === "POST" && config.raiEnabled && config.raiServiceKey?.length >= 32,
          503,
          "rai_not_configured",
        );
        check(
          equal(request.headers.get("authorization"), `Bearer ${config.raiServiceKey}`),
          401,
          "invalid_service_authentication",
        );
        const scope = range(body),
          delegated = request.headers.get("x-healthpass-delegated-token");
        check(delegated && delegated.length <= 200, 401, "delegation_required");
        return response(
          await store.transact((state) => {
            const grant = state.raiGrants.find(
              (g) =>
                equal(g.tokenHash, hash(delegated)) &&
                Date.parse(g.expiresAt) > instant &&
                !g.revokedAt,
            );
            check(
              grant &&
                grant.startDate === scope.startDate &&
                grant.endDate === scope.endDate &&
                body.organization_id === state.organizationId,
              403,
              "delegation_scope_denied",
            );
            const actor = state.users.find((u) => u.id === grant.userId && u.active);
            provider(actor || {}, config);
            check(
              state.sessions.some(
                (s) =>
                  s.id === grant.sessionId &&
                  Date.parse(s.expiresAt) > instant &&
                  Date.parse(s.lastSeenAt) > instant - 30 * 60000,
              ),
              403,
              "delegation_revoked",
            );
            audit(state, actor.id, "rai.analytics_accessed", actor.id, instant);
            return {
              meta: {
                source: "healthpass",
                organization_id: state.organizationId,
                date_range: { start_date: scope.startDate, end_date: scope.endDate },
                generated_at: iso(instant),
                capabilities: ["operational_analytics"],
              },
              data: operationalMetrics(state, actor, scope.startDate, scope.endDate),
            };
          }),
        );
      }
      if (path === "/api/v1/auth/login") {
        check(method === "POST", 405, "method_not_allowed");
        origin(request, config);
        const value = await store.transact((state) => {
          check(
            typeof body.email === "string" &&
              body.email.length <= 254 &&
              typeof body.password === "string" &&
              body.password.length <= 256,
            400,
            "invalid_credentials",
          );
          const key = hash(body.email.trim().toLowerCase());
          state.loginAttempts = state.loginAttempts
            .filter((a) => a.instant > instant - 900000)
            .slice(-10000);
          if (state.loginAttempts.filter((a) => a.key === key).length >= 5)
            return { denied: true, limited: true };
          const user = state.users.find(
            (u) =>
              u.email.toLowerCase() === body.email.trim().toLowerCase() &&
              u.active &&
              u.organizationId === state.organizationId,
          );
          const mfaRequired =
            user && (user.mfaSecret || (config.production && user.role === "provider"));
          const counter =
            user?.mfaSecret && verifyTotp(user.mfaSecret, body.otp, instant, user.lastOtpCounter);
          // Equal work for unknown accounts reduces account enumeration timing differences.
          const valid = verifyPassword(
            body.password,
            user?.passwordHash || `unregistered:${"0".repeat(128)}`,
          );
          if (
            !valid ||
            !user ||
            (mfaRequired && counter === null) ||
            (mfaRequired && !user.mfaSecret)
          ) {
            state.loginAttempts.push({ key, instant });
            audit(state, "anonymous", "auth.denied", "authentication", instant);
            return { denied: true };
          }
          if (typeof counter === "number") user.lastOtpCounter = counter;
          const sessionToken = token(),
            csrfToken = token();
          state.sessions = state.sessions.filter((s) => Date.parse(s.expiresAt) > instant);
          state.raiGrants = state.raiGrants.filter((g) => Date.parse(g.expiresAt) > instant);
          state.sessions.push({
            id: newId("session"),
            tokenHash: hash(sessionToken),
            csrfToken,
            userId: user.id,
            expiresAt: iso(instant + 8 * 3600000),
            lastSeenAt: iso(instant),
          });
          audit(state, user.id, "auth.signed_in", user.id, instant);
          return { user: safeUser(user), csrfToken, sessionToken };
        });
        check(
          !value.denied,
          value.limited ? 429 : 401,
          value.limited ? "login_rate_limited" : "invalid_credentials",
        );
        const { sessionToken, ...publicValue } = value;
        return response(publicValue, 200, { "set-cookie": cookie(sessionToken, config) });
      }
      const context = await store.transact((state) => {
        const active = session(state, request, instant);
        if (method === "POST") {
          origin(request, config);
          check(
            equal(request.headers.get("x-csrf-token"), active.entry.csrfToken),
            403,
            "csrf_denied",
          );
        }
        return {
          user: safeUser(active.user),
          sessionId: active.entry.id,
          csrfToken: active.entry.csrfToken,
        };
      });
      if (path === "/api/v1/session" && method === "GET")
        return response({ user: context.user, csrfToken: context.csrfToken });
      if (path === "/api/v1/auth/logout" && method === "POST") {
        await store.transact((state) => {
          state.sessions = state.sessions.filter((s) => s.id !== context.sessionId);
          for (const g of state.raiGrants.filter((g) => g.sessionId === context.sessionId))
            g.revokedAt = iso(instant);
          audit(state, context.user.id, "auth.signed_out", context.user.id, instant);
        });
        return response({ ok: true }, 200, { "set-cookie": cookie("", config, 0) });
      }
      if (path === "/api/v1/workspace" && method === "GET")
        return response(
          await store.transact((state) => {
            const { user } = session(state, request, now());
            return workspace(state, user, now());
          }),
        );
      if (path === "/api/v1/integrations/rxledger/deliver" && method === "POST")
        return response(await deliver(context.user));
      if (path === "/api/v1/rai/analytics" && method === "POST") {
        check(config.raiEnabled && config.raiApiKey?.length >= 32, 503, "rai_not_configured");
        const scope = range(body),
          delegated = randomBytes(32).toString("hex");
        check(
          typeof body.message === "string" &&
            body.message.length > 0 &&
            body.message.length <= 2000,
          400,
          "invalid_message",
        );
        await store.transact((state) => {
          const { user, entry } = session(state, request, now());
          provider(user, config);
          state.raiGrants.push({
            tokenHash: hash(delegated),
            userId: user.id,
            sessionId: entry.id,
            ...scope,
            expiresAt: iso(now() + 180000),
          });
          audit(state, user.id, "rai.analytics_requested", user.id, now());
        });
        let reply;
        try {
          reply = await fetchImpl(endpoint(config.raiUrl, config), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.raiApiKey}`,
              "x-healthpass-delegated-token": delegated,
            },
            body: JSON.stringify({
              message: body.message,
              organization_id: config.organizationId,
              start_date: scope.startDate,
              end_date: scope.endDate,
            }),
            signal: AbortSignal.timeout(30000),
            redirect: "error",
          });
        } catch {
          throw new HttpError(503, "rai_unavailable");
        }
        check(reply.ok, reply.status >= 500 ? 503 : 400, "rai_request_failed");
        return response(await reply.json());
      }
      const routes = [
        [/^\/api\/v1\/patients$/, "createPatient"],
        [/^\/api\/v1\/patients\/([^/]+)\/link$/, "linkPatient"],
        [/^\/api\/v1\/encounters$/, "createEncounter"],
        [/^\/api\/v1\/encounters\/([^/]+)\/sign$/, "signEncounter"],
        [/^\/api\/v1\/consents$/, "createConsent"],
        [/^\/api\/v1\/consents\/([^/]+)\/revoke$/, "revokeConsent"],
        [/^\/api\/v1\/prescriptions$/, "createPrescription"],
        [/^\/api\/v1\/prescriptions\/([^/]+)\/sign$/, "signPrescription"],
        [/^\/api\/v1\/prescriptions\/([^/]+)\/dispatch$/, "dispatchPrescription"],
        [/^\/api\/v1\/prescriptions\/([^/]+)\/cancel$/, "cancelPrescription"],
      ];
      for (const [pattern, operation] of routes) {
        const match = path.match(pattern);
        if (match && method === "POST")
          return response(
            await store.transact((state) => {
              const { user } = session(state, request, now());
              return command(state, user, operation, match[1], body, config, now());
            }),
          );
      }
      throw new HttpError(404, "route_not_found");
    } catch (error) {
      if (error instanceof HttpError) {
        const message =
          error.message === error.code ? error.code.replaceAll("_", " ") : error.message;
        return response(
          { error: message.charAt(0).toUpperCase() + message.slice(1), code: error.code },
          error.status,
        );
      }
      // Do not include clinical data, driver connection strings or model prompts in logs/errors.
      return response({ error: "Service unavailable", code: "service_unavailable" }, 503);
    }
  }
  return { handle, deliver };
}

let runtime;
export async function handleHealthPassRequest(request) {
  if (!runtime) {
    const config = runtimeConfig();
    runtime = openStore(config)
      .then((store) => createApi({ store, config }))
      .catch((error) => {
        runtime = undefined;
        throw error;
      });
  }
  try {
    return (await runtime).handle(request);
  } catch {
    return new Response(
      JSON.stringify({
        error: "HealthPass database is not configured",
        code: "database_unavailable",
      }),
      { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
}
