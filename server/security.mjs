import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function requireCondition(ok, status, code, message) {
  if (!ok) throw new HttpError(status, code, message);
}
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, stored) {
  if (typeof password !== "string" || password.length > 256 || !stored) return false;
  const [salt] = stored.split(":");
  return equal(passwordHash(password, salt), stored);
}
function decodeBase32(value) {
  let bits = "",
    bytes = [];
  for (const char of value.toUpperCase().replace(/=+$/, "")) {
    const index = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    if (index < 0) return Buffer.alloc(0);
    bits += index.toString(2).padStart(5, "0");
  }
  while (bits.length >= 8) {
    bytes.push(parseInt(bits.slice(0, 8), 2));
    bits = bits.slice(8);
  }
  return Buffer.from(bytes);
}
export function totp(secret, instant = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(instant / 30000)));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
export function verifyTotp(secret, code, instant = Date.now(), lastCounter = -1) {
  if (!secret || !/^[0-9]{6}$/.test(code || "")) return null;
  for (const delta of [-1, 0, 1]) {
    const counter = Math.floor(instant / 30000) + delta;
    if (counter > lastCounter && equal(totp(secret, counter * 30000), code)) return counter;
  }
  return null;
}
export function signedHeaders(raw, config, instant = Date.now()) {
  const timestamp = String(Math.floor(instant / 1000));
  return {
    "content-type": "application/json",
    "x-ecosystem-timestamp": timestamp,
    "x-ecosystem-key-id": config.serviceKeyId,
    "x-ecosystem-signature": createHmac("sha256", config.serviceSecret)
      .update(`${timestamp}.${raw}`)
      .digest("hex"),
  };
}
export function verifyService(request, raw, config, instant = Date.now()) {
  requireCondition(
    config.serviceSecret?.length >= 32 && config.serviceKeyId,
    503,
    "partner_not_configured",
  );
  const timestamp = request.headers.get("x-ecosystem-timestamp");
  requireCondition(
    /^\d{10,11}$/.test(timestamp || "") && Math.abs(instant / 1000 - Number(timestamp)) <= 300,
    401,
    "invalid_service_timestamp",
  );
  const expected = createHmac("sha256", config.serviceSecret)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  requireCondition(
    equal(request.headers.get("x-ecosystem-key-id"), config.serviceKeyId) &&
      equal(request.headers.get("x-ecosystem-signature"), expected),
    401,
    "invalid_service_signature",
  );
}
export function text(value, name, max = 4000) {
  requireCondition(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    400,
    "invalid_field",
    `${name} is required and must be at most ${max} characters`,
  );
  return value.trim();
}
export function timestamp(value, name) {
  requireCondition(
    typeof value === "string" && Number.isFinite(Date.parse(value)) && /T/.test(value),
    400,
    "invalid_timestamp",
    `${name} requires an ISO timestamp`,
  );
  return new Date(value).toISOString();
}
export function date(value) {
  requireCondition(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value,
    400,
    "invalid_date",
  );
  return value;
}
