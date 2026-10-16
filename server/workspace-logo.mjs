import { PNG } from "pngjs";

export function canManageWorkspaceLogo(actor, hasPermission) {
  return (
    !!actor &&
    (actor.isOwner || actor.role === "administrator") &&
    hasPermission(actor, "roles.manage")
  );
}

/** Accept only bounded, decoded PNG pixels; rewrite to discard metadata and trailing content. */
export function normalizeWorkspaceLogo(value, fail) {
  if (
    typeof value !== "string" ||
    value.length > 600000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    fail(400, "Choose a valid PNG, JPEG or WebP image up to 5 MB.");
  }
  try {
    const buffer = Buffer.from(value.split(",")[1], "base64");
    if (
      buffer.length < 33 ||
      buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      buffer.toString("ascii", 12, 16) !== "IHDR"
    ) {
      throw new Error("Invalid PNG");
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height || width > 320 || height > 320) {
      throw new Error("Invalid dimensions");
    }
    const decoded = PNG.sync.read(buffer, { checkCRC: true });
    return "data:image/png;base64," + PNG.sync.write(decoded).toString("base64");
  } catch {
    fail(400, "This image could not be read. Choose another PNG, JPEG or WebP image.");
  }
}
