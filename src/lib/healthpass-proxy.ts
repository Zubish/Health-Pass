/** Node fetch decodes upstream compression; forward headers for the decoded body. */
export async function fetchHealthpassOrigin(
  request: Request,
  upstream: URL,
  headers: Headers,
): Promise<Response> {
  headers.set("accept-encoding", "identity");
  const response = await fetch(upstream, {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    ...(request.method !== "GET" && request.method !== "HEAD"
      ? { body: await request.arrayBuffer() }
      : {}),
  });
  const outgoing = new Headers(response.headers);
  outgoing.delete("content-encoding");
  outgoing.delete("content-length");
  outgoing.delete("transfer-encoding");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outgoing,
  });
}
