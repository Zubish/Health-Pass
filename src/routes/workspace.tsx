import { AccountSetup, OpenAccountSetup } from "@/components/healthpass/account-setup";
import { UserPreferences } from "@/components/healthpass/user-preferences";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { readSigninPreference } from "@/lib/healthpass-signin";
import { careApi } from "@/lib/healthpass-client";
import type { Me } from "@/lib/healthpass-types";
import { Auth, Mfa, type AccountMode } from "@/components/healthpass/auth";
import { Mark } from "@/components/healthpass/primitives";
import { PatientActivation } from "@/components/healthpass/patient-activation";
import { CareWorkspace } from "@/components/healthpass/care-workspace";
export const Route = createFileRoute("/workspace")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    mode?: AccountMode;
    tab?: string;
    patient?: string;
    visit?: string;
    branch?: string;
    setup?: boolean;
    claim?: string;
    workspace?: string;
  } => ({
    workspace: typeof search.workspace === "string" ? search.workspace.slice(0, 80) : undefined,
    claim: typeof search.claim === "string" ? search.claim : undefined,
    tab: [
      "proxies",
      "departments",
      "security",
      "admissions",
      "referrals",
      "careteam",
      "relationships",
      "overview",
      "workspace",
      "patients",
      "sharing",
      "audit",
      "today",
      "visits",
    ].includes(String(search.tab))
      ? String(search.tab)
      : undefined,
    patient: typeof search.patient === "string" ? search.patient : undefined,
    visit: typeof search.visit === "string" ? search.visit : undefined,
    branch: typeof search.branch === "string" ? search.branch : undefined,
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
  const { mode, setup, claim, workspace } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const signOut = useCallback(async () => {
    setMe(null);
    await navigate({
      search: {
        mode:
          workspace || readSigninPreference()?.workspaceCode ? "professional-signin" : undefined,
        workspace,
      },
      replace: true,
      ignoreBlocker: true,
    });
    try {
      await careApi("/auth/logout", "POST", {});
    } catch {
      /* The local signed-in view is already cleared. */
    }
  }, [navigate, workspace]);
  useEffect(() => {
    const expired = () => {
      if (me) {
        void signOut();
      }
    };
    window.addEventListener("healthpass-session-expired", expired);
    return () => window.removeEventListener("healthpass-session-expired", expired);
  }, [me, signOut]);
  useEffect(() => {
    if (!me) {
      return;
    }
    const idle = 30 * 60 * 1000;
    let last = Date.now();
    let lastSync = last;
    const key = "healthpass-last-activity";
    const saveActivity = () => {
      try {
        localStorage.setItem(key, String(last));
      } catch {
        /* Use this tab's timer when storage is unavailable. */
      }
    };
    saveActivity();
    const check = () => {
      try {
        last = Math.max(last, Number(localStorage.getItem(key)) || 0);
      } catch {
        /* The local idle timer still applies. */
      }
      if (Date.now() - last >= idle) {
        try {
          localStorage.removeItem(key);
        } catch {
          /* Logout does not depend on browser storage. */
        }
        void signOut();
      }
    };
    const activity = () => {
      if (Date.now() - last >= idle) {
        check();
        return;
      }
      last = Date.now();
      saveActivity();
      if (last - lastSync >= 60000) {
        lastSync = last;
        void careApi("/auth/me")
          .then((data) => setMe(data))
          .catch(() => {});
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
  }, [me, signOut]);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setMe(await careApi("/auth/me"));
      setError("");
    } catch (e) {
      setMe(null);
      if (!(e as Error).message.includes("Sign in")) {
        setError((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, []);
  const initialSearch = useRef({ mode, workspace, claim });
  useEffect(() => {
    const { mode, workspace, claim } = initialSearch.current;
    if (!mode && !workspace && !claim && readSigninPreference()?.workspaceCode) {
      void navigate({ search: { mode: "professional-signin" }, replace: true });
    }
  }, [navigate]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (claim) {
    return (
      <PatientActivation
        claimId={claim}
        onSuccess={async () => {
          window.history.replaceState(null, "", window.location.pathname + "?tab=relationships");
          await navigate({ search: { tab: "relationships" }, replace: true });
          await refresh();
        }}
        onSignIn={() => {
          window.history.replaceState(null, "", window.location.pathname);
          void navigate({ search: {}, replace: true });
        }}
      />
    );
  }
  if (loading) {
    return (
      <main className="hp-auth">
        <Mark />
        <p role="status">Opening your care workspace…</p>
      </main>
    );
  }
  if (!me) {
    return (
      <Auth
        key={`${mode ?? "login"}-${setup ?? false}-${workspace ?? ""}`}
        initialWorkspace={workspace}
        onForgetWorkspace={() =>
          void navigate({ search: { mode: "professional-signin" }, replace: true })
        }
        initialMode={mode}
        initialSetup={setup}
        onModeChange={(next, staff) => {
          void navigate({
            search: {
              mode: next,
              setup: staff,
              workspace:
                next === "professional-signin" || next === "professional" ? workspace : undefined,
            },
          });
        }}
        onSuccess={refresh}
        serviceError={error}
      />
    );
  }
  if (workspace && me.organization?.workspace_code !== workspace.trim().toUpperCase()) {
    return (
      <main className="hp-auth">
        <div className="hp-auth-card">
          <Mark />
          <h1>Choose your sign-in workspace</h1>
          <p>
            You are currently signed in{" "}
            {me.organization ? `to ${me.organization.name}` : "to your patient account"}. This link
            is for a different facility.
          </p>
          <button className="hp-button primary" onClick={() => void signOut()}>
            Sign in to the linked facility
          </button>
          <button
            className="hp-button secondary"
            onClick={() => void navigate({ search: {}, replace: true })}
          >
            Continue in your current account
          </button>
        </div>
      </main>
    );
  }
  if (me.pendingMembership || me.accessExpired) {
    return (
      <main className="hp-auth">
        <div className="hp-auth-card">
          <Mark />
          <h1>{me.accessExpired ? "Workspace access expired" : "Workspace access requested"}</h1>
          {me.pendingMembership && !me.accessExpired && (
            <AccountSetup
              key={me.user.id}
              me={me}
              onNavigate={() =>
                document
                  .getElementById("pending-preferences")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            />
          )}
          <p>{me.organization?.name}</p>
          <p>
            {me.accessExpired
              ? "Your access grant has expired. Contact the facility administrator to arrange a new review or support grant."
              : "Your administrator must approve your membership, job roles and branch before you can access app tools."}
          </p>
          <button className="hp-button primary" onClick={() => void refresh()}>
            Check approval status
          </button>
          {me.pendingMembership && !me.accessExpired && (
            <>
              <OpenAccountSetup />
              <div id="pending-preferences">
                <UserPreferences />
              </div>
            </>
          )}
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
  }
  if (me.mfaRequired) {
    return <Mfa me={me} onSuccess={refresh} />;
  }
  return (
    <CareWorkspace
      me={me}
      onLogout={async () => {
        await signOut();
      }}
    />
  );
}
