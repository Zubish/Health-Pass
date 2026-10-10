import test from "node:test";
import assert from "node:assert/strict";
import { createFunctionHandler } from "../server/function-handler.mjs";

const config = { HEALTHPASS_ORIGIN_SECRET: "synthetic-origin-secret-for-server-tests" };
const request = (secret = config.HEALTHPASS_ORIGIN_SECRET) =>
  new Request("https://function.example/api/healthpass/health", {
    headers: { "x-healthpass-origin-secret": secret },
  });

test("native function rejects missing and forged origin credentials before initialization", async () => {
  let initialized = 0;
  const handler = createFunctionHandler(config, async () => {
    initialized++;
    return () => Response.json({ status: "ok" });
  });
  for (const secret of ["", "forged", "x".repeat(config.HEALTHPASS_ORIGIN_SECRET.length)]) {
    const response = await handler(request(secret));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(initialized, 0);
  assert.throws(() => createFunctionHandler({}, async () => {}), /ORIGIN_SECRET/);
});

test("concurrent function requests share startup and preserve the user session", async () => {
  let initialized = 0;
  const handler = createFunctionHandler(config, async () => {
    initialized++;
    return (incoming) => Response.json({ cookie: incoming.headers.get("cookie") });
  });
  const incoming = request();
  incoming.headers.set("cookie", "hp_session=synthetic-token");
  const responses = await Promise.all([handler(incoming), handler(request())]);
  assert.equal(initialized, 1);
  assert.equal((await responses[0].json()).cookie, "hp_session=synthetic-token");
  assert.equal(responses[1].status, 200);
});

test("a failed function cold start can retry without exposing its error", async () => {
  let initialized = 0;
  const handler = createFunctionHandler(config, async () => {
    if (++initialized === 1) throw new Error("private database credential detail");
    return () => Response.json({ status: "ok" });
  });
  const failed = await handler(request());
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "2");
  assert.ok(!(await failed.text()).includes("private database"));
  assert.equal((await handler(request())).status, 200);
  assert.equal(initialized, 2);
});
