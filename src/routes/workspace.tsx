import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import type { Me } from "@/lib/healthpass-types";
import { Auth, Mfa, type AccountMode } from "@/components/healthpass/auth";
import { Mark } from "@/components/healthpass/primitives";
import { CareWorkspace } from "@/components/healthpass/care-workspace";
export const Route = createFileRoute("/workspace")({
  validateSearch: (search: Record<string, unknown>): { mode?: AccountMode } => ({
    mode: ["register", "patient", "professional", "professional-signin"].includes(
      String(search.mode),
    )
      ? (search.mode as AccountMode)
      : undefined,
  }),
  component: Workspace,
  head: () => ({ meta: [{ title: "HealthPass · Care workspace" }] }),
});
function Workspace() {
  const { mode } = Route.useSearch();
  const [me, setMe] = useState<Me | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
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
      <Auth key={mode ?? "login"} initialMode={mode} onSuccess={refresh} serviceError={error} />
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
              await careApi("/auth/logout", "POST", {});
              await refresh();
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
        await careApi("/auth/logout", "POST", {});
        await refresh();
      }}
    />
  );
}
