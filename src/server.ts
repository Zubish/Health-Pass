import { fetchHealthpassOrigin } from "./lib/healthpass-proxy";
import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      if (new URL(request.url).pathname.startsWith("/api/healthpass/")) {
        const origin =
          (env as { HEALTHPASS_API_ORIGIN?: string } | undefined)?.HEALTHPASS_API_ORIGIN ??
          process.env.HEALTHPASS_API_ORIGIN;
        if (!origin)
          return Response.json(
            { error: "The care workspace is awaiting its API connection." },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        const target = new URL(request.url);
        const upstream = new URL(target.pathname + target.search, origin);
        const headers = new Headers(request.headers);
        headers.delete("host");
        // Always overwrite the client header; the credential belongs to the server hop.
        headers.delete("x-healthpass-origin-secret");
        const originSecret =
          (env as { HEALTHPASS_ORIGIN_SECRET?: string } | undefined)?.HEALTHPASS_ORIGIN_SECRET ??
          process.env.HEALTHPASS_ORIGIN_SECRET;
        if (originSecret) headers.set("x-healthpass-origin-secret", originSecret);
        try {
          return await fetchHealthpassOrigin(request, upstream, headers);
        } catch {
          return Response.json(
            {
              error: "The care service is unavailable. Your unsaved input remains on this screen.",
            },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      }
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response);
      if (new URL(request.url).pathname === "/workspace") {
        const headers = new Headers(normalized.headers);
        headers.set("cache-control", "no-store");
        return new Response(normalized.body, {
          status: normalized.status,
          statusText: normalized.statusText,
          headers,
        });
      }
      return normalized;
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
