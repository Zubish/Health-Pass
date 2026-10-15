// Existing callers use heterogeneous endpoint responses; explicit callers provide their response DTO.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function careApi<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/healthpass${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (
    response.status === 401 &&
    (path !== "/auth/mfa/verify" || data.error === "Sign in to continue.") &&
    ![
      "/auth/login",
      "/auth/register",
      "/auth/patient-claim",
      "/auth/facility-register",
      "/auth/workspace-register",
    ].includes(path)
  ) {
    window.dispatchEvent(new Event("healthpass-session-expired"));
  }
  if (!response.ok) {
    throw new Error(data.error || "The request failed. Please retry.");
  }
  if (data.preferences) {
    window.dispatchEvent(new CustomEvent("healthpass-preferences", { detail: data.preferences }));
  }
  if (path === "/auth/logout") {
    window.dispatchEvent(new Event("healthpass-signed-out"));
  }
  if (method !== "GET" || /^\/emergency\/[^/]+\/records$/.test(path)) {
    window.dispatchEvent(new Event("healthpass-work-updated"));
  }
  return data;
}
