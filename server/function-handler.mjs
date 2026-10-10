import { timingSafeEqual } from "node:crypto";

// The browser uses the app's same-origin proxy. Only that server may invoke this function.
export function createFunctionHandler(config, initialize) {
  if (!config.HEALTHPASS_ORIGIN_SECRET || config.HEALTHPASS_ORIGIN_SECRET.length < 32)
    throw new Error(
      "Set HEALTHPASS_ORIGIN_SECRET to a server-only secret of at least 32 characters.",
    );
  const expected = Buffer.from(config.HEALTHPASS_ORIGIN_SECRET);
  let pending;
  return async function fetch(request) {
    const supplied = Buffer.from(request.headers.get("x-healthpass-origin-secret") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return Response.json(
        { error: "Unauthorized." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    // Share initialization across concurrent requests, but allow a cold-start connection to retry.
    if (!pending) {
      pending = Promise.resolve().then(initialize);
      pending.catch(() => {
        pending = undefined;
      });
    }
    let api;
    try {
      api = await pending;
    } catch {
      return Response.json(
        { error: "The care service is unavailable. Please retry." },
        { status: 503, headers: { "cache-control": "no-store", "retry-after": "2" } },
      );
    }
    return api(request);
  };
}
