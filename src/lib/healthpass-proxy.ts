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
  // Some function hosts combine Set-Cookie values. These two HealthPass cookies
  // contain no commas in their values; split only at our known cookie names.
  const cookies = response.headers
    .getSetCookie()
    .flatMap((value) => value.split(/,\s*(?=hp_(?:session|device)=)/));
  const deviceCookie = response.headers.get("x-healthpass-device-cookie");
  outgoing.delete("x-healthpass-device-cookie");
  if (
    deviceCookie &&
    /^hp_device=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000(?:; Secure)?$/.test(
      deviceCookie,
    )
  ) {
    cookies.push(deviceCookie);
  }
  outgoing.delete("set-cookie");
  for (const cookie of cookies) {
    outgoing.append("set-cookie", cookie);
  }

  outgoing.delete("content-encoding");
  outgoing.delete("content-length");
  outgoing.delete("transfer-encoding");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outgoing,
  });
}
