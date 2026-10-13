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
export function AccountSecurity({ onLogout }: { onLogout: () => Promise<void> }) {
  const [data, setData] = useState<Security | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
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
        <p className="hp-eyebrow">YOUR ACCOUNT</p>
        <h1>Session management & security</h1>
      </div>
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {data && (
        <>
          <section className="hp-panel hp-security-panel">
            <h2>Session limits</h2>
            <p>
              HealthPass signs you out after <strong>30 minutes without activity</strong>. Every
              session also expires after <strong>30 days</strong>, requiring a fresh sign-in with
              your credentials. These platform limits cannot be changed.
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
              This optional limit reduces the time a stolen session can remain active. When enabled,
              it signs you out after eight hours even while you are working. It is enabled initially
              for every account.
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
                      if (result.current) await onLogout();
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
            <p>Action times are recorded independently of the audit screen.</p>
            {data.activity?.map((a) => (
              <p key={a.id}>
                {a.action} · {date(a.created_at)}
              </p>
            ))}
          </section>
          <section className="hp-panel hp-security-panel">
            <h2>Recent sign-in activity</h2>
            <p>
              New devices and changes in country are flagged for review. Travel, VPNs and browser
              changes can also explain these alerts. Location is approximate and may be unavailable.
            </p>
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
                      })
                    }
                  >
                    This was me
                  </button>
                )}
              </div>
            ))}
            <p className="hp-fine">
              If a sign-in was not yours, sign out that session. Recognition is a warning signal,
              not proof that a person is legitimate. HealthPass does not override your password or
              optional authenticator checks.
            </p>
          </section>
        </>
      )}
    </>
  );
}
