import { createServer } from "node:http";
import { Readable } from "node:stream";
import { handleHealthPassRequest } from "./api.mjs";

// Dependency-free API runner for synthetic development and service integration tests.
const port = Number(process.env.PORT || 3101);
createServer(async (req, res) => {
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    ...(req.method === "GET" || req.method === "HEAD"
      ? {}
      : { body: Readable.toWeb(req), duplex: "half" }),
  });
  const response = await handleHealthPassRequest(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () =>
  console.log(`HealthPass development API on http://localhost:${port}`),
);
