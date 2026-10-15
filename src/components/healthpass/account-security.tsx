import { OpenAccountSetup } from "./account-setup";
import type { Me } from "@/lib/healthpass-types";
import { WorkspaceLogoSettings } from "./workspace-logo-settings";
import { UserPreferences } from "./user-preferences";
import { useSuccessFeedback } from "@/lib/healthpass-preferences";
import { useCallback, useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import { date } from "@/lib/healthpass-types";
type Security = {
  activity: { id: string; action: string; created_at: string }[];
  eightHourLimit: boolean;
  currentSession: string;
  sessions: {
    id: string;
    device_label: string | null;
    country: string | null;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
  }[];
  events: {
    id: string;
    action: string;
    device_label: string;
    country: string | null;
    risk: string;
    created_at: string;
    reviewed_at: string | null;
  }[];
};
function activityLabel(action: string) {
  const labels: Record<string, string> = {
    "auth · login": "Signed in",
    "auth · mfa · skip": "Continued to workspace",
    "auth · logout": "Signed out",
    "workspace · logo": "Facility logo changed",
    "account · setup": "Account setup updated",
    "account · preferences": "Appearance or sound updated",
    "account · security": "Session settings updated",
    "account · security · sessions · revoke": "Session signed out",
    "account · security · events · review": "Sign-in reviewed",
  };
  if (labels[action]) {
    return labels[action];
  }
  const words: Record<string, string> = {
    auth: "Account",
    mfa: "Authenticator",
    treatment: "Treatment",
    patients: "Patient record",
    orders: "Orders",
    departments: "Department care",
    account: "Account",
    security: "Security",
    prescriptions: "Prescriptions",
    visits: "Visits",
    workspace: "Workspace",
    members: "Team access",
    roles: "Job roles",
    report: "Report signed",
    release: "Report released",
    accept: "Request accepted",
    start: "Care started",
    amend: "Report amended",
    observations: "Observations",
    login: "Sign-in",
    notes: "Clinical notes",
  };
  if (action.startsWith("treatment · ")) {
    if (action.includes("administrations")) {
      return "Medication administration recorded";
    }
    if (action.endsWith("orders")) {
      return "Medication orders";
    }
    if (action.endsWith("observations")) {
      return "Observations recorded";
    }
    if (action.endsWith("decisions")) {
      return "Admission or discharge decision recorded";
    }
  }
  return (
    action
      .split(" · ")
      .map((part) => words[part])
      .filter(Boolean)
      .join(" · ") || "Account activity"
  );
}
export function AccountSecurity({ me, onLogout }: { me: Me; onLogout: () => Promise<void> }) {
  const [data, setData] = useState<Security | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setNotice = useSuccessFeedback();
  const [showAllActivity, setShowAllActivity] = useState(false);
  const load = useCallback(async () => setData(await careApi<Security>("/account/security")), []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="hp-page-heading">
        <h1>Settings & security</h1>
        <p>Manage your sessions and review sign-ins.</p>
      </div>
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}

      {!data && !error && <p role="status">Loading security settings…</p>}
      {data && (
        <div className="hp-security-grid">
          <OpenAccountSetup />
          {me.canManageWorkspaceLogo && <WorkspaceLogoSettings me={me} />}
          <UserPreferences />
          <section className="hp-panel hp-security-panel">
            <h2>Session limits</h2>
            <p>
              HealthPass signs you out after <strong>30 minutes without activity</strong>. Every
              session expires after <strong>30 days</strong>. You’ll then need to sign in again.
            </p>
            <label className="hp-choice">
              <input
                type="checkbox"
                checked={data.eightHourLimit}
                disabled={busy}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setData({ ...data, eightHourLimit: enabled });
                  void act(async () => {
                    await careApi("/account/security", "PATCH", { eight_hour_limit: enabled });
                    setNotice(
                      enabled
                        ? "Eight-hour limit enabled. An older active session may now end."
                        : "Eight-hour limit disabled. Inactivity and 30-day expiry still apply.",
                    );
                  });
                }}
              />
              <span>End active sessions after eight hours</span>
            </label>
            <p className="hp-fine">
              Adds protection on shared devices by signing you out after eight hours, even while
              you’re working.
            </p>
          </section>
          <section className="hp-panel hp-security-panel">
            <h2>Active sessions</h2>
            {data.sessions.map((s) => (
              <div className="hp-grant" key={s.id}>
                <div>
                  <strong>
                    {s.device_label || "Existing session"}
                    {s.id === data.currentSession ? " · This session" : ""}
                  </strong>
                  <p>{s.country || "Location unavailable"}</p>
                  <small>
                    Signed in {date(s.created_at)} · Last active {date(s.last_seen_at)}
                  </small>
                </div>
                <button
                  className="hp-button secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const result = await careApi<{ current: boolean }>(
                        `/account/security/sessions/${s.id}/revoke`,
                        "POST",
                        {},
                      );
                      setNotice("Session signed out.");
                      if (result.current) {
                        await onLogout();
                      }
                    })
                  }
                >
                  Sign out this session
                </button>
              </div>
            ))}
          </section>
          <section className="hp-panel hp-security-panel">
            <h2>My recent actions</h2>

            <ul className="hp-activity-list">
              {(showAllActivity ? data.activity : data.activity?.slice(0, 6))?.map((a) => (
                <li key={a.id}>
                  <span>{activityLabel(a.action)}</span>
                  <time dateTime={a.created_at}>{date(a.created_at)}</time>
                </li>
              ))}
            </ul>
            {!data.activity?.length && <p>No recent activity.</p>}
            {data.activity?.length > 6 && (
              <button
                className="hp-text-button"
                onClick={() => setShowAllActivity(!showAllActivity)}
              >
                {showAllActivity ? "Show less" : "Show all activity"}
              </button>
            )}
          </section>
          <section className="hp-panel hp-security-panel">
            <h2>Recent sign-in activity</h2>
            <p>
              Check any sign-in you don’t recognise. Locations are approximate and may change when
              you travel or use a VPN.
            </p>
            {!data.events.length && <p>No recent sign-ins to review.</p>}
            {data.events.map((e) => (
              <div className="hp-grant" key={e.id}>
                <div>
                  <strong>{e.device_label}</strong>
                  <p>
                    {date(e.created_at)} · {e.country || "Location unavailable"}
                  </p>
                  <span className={`hp-chip ${e.risk === "normal" ? "neutral" : "amber"}`}>
                    {e.risk === "normal"
                      ? "Signed in"
                      : e.risk
                          .replaceAll("new_device", "New device")
                          .replaceAll("country_changed", "Country changed")
                          .replaceAll("failed_password", "Failed sign-in")
                          .replaceAll(",", " · ")}
                  </span>
                  {e.reviewed_at && <small>Reviewed {date(e.reviewed_at)}</small>}
                </div>
                {e.risk !== "normal" && !e.reviewed_at && (
                  <button
                    className="hp-button secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await careApi(`/account/security/events/${e.id}/review`, "POST", {});
                        setNotice("Sign-in reviewed.");
                      })
                    }
                  >
                    This was me
                  </button>
                )}
              </div>
            ))}
            <p className="hp-fine">Don’t recognise a sign-in? End that session above.</p>
          </section>
        </div>
      )}
    </>
  );
}
