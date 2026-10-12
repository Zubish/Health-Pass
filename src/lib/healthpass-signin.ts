// Convenience only: never persist passwords, sessions or clinical information here.
export const SIGNIN_PREFERENCE_KEY = "healthpass-signin-context:v1";
export const SIGNIN_PREFERENCE_TTL = 30 * 24 * 60 * 60 * 1000;
export type SigninPreference = { workspaceCode?: string; expiresAt: number };
export function readSigninPreference(): SigninPreference | null {
  try {
    const raw = localStorage.getItem(SIGNIN_PREFERENCE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + SIGNIN_PREFERENCE_TTL ||
      typeof value.workspaceCode !== "string" ||
      !/^HP-[A-Z0-9-]+$/.test(value.workspaceCode)
    ) {
      localStorage.removeItem(SIGNIN_PREFERENCE_KEY);
      return null;
    }
    return { workspaceCode: value.workspaceCode, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
}
export function rememberSigninWorkspace(code?: string) {
  try {
    if (!code) localStorage.removeItem(SIGNIN_PREFERENCE_KEY);
    else {
      const existing = readSigninPreference();
      localStorage.setItem(
        SIGNIN_PREFERENCE_KEY,
        JSON.stringify({
          workspaceCode: code,
          expiresAt:
            existing?.workspaceCode === code
              ? existing.expiresAt
              : Date.now() + SIGNIN_PREFERENCE_TTL,
        }),
      );
    }
    return true;
  } catch {
    return false;
  }
}
export function workspaceSigninPath(name: string, code: string) {
  const label =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "facility";
  return `/w/${label}/${encodeURIComponent(code)}`;
}
