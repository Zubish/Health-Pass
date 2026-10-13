import { createServer } from "node:http";
import { Readable } from "node:stream";
import { openDatabase } from "./db.mjs";
import { createApi } from "./api.mjs";
const db = await openDatabase();
const api = createApi(db);
const server = createServer(async (req, res) => {
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 40000) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(req.method !== "GET" && req.method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await api(request);
    const headers = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(response.status, headers);
    Readable.fromWeb(response.body).pipe(res);
  } catch {
    res.writeHead(500);
    res.end("Request failed");
  }
});
server.listen(
  Number(process.env.HEALTHPASS_API_PORT || 4100),
  process.env.HEALTHPASS_API_HOST || "127.0.0.1",
  () => console.log("HealthPass API listening; clinical payload logging disabled."),
);
async function close() {
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
