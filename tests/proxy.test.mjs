import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { brotliCompressSync } from "node:zlib";
import { fetchHealthpassOrigin } from "../src/lib/healthpass-proxy.ts";
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
test("compressed role settings survive both proxy HTTP hops with session and request metadata intact", async () => {
  const payload = {
    roles: Array.from({ length: 100 }, (_, i) => ({
      name: "Synthetic role " + i,
      description: "Synthetic permission data ".repeat(30),
    })),
  };
  let received;
  const origin = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body };
    const encoded = brotliCompressSync(Buffer.from(JSON.stringify(payload)));
    res.writeHead(201, {
      "content-type": "application/json",
      "content-encoding": "br",
      "content-length": encoded.length,
      "set-cookie": "hp_session=synthetic-cookie; HttpOnly; Path=/",
      "cache-control": "no-store",
    });
    res.end(encoded);
  });
  const originPort = await listen(origin);
  const proxy = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = new Request("http://proxy.example/workspace/settings", {
        method: "POST",
        body,
        headers: {
          origin: "https://app.example",
          cookie: "hp_session=synthetic-input",
          "content-type": "application/json",
        },
      });
      const headers = new Headers(request.headers);
      headers.set("x-healthpass-origin-secret", "synthetic-origin-secret");
      const response = await fetchHealthpassOrigin(
        request,
        new URL(`http://127.0.0.1:${originPort}/settings`),
        headers,
      );
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end("Proxy failed");
    }
  });
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/settings`, {
      method: "POST",
      body: JSON.stringify({ workspace: "synthetic" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.match(response.headers.get("set-cookie"), /hp_session=synthetic-cookie/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), payload);
    assert.equal(received.headers["accept-encoding"], "identity");
    assert.equal(received.headers.origin, "https://app.example");
    assert.equal(received.headers.cookie, "hp_session=synthetic-input");
    assert.equal(received.headers["x-healthpass-origin-secret"], "synthetic-origin-secret");
    assert.deepEqual(JSON.parse(received.body), { workspace: "synthetic" });
  } finally {
    await close(proxy);
    await close(origin);
  }
});
test("combined function-host cookies are delivered as separate session and device cookies", async () => {
  const origin = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie":
        "hp_session=synthetic-session; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000, hp_device=synthetic-device; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000",
    });
    res.end("{}");
  });
  const port = await listen(origin);
  try {
    const response = await fetchHealthpassOrigin(
      new Request("http://proxy.example/auth/login"),
      new URL("http://127.0.0.1:" + port + "/auth/login"),
      new Headers(),
    );
    assert.deepEqual(response.headers.getSetCookie(), [
      "hp_session=synthetic-session; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000",
      "hp_device=synthetic-device; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000",
    ]);
  } finally {
    await close(origin);
  }
});
