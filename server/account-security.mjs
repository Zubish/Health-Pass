import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "./security.mjs";
const now = () => new Date().toISOString();
export function signinContext(request) {
  const raw = request.headers.get("user-agent") || "Unknown device";
  const browser = /Edg\//.test(raw)
    ? "Edge"
    : /Firefox\//.test(raw)
      ? "Firefox"
      : /Chrome\//.test(raw)
        ? "Chrome"
        : /Safari\//.test(raw)
          ? "Safari"
          : "Browser";
  const platform = /iPhone|iPad/.test(raw)
    ? "iOS"
    : /Android/.test(raw)
      ? "Android"
      : /Windows/.test(raw)
        ? "Windows"
        : /Macintosh/.test(raw)
          ? "macOS"
          : /Linux/.test(raw)
            ? "Linux"
            : "Unknown platform";
  const country = request.headers.get("x-healthpass-country");
  return {
    label: browser + " · " + platform,
    country: country && /^[A-Z]{2}$/.test(country) ? country : null,
    ip: request.headers.get("x-healthpass-client-ip") || null,
    device: request.headers.get("cookie")?.match(/(?:^|;\s*)hp_device=([a-f0-9]{64})/)?.[1],
  };
}
export async function recordSignin(tx, request, headers, secure, sessionToken) {
  const session = await tx.get("SELECT * FROM sessions WHERE token_hash=?", [hash(sessionToken)]);
  if (!session) {
    return;
  }
  const signInContext = signinContext(request);
  const token = signInContext.device || randomBytes(32).toString("hex");
  let device = await tx.get("SELECT * FROM login_devices WHERE user_id=? AND device_hash=?", [
    session.user_id,
    hash(token),
  ]);
  const previous = await tx.get(
    "SELECT country FROM signin_events WHERE user_id=? AND action='signed_in' ORDER BY created_at DESC LIMIT 1",
    [session.user_id],
  );
  const risk =
    [
      !device && previous ? "new_device" : null,
      previous?.country && signInContext.country && previous.country !== signInContext.country
        ? "country_changed"
        : null,
    ]
      .filter(Boolean)
      .join(",") || "normal";
  const ipHash = signInContext.ip ? hash("healthpass-ip:" + signInContext.ip) : null;
  if (!device) {
    device = { id: randomUUID() };
    await tx.run(
      "INSERT INTO login_devices(id,user_id,device_hash,device_label,country,ip_hash,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,device_hash) DO NOTHING",
      [
        device.id,
        session.user_id,
        hash(token),
        signInContext.label,
        signInContext.country,
        ipHash,
        now(),
        now(),
      ],
    );
    device = await tx.get("SELECT id FROM login_devices WHERE user_id=? AND device_hash=?", [
      session.user_id,
      hash(token),
    ]);
  }
  await tx.run(
    "UPDATE login_devices SET device_label=?,country=?,ip_hash=?,last_seen_at=? WHERE id=?",
    [signInContext.label, signInContext.country, ipHash, now(), device.id],
  );
  await tx.run("UPDATE sessions SET device_id=? WHERE id=?", [device.id, session.id]);
  await tx.run(
    "INSERT INTO signin_events(id,user_id,device_id,action,device_label,country,ip_hash,risk,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      randomUUID(),
      session.user_id,
      device.id,
      "signed_in",
      signInContext.label,
      signInContext.country,
      ipHash,
      risk,
      now(),
    ],
  );
  headers.set(
    "x-healthpass-device-cookie",
    `hp_device=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`,
  );
}
export async function handleAccountSecurity(tx, context) {
  const { path, method, actor, body, fail } = context;
  if (!path.startsWith("/account/security") && path !== "/account/preferences") {
    return;
  }
  if (!(path === "/account/preferences" && actor?.pendingMembership)) {
    context.strong(actor);
  }
  if (path === "/account/preferences") {
    if (method === "PATCH") {
      if (
        !["system", "light", "dark"].includes(body.theme) ||
        typeof body.soundEnabled !== "boolean"
      ) {
        fail(400, "Choose an appearance and whether to play completion sounds.");
      }
      await tx.run("UPDATE users SET theme=?,sound_enabled=? WHERE id=?", [
        body.theme,
        Number(body.soundEnabled),
        actor.id,
      ]);
      return { preferences: { theme: body.theme, soundEnabled: body.soundEnabled } };
    }
    if (method === "GET") {
      return { preferences: { theme: actor.theme, soundEnabled: !!actor.sound_enabled } };
    }
  }
  const events = () =>
    tx.all(
      "SELECT id,action,device_label,country,risk,created_at,reviewed_at FROM signin_events WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      [actor.id],
    );
  if (path === "/account/security" && method === "GET") {
    const sessions = await tx.all(
      "SELECT s.id,s.created_at,s.last_seen_at,s.expires_at,d.device_label,d.country FROM sessions s LEFT JOIN login_devices d ON d.id=s.device_id WHERE s.user_id=? AND s.expires_at>? AND s.last_seen_at>? AND (?=0 OR s.created_at>?) ORDER BY s.created_at DESC",
      [
        actor.id,
        now(),
        new Date(Date.now() - 1800000).toISOString(),
        actor.eight_hour_limit,
        new Date(Date.now() - 28800000).toISOString(),
      ],
    );
    return {
      eightHourLimit: !!actor.eight_hour_limit,
      idleMinutes: 30,
      mandatoryDays: 30,
      currentSession: actor.session_id,
      sessions,
      events: await events(),
      activity: await tx.all(
        "SELECT id,action,created_at FROM account_activity WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        [actor.id],
      ),
    };
  }
  if (path === "/account/security" && method === "PATCH") {
    if (typeof body.eight_hour_limit !== "boolean") {
      fail(400, "Choose whether to enable the eight-hour session limit.");
    }
    await tx.run("UPDATE users SET eight_hour_limit=? WHERE id=?", [
      Number(body.eight_hour_limit),
      actor.id,
    ]);
    if (!body.eight_hour_limit) {
      const sessions = await tx.all("SELECT id,created_at FROM sessions WHERE user_id=?", [
        actor.id,
      ]);
      for (const session of sessions) {
        await tx.run("UPDATE sessions SET expires_at=? WHERE id=?", [
          new Date(Date.parse(session.created_at) + 30 * 86400000).toISOString(),
          session.id,
        ]);
      }
    }
    await context.audit(
      tx,
      actor,
      "security.session_limit.changed",
      "allow",
      null,
      actor.id,
      context.correlation,
      null,
      JSON.stringify({ enabled: body.eight_hour_limit }),
    );
    return { saved: true };
  }
  const revoke = path.match(/^\/account\/security\/sessions\/([^/]+)\/revoke$/);
  if (revoke && method === "POST") {
    const session = await tx.get("SELECT id FROM sessions WHERE id=? AND user_id=?", [
      revoke[1],
      actor.id,
    ]);
    if (!session) {
      fail(404, "Session unavailable.");
    }
    await tx.run("DELETE FROM sessions WHERE id=? AND user_id=?", [session.id, actor.id]);
    await context.audit(
      tx,
      actor,
      "security.session.revoked",
      "allow",
      null,
      session.id,
      context.correlation,
    );
    return { revoked: true, current: session.id === actor.session_id };
  }
  const review = path.match(/^\/account\/security\/events\/([^/]+)\/review$/);
  if (review && method === "POST") {
    if (
      !(await tx.get("SELECT id FROM signin_events WHERE id=? AND user_id=?", [
        review[1],
        actor.id,
      ]))
    ) {
      fail(404, "Sign-in event unavailable.");
    }
    await tx.run("UPDATE signin_events SET reviewed_at=? WHERE id=? AND user_id=?", [
      now(),
      review[1],
      actor.id,
    ]);
    return { reviewed: true };
  }
  fail(404, "Security action unavailable.");
}
