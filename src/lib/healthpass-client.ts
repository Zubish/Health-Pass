export async function careApi<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/healthpass${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request failed. Please retry.");
  return data;
}
