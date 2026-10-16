import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { careApi } from "@/lib/healthpass-client";
import { useSuccessFeedback } from "@/lib/healthpass-preferences";
import { date, type Me } from "@/lib/healthpass-types";
import { Modal } from "./primitives";

type Appointment = {
  id: string;
  patient_name: string;
  proxy_name: string | null;
  proxy_facility: string | null;
  scopes: string[];
  include_profile: number;
  status: string;
  effective: boolean;
  can_revoke: boolean;
  can_respond: boolean;
  created_at: string;
  policy_version: string;
};
type Emergency = {
  id: string;
  patient_name: string;
  healthpass_id: string;
  requester_name: string;
  facility_name: string;
  branch_name: string | null;
  scopes: string[];
  include_profile: number;
  reason: string;
  status: string;
  created_at: string;
  expires_at: string;
  access_until: string | null;
  decision_by_name: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  can_respond: boolean;
  can_read: boolean;
  can_cancel: boolean;
  effective: boolean;
};
type Event = {
  id: string;
  sequence: number;
  action: string;
  actor_name: string;
  facility_name: string | null;
  created_at: string;
  details: string;
  hash: string;
};
type Guide = {
  appointments: Appointment[];
  primary: { id: string; name: string } | null;
  policy: string;
  policyVersion: string;
  categories: string[];
};
type Options = {
  patient: { name: string; healthpass_id: string };
  proxies: { id: string; name: string; scopes: string[]; include_profile: boolean }[];
};
type Records = {
  summaries: {
    id: string;
    title: string;
    author_name: string;
    facility_name: string;
    recorded_at: string;
    fields: { label: string; value: string }[];
  }[];
  accessUntil: string;
  profile: { allergy_status: string; allergies: string } | null;
  records: {
    id: string;
    version_id: string;
    note_kind: string;
    facility_name: string;
    author_name: string;
    signed_at: string;
    payload: Record<string, unknown>;
  }[];
};
const labels: Record<string, string> = {
  general: "Consultations and observations",
  nursing: "Nursing notes and observations",
  medication: "Medicines and administration",
  laboratory: "Laboratory notes and released results",
  radiology: "Imaging notes and released reports",
};
function ScopeChoices({
  values,
  onChange,
  available,
  disabled,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  available: string[];
  disabled: boolean;
}) {
  return (
    <fieldset className="hp-proxy-scopes" disabled={disabled}>
      <legend>Records this authority covers</legend>
      {available.map((s) => (
        <label className="hp-choice" key={s}>
          <input
            type="checkbox"
            checked={values.includes(s)}
            onChange={(e) =>
              onChange(e.target.checked ? [...values, s] : values.filter((v) => v !== s))
            }
          />
          <span>{labels[s] || s}</span>
        </label>
      ))}
    </fieldset>
  );
}
export function EmergencyProxies({ me }: { me: Me }) {
  const patient = !!me.user.patient_id;
  const canRequest = !!me.permissions?.includes("emergency.request");
  const key = [me.user.id, me.organization?.id];
  const guide = useQuery<Guide>({
    queryKey: ["proxies", ...key],
    queryFn: () => careApi("/proxies"),
  });
  const requests = useQuery<{ requests: Emergency[] }>({
    queryKey: ["emergency", ...key],
    queryFn: () => careApi("/emergency"),
  });
  const [before, setBefore] = useState<number | undefined>();
  const history = useQuery<{ events: Event[]; nextBefore: number | null }>({
    queryKey: ["proxy-history", ...key, before],
    queryFn: () => careApi("/proxies/history" + (before ? "?before=" + before : "")),
    enabled: patient,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const success = useSuccessFeedback();
  const [invite, setInvite] = useState(false);
  const [kind, setKind] = useState("person");
  const [email, setEmail] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [professional, setProfessional] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);
  const [profile, setProfile] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [healthpassId, setHealthpassId] = useState("");
  const [options, setOptions] = useState<Options | null>(null);
  const [proxy, setProxy] = useState("");
  const [requestedScopes, setRequestedScopes] = useState<string[]>([]);
  const [requestedProfile, setRequestedProfile] = useState(false);
  const [reason, setReason] = useState("");
  const [unable, setUnable] = useState(false);
  const [decision, setDecision] = useState<{ request: Emergency; action: string } | null>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [records, setRecords] = useState<Records | null>(null);
  useEffect(() => {
    if (!records) {
      return;
    }
    const timer = setTimeout(
      () => setRecords(null),
      Math.max(0, Date.parse(records.accessUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [records]);
  async function refresh() {
    await Promise.all([
      guide.refetch(),
      requests.refetch(),
      ...(patient ? [history.refetch()] : []),
    ]);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const chosen = options?.proxies.find((p) => p.id === proxy);
  return (
    <section className="hp-proxy-page">
      <header>
        <h1>Proxies & emergency sharing</h1>
        <p>
          {patient
            ? "Choose who can authorise limited access when you cannot consent."
            : "Respond to proxy invitations and emergency requests in this account."}
        </p>
      </header>
      {(error || guide.isError || requests.isError || history.isError) && (
        <p className="hp-error" role="alert">
          {error || "Could not load emergency sharing. Please refresh."}
        </p>
      )}
      <div className="hp-form-actions">
        <button className="hp-button secondary" disabled={busy} onClick={() => void run(refresh)}>
          Refresh
        </button>
        {patient && (
          <button
            className="hp-button"
            onClick={() => {
              setInvite(true);
              setAccepted(false);
              setScopes([]);
              setProfile(false);
            }}
          >
            Appoint a proxy
          </button>
        )}
      </div>
      {guide.data && (
        <details className="hp-notice">
          <summary>Emergency-sharing policy</summary>
          <p>{guide.data.policy}</p>
        </details>
      )}
      <section className="hp-panel hp-proxy-panel">
        <h2>{patient ? "Your proxy appointments" : "Proxy invitations & appointments"}</h2>
        {guide.isPending ? (
          <p>Loading appointments…</p>
        ) : !guide.data?.appointments.length ? (
          <p>No proxy appointments yet.</p>
        ) : (
          guide.data.appointments.map((p) => (
            <article className="hp-proxy-item" key={p.id}>
              <h3>{patient ? p.proxy_name || p.proxy_facility : p.patient_name}</h3>
              <p>
                <strong>
                  {p.status === "accepted" && !p.effective ? "Unavailable" : p.status}
                </strong>{" "}
                · {date(p.created_at)}
              </p>
              <p>
                {p.scopes.map((s) => labels[s]).join(", ")}
                {p.include_profile ? " · Allergy summary" : ""}
              </p>
              <p className="hp-fine">
                Emergency approval only. This does not grant record viewing. Policy:{" "}
                {p.policy_version}.
              </p>
              {p.can_respond && (
                <div className="hp-form-actions">
                  <button
                    className="hp-button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await careApi("/proxies/" + p.id + "/accept", "POST", {});
                        success("Proxy appointment accepted.");
                      })
                    }
                  >
                    Accept appointment
                  </button>
                  <button
                    className="hp-button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await careApi("/proxies/" + p.id + "/decline", "POST", {});
                        success("Invitation declined.");
                      })
                    }
                  >
                    Decline invitation
                  </button>
                </div>
              )}
              {p.can_revoke && (
                <button
                  className="hp-text-button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await careApi("/proxies/" + p.id + "/revoke", "POST", {});
                      setRecords(null);
                      success("Proxy appointment and its emergency access revoked.");
                    })
                  }
                >
                  Revoke appointment and access
                </button>
              )}
            </article>
          ))
        )}
      </section>
      {!patient && canRequest && (
        <section className="hp-panel hp-proxy-panel">
          <h2>Request emergency access</h2>
          <p>
            For a patient who cannot consent where waiting could jeopardise care. Access is
            read-only, limited to the named requester and expires one hour after approval.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setOptions(null);
                setProxy("");
                setRequestedScopes([]);
                setRequestedProfile(false);
                const result = await careApi<Options>(
                  "/emergency/options?healthpass_id=" + encodeURIComponent(healthpassId),
                );
                setOptions(result);
              });
            }}
          >
            <label>
              Patient HealthPass ID
              <input
                value={healthpassId}
                onChange={(e) => {
                  setHealthpassId(e.target.value);
                  setOptions(null);
                }}
                placeholder="HP-…"
                required
              />
            </label>
            <button className="hp-button secondary" disabled={busy}>
              Find appointed proxies
            </button>
          </form>
          {options && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await careApi("/emergency", "POST", {
                    appointment_id: proxy,
                    scopes: requestedScopes,
                    include_profile: requestedProfile,
                    reason,
                    patient_unable_to_consent: unable,
                  });
                  setOptions(null);
                  setReason("");
                  setUnable(false);
                  success("Emergency request sent to the proxy.");
                });
              }}
            >
              <p>
                <strong>{options.patient.name}</strong> · {options.patient.healthpass_id}
              </p>
              <label>
                Appointed proxy
                <select
                  aria-label="Appointed proxy"
                  required
                  value={proxy}
                  onChange={(e) => {
                    setProxy(e.target.value);
                    setRequestedScopes([]);
                    setRequestedProfile(false);
                  }}
                >
                  <option value="">Choose proxy</option>
                  {options.proxies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {chosen && (
                <>
                  <ScopeChoices
                    values={requestedScopes}
                    onChange={setRequestedScopes}
                    available={chosen.scopes}
                    disabled={busy}
                  />
                  {chosen.include_profile && (
                    <label className="hp-choice">
                      <input
                        type="checkbox"
                        checked={requestedProfile}
                        onChange={(e) => setRequestedProfile(e.target.checked)}
                      />
                      <span>Include allergy summary</span>
                    </label>
                  )}
                </>
              )}
              <label>
                Why is emergency access necessary?
                <textarea
                  required
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label className="hp-choice">
                <input
                  type="checkbox"
                  checked={unable}
                  onChange={(e) => setUnable(e.target.checked)}
                  required
                />
                <span>The patient cannot consent and waiting could jeopardise care.</span>
              </label>
              <button
                className="hp-button"
                disabled={busy || !proxy || !requestedScopes.length || !unable}
              >
                Send emergency request
              </button>
            </form>
          )}
        </section>
      )}
      {!patient && !canRequest && (
        <p className="hp-fine">
          Clinical emergency requests require reviewed clinical authority and the “Request temporary
          emergency record access” permission. Facility proxy responders need the separate approval
          permission.
        </p>
      )}
      <section className="hp-panel hp-proxy-panel">
        <h2>Emergency requests</h2>
        {requests.isPending ? (
          <p>Loading requests…</p>
        ) : !requests.data?.requests.length ? (
          <p>No emergency requests.</p>
        ) : (
          requests.data.requests.map((r) => (
            <article key={r.id} className="hp-proxy-item">
              <h3>{r.patient_name}</h3>
              <p>
                {r.requester_name} · {r.facility_name}
                {r.branch_name ? " · " + r.branch_name : ""}
              </p>
              <p>
                <strong>{r.status}</strong> · Requested {date(r.created_at)}
              </p>
              <p>{r.reason}</p>
              <p>
                {r.scopes.map((s) => labels[s]).join(", ")}
                {r.include_profile ? " · Allergy summary" : ""}
              </p>
              {r.decided_at && (
                <p>
                  {r.decision_by_name} · {date(r.decided_at)}
                  <br />
                  {r.decision_reason}
                </p>
              )}
              <p className="hp-fine">
                {r.access_until
                  ? "Access ends " + date(r.access_until)
                  : "Request expires " + date(r.expires_at)}
                {!r.effective ? " · Proxy authority is no longer active." : ""}
              </p>
              <div className="hp-form-actions">
                {r.can_respond &&
                  ["approve", "decline"].map((action) => (
                    <button
                      key={action}
                      className={"hp-button " + (action === "decline" ? "secondary" : "")}
                      disabled={busy}
                      onClick={() => {
                        setDecision({ request: r, action });
                        setDecisionReason("");
                      }}
                    >
                      {action === "approve" ? "Approve for one hour" : "Decline"}
                    </button>
                  ))}
                {r.can_cancel && (
                  <button
                    className="hp-button secondary"
                    disabled={busy}
                    onClick={() => {
                      setDecision({ request: r, action: "cancel" });
                      setDecisionReason("");
                    }}
                  >
                    Cancel request / access
                  </button>
                )}
                {r.can_read && (
                  <button
                    className="hp-button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setRecords(await careApi<Records>("/emergency/" + r.id + "/records"));
                      })
                    }
                  >
                    View approved records
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </section>
      {patient && (
        <section className="hp-panel hp-proxy-panel">
          <h2>Emergency sharing history</h2>
          <p>
            Requests, decisions and record views are retained. Revoking access does not erase
            history.
          </p>
          {history.data?.events.map((e) => (
            <article key={e.id} className="hp-proxy-item">
              <h3>{e.action}</h3>
              <p>
                {e.actor_name}
                {e.facility_name ? " · " + e.facility_name : ""} · {date(e.created_at)}
              </p>
              <EventDetails details={e.details} />
              <details>
                <summary>Event reference</summary>
                <p className="hp-fine">{e.id}</p>
                <p className="hp-fine">Integrity fingerprint: {e.hash}</p>
              </details>
            </article>
          ))}
          {!history.data?.events.length && <p>No emergency sharing events yet.</p>}
          <div className="hp-form-actions">
            <button
              className="hp-button secondary"
              disabled={busy || !history.data?.events.length}
              onClick={() =>
                void run(async () => {
                  await careApi("/proxies/history/seen", "POST", {
                    event_ids: history.data?.events.map((e) => e.id),
                  });
                  success("Displayed updates marked as read.");
                })
              }
            >
              Mark displayed updates as read
            </button>
            {history.data?.nextBefore && (
              <button
                className="hp-button secondary"
                onClick={() => setBefore(history.data!.nextBefore!)}
              >
                Older events
              </button>
            )}
            {before && (
              <button className="hp-text-button" onClick={() => setBefore(undefined)}>
                Latest events
              </button>
            )}
          </div>
        </section>
      )}
      {invite && guide.data && (
        <Modal title="Appoint an emergency proxy" onClose={() => !busy && setInvite(false)}>
          <form
            className="hp-proxy-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await careApi("/proxies", "POST", {
                  kind,
                  email,
                  workspace_code: professional ? workspace : undefined,
                  scopes,
                  include_profile: profile,
                  accept_policy: accepted,
                  policy_version: guide.data!.policyVersion,
                });
                setInvite(false);
                success("Proxy invitation sent.");
              });
            }}
          >
            {error && (
              <p className="hp-error" role="alert">
                {error}
              </p>
            )}
            <label>
              Proxy type
              <select
                aria-label="Proxy type"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setAccepted(false);
                }}
              >
                <option value="person">An existing HealthPass user</option>
                <option value="facility" disabled={!guide.data.primary}>
                  My primary care facility
                  {guide.data.primary ? " — " + guide.data.primary.name : ""}
                </option>
              </select>
            </label>
            {kind === "person" && (
              <>
                <label>
                  Proxy’s account email
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="hp-choice">
                  <input
                    type="checkbox"
                    checked={professional}
                    onChange={(e) => setProfessional(e.target.checked)}
                  />
                  <span>This is a professional workspace account</span>
                </label>
                {professional && (
                  <label>
                    Their workspace code
                    <input
                      required
                      value={workspace}
                      onChange={(e) => setWorkspace(e.target.value)}
                      placeholder="HP-…"
                    />
                  </label>
                )}
                <p className="hp-fine">
                  Use the exact account they will sign in with. External email and SMS invitations
                  are not available yet.
                </p>
              </>
            )}
            <ScopeChoices
              values={scopes}
              onChange={setScopes}
              available={guide.data.categories}
              disabled={busy}
            />
            <label className="hp-choice">
              <input
                type="checkbox"
                checked={profile}
                onChange={(e) => setProfile(e.target.checked)}
              />
              <span>Allow the proxy to authorise sharing my allergy summary</span>
            </label>
            <section className="hp-notice">
              <h3>Emergency-sharing policy</h3>
              <p>{guide.data.policy}</p>
              <p className="hp-fine">{guide.data.policyVersion}</p>
            </section>
            <label className="hp-choice">
              <input
                type="checkbox"
                required
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span>
                I understand and accept this emergency-sharing authority, separately from ordinary
                sharing consent.
              </span>
            </label>
            <button className="hp-button" disabled={busy || !accepted || !scopes.length}>
              Send proxy invitation
            </button>
          </form>
        </Modal>
      )}
      {decision && (
        <Modal
          title={
            decision.action === "approve"
              ? "Approve emergency access"
              : decision.action === "decline"
                ? "Decline emergency access"
                : "Cancel emergency access"
          }
          onClose={() => !busy && setDecision(null)}
        >
          <form
            className="hp-proxy-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await careApi("/emergency/" + decision.request.id + "/" + decision.action, "POST", {
                  reason: decisionReason,
                });
                setDecision(null);
                setRecords(null);
                success("Emergency decision recorded.");
              });
            }}
          >
            {error && (
              <p className="hp-error" role="alert">
                {error}
              </p>
            )}
            <p>
              {decision.request.requester_name} · {decision.request.facility_name}
            </p>
            <p>
              {decision.request.scopes.map((s) => labels[s]).join(", ")}
              {decision.request.include_profile ? " · Allergy summary" : ""}
            </p>
            {decision.action === "approve" && (
              <p>
                Only this professional receives read-only access for one hour. You will not receive
                access to the patient’s records.
              </p>
            )}
            <label>
              Reason for this decision
              <textarea
                required
                maxLength={1000}
                value={decisionReason}
                onChange={(e) => setDecisionReason(e.target.value)}
              />
            </label>
            <button className="hp-button" disabled={busy || !decisionReason.trim()}>
              {decision.action === "approve"
                ? "Approve for one hour"
                : decision.action === "decline"
                  ? "Decline request"
                  : "Cancel request and access"}
            </button>
          </form>
        </Modal>
      )}
      {records && (
        <Modal title="Emergency records — read only" onClose={() => setRecords(null)}>
          <p>
            Access ends {date(records.accessUntil)}. No editing or onward delegation is granted.
          </p>
          {records.profile && (
            <section>
              <h3>Allergy summary</h3>
              <p>
                {records.profile.allergy_status} ·{" "}
                {records.profile.allergies || "No additional details recorded."}
              </p>
            </section>
          )}
          {!records.records.length && <p>No signed notes in the approved categories.</p>}
          {records.summaries.map((r) => (
            <article className="hp-proxy-item" key={r.id}>
              <h3>{r.title}</h3>
              <p>
                {r.author_name} · {r.facility_name} · {date(r.recorded_at)}
              </p>
              <dl>
                {r.fields.map((field, i) => (
                  <div key={i}>
                    <dt>
                      <strong>{field.label}</strong>
                    </dt>
                    <dd className="hp-record-text">{field.value}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
          {records.records.map((r) => (
            <article className="hp-proxy-item" key={r.version_id}>
              <h3>{labels[r.note_kind] || "Clinical note"}</h3>
              <p>
                {r.author_name} · {r.facility_name} · {date(r.signed_at)}
              </p>
              {["complaint", "history", "findings", "assessment", "plan"].map((field) =>
                typeof r.payload[field] === "string" && r.payload[field] ? (
                  <section key={field}>
                    <h4>{field[0].toUpperCase() + field.slice(1)}</h4>
                    <p className="hp-record-text">{String(r.payload[field])}</p>
                  </section>
                ) : null,
              )}
            </article>
          ))}
        </Modal>
      )}
    </section>
  );
}
function EventDetails({ details }: { details: string }) {
  const value = JSON.parse(details) as {
    reason?: string;
    scopes?: string[];
    access_until?: string;
    version_ids?: string[];
    structured_record_ids?: string[];
    include_profile?: boolean;
  };
  return (
    <>
      {value.reason && <p>{value.reason}</p>}
      {value.scopes && (
        <p>
          {value.scopes.map((s) => labels[s] || s).join(", ")}
          {value.include_profile ? " · Allergy summary" : ""}
        </p>
      )}
      {value.access_until && <p>Access ends {date(value.access_until)}</p>}
      {value.version_ids && (
        <p>
          {value.version_ids.length} signed note versions and{" "}
          {value.structured_record_ids?.length ?? 0} structured records viewed.
        </p>
      )}
    </>
  );
}
