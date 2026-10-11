import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import type { Me } from "@/lib/healthpass-types";
import { Auth, Mfa, type AccountMode } from "@/components/healthpass/auth";
import { Mark } from "@/components/healthpass/primitives";
import { CareWorkspace } from "@/components/healthpass/care-workspace";
export const Route = createFileRoute("/workspace")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { mode?: AccountMode; tab?: string; patient?: string; setup?: boolean } => ({
    tab: ["overview", "workspace", "patients", "sharing", "audit"].includes(String(search.tab))
      ? String(search.tab)
      : undefined,
    patient: typeof search.patient === "string" ? search.patient : undefined,
    setup: search.setup === true || search.setup === "true" || undefined,
    mode: ["register", "patient", "professional", "facility", "professional-signin"].includes(
      String(search.mode),
    )
      ? (search.mode as AccountMode)
      : undefined,
  }),
  component: Workspace,
  head: () => ({ meta: [{ title: "HealthPass · Care workspace" }] }),
});
function Workspace() {
  const { mode, setup } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [me, setMe] = useState<Me | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");

  async function signOut() {
    setMe(null);
    await navigate({ search: {}, replace: true, ignoreBlocker: true });
    try {
      await careApi("/auth/logout", "POST", {});
    } catch {}
  }
  useEffect(() => {
    const expired = () => {
      if (me) void signOut();
    };
    window.addEventListener("healthpass-session-expired", expired);
    return () => window.removeEventListener("healthpass-session-expired", expired);
  }, [me]);
  useEffect(() => {
    if (!me) return;
    const idle = 30 * 60 * 1000;
    let last = Date.now(),
      lastSync = last;
    const key = "healthpass-last-activity";
    localStorage.setItem(key, String(last));
    const check = () => {
      last = Math.max(last, Number(localStorage.getItem(key)) || 0);
      if (Date.now() - last >= idle) {
        localStorage.removeItem(key);
        void signOut();
      }
    };
    const activity = () => {
      if (Date.now() - last >= idle) {
        check();
        return;
      }
      last = Date.now();
      localStorage.setItem(key, String(last));
      if (last - lastSync >= 60000) {
        lastSync = last;
        void careApi("/auth/me").catch(() => {});
      }
    };
    const events = ["pointerdown", "keydown", "touchstart", "scroll"];
    events.forEach((event) => window.addEventListener(event, activity, { passive: true }));
    const timer = window.setInterval(check, 1000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      events.forEach((event) => window.removeEventListener(event, activity));
      window.removeEventListener("focus", check);
    };
  }, [me]);
  async function refresh() {
    setLoading(true);
    try {
      setMe(await careApi("/auth/me"));
      setError("");
    } catch (e) {
      setMe(null);
      if (!(e as Error).message.includes("Sign in")) setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  if (loading)
    return (
      <main className="hp-auth">
        <Mark />
        <p role="status">Opening your care workspace…</p>
      </main>
    );
  if (!me)
    return (
      <Auth
        key={`${mode ?? "login"}-${setup ?? false}`}
        initialMode={mode}
        initialSetup={setup}
        onModeChange={(next, staff) => {
          void navigate({ search: { mode: next, setup: staff } });
        }}
        onSuccess={refresh}
        serviceError={error}
      />
    );
  if (me.pendingMembership)
    return (
      <main className="hp-auth">
        <div className="hp-auth-card">
          <Mark />
          <h1>Workspace access requested</h1>
          <p>{me.organization?.name}</p>
          <p>
            Your administrator must approve your membership, role and branch before you can access
            care records.
          </p>
          <button className="hp-button primary" onClick={() => void refresh()}>
            Check approval status
          </button>
          <button
            className="hp-text-button"
            onClick={async () => {
              await signOut();
            }}
          >
            Sign out
          </button>
        </div>
      </main>
    );
  if (me.mfaRequired) return <Mfa me={me} onSuccess={refresh} />;
  return (
    <CareWorkspace
      me={me}
      onLogout={async () => {
        await signOut();
      }}
    />
  );
}
