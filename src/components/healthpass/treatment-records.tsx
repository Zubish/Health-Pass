import { useSuccessFeedback } from "@/lib/healthpass-preferences";
import { useCallback, useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import { date, type Me, type AccessScope } from "@/lib/healthpass-types";
import { Modal } from "./primitives";
type Administration = {
  id: string;
  author_name: string;
  due_at: string | null;
  administered_at: string;
  outcome: string;
  dose: string;
  reason: string;
  observations: string;
  created_at: string;
};
type Order = {
  id: string;
  admission_id: string | null;
  prescriber_name: string;
  facility_name: string;
  medicine: string;
  dose: string;
  route: string;
  frequency: string;
  interval_hours: number | null;
  prn: number;
  indication: string;
  instructions: string;
  starts_at: string;
  ends_at: string;
  status: string;
  version: number;
  created_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
  administrations: Administration[];
};
type Episode = {
  id: string;
  kind: string;
  status: string;
  area_name: string;
  created_at: string;
  ended_at: string | null;
};
type Observation = {
  id: string;
  admission_id: string | null;
  source?: string;
  discipline: string;
  values: Record<string, number>;
  observations: string;
  observed_at: string;
  created_at: string;
  author_name: string;
};
type Decision = {
  id: string;
  admission_id: string;
  kind: string;
  reason: string;
  observations: string;
  decided_at: string;
  created_at: string;
  physician_name: string;
};
type Data = {
  visitHistory: {
    id: string;
    action: string;
    reason: string;
    created_at: string;
    actor_name: string;
  }[];
  orders: Order[];
  episodes: Episode[];
  observations: Observation[];
  decisions: Decision[];
  scopes: string[];
  history: { id: string; action: string; actor_name: string; reason: string; created_at: string }[];
};
const vitals = [
  ["systolic", "Systolic BP", "mmHg"],
  ["diastolic", "Diastolic BP", "mmHg"],
  ["pulse", "Pulse", "bpm"],
  ["temperature", "Temperature", "°C"],
  ["spo2", "Oxygen saturation", "%"],
  ["respiratory_rate", "Respiratory rate", "/min"],
  ["weight", "Weight", "kg"],
] as const;
export function TreatmentRecords({
  me,
  patientId,
  accessScope,
}: {
  me: Me;
  patientId: string;
  accessScope: AccessScope;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const setNotice = useSuccessFeedback();
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{
    type: "admit" | "discharge" | "prescribe" | "observe" | "administer" | "stop";
    order?: Order;
    request: string;
  } | null>(null);
  const [outcome, setOutcome] = useState("given");
  const [prn, setPrn] = useState(false);
  const [episode, setEpisode] = useState("");
  const [metric, setMetric] = useState("temperature");
  const patient = me.role === "patient";
  const can = (key: string) =>
    !patient && !!accessScope.canContribute && !!me.permissions?.includes(key);
  const load = useCallback(
    async () => setData(await careApi<Data>(`/treatment/patients/${patientId}`)),
    [patientId],
  );
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  function open(type: NonNullable<typeof modal>["type"], order?: Order) {
    setError("");
    setOutcome("given");
    setPrn(false);
    setEpisode(order?.admission_id || data?.episodes.find((e) => e.status === "active")?.id || "");
    setModal({ type, order, request: crypto.randomUUID() });
  }
  const active = data?.episodes.filter((e) => e.status === "active") || [];
  function slots(order: Order) {
    if (!order.interval_hours) {
      return [];
    }
    const step = order.interval_hours * 3600000;
    const start = Date.parse(order.starts_at);
    const end = Math.min(Date.now() + 300000, Date.parse(order.ends_at) - 1);
    const first = Math.max(0, Math.ceil((end - 48 * 3600000 - start) / step));
    const result: string[] = [];
    for (let n = first; n <= Math.floor((end - start) / step) && result.length < 200; n++) {
      const due = new Date(start + n * step).toISOString();
      if (!order.administrations.some((a) => a.due_at === due)) {
        result.push(due);
      }
    }
    return result.reverse();
  }
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!modal) {
      return;
    }
    const f = new FormData(e.currentTarget);
    const fields = Object.fromEntries(f);
    const body: Record<string, unknown> = { ...fields, client_request_id: modal.request };
    for (const key of ["decided_at", "starts_at", "ends_at", "observed_at", "administered_at"]) {
      if (!fields[key]) {
        delete body[key];
      } else {
        body[key] = new Date(String(fields[key])).toISOString();
      }
    }
    let path = "";
    if (["admit", "discharge"].includes(modal.type)) {
      path = "decisions";
      body.kind = modal.type;
      body.admission_id = episode;
    }
    if (modal.type === "prescribe") {
      path = "orders";
      body.prn = prn;
      body.admission_id = episode || undefined;
      body.interval_hours = Number(fields.interval_hours);
    }
    if (modal.type === "observe") {
      path = "observations";
      body.admission_id = episode;
      body.values = Object.fromEntries(
        vitals.filter(([k]) => String(fields[k] || "").trim()).map(([k]) => [k, Number(fields[k])]),
      );
    }
    if (modal.type === "stop") {
      path = `orders/${modal.order?.id}/stop`;
      body.version = modal.order?.version;
    }
    if (modal.type === "administer") {
      path = `orders/${modal.order?.id}/administrations`;
      body.outcome = outcome;
    }
    setBusy(true);
    setError("");
    try {
      await careApi(`/treatment/patients/${patientId}/${path}`, "POST", body);
      setModal(null);
      setNotice("Treatment record saved with its author and timestamp.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const points = (data?.observations || [])
    .filter((o) => o.values[metric] !== undefined)
    .slice(0, 30)
    .reverse();
  const range = points.map((o) => o.values[metric]);
  const lo = Math.min(...range);
  const hi = Math.max(...range);
  return (
    <section className="hp-panel hp-treatment">
      <div className="hp-section-heading">
        <h2>Treatment & ward records</h2>
        <button
          className="hp-button secondary"
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          Refresh treatment
        </button>
      </div>
      {error && !modal && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}

      {data && (
        <>
          <div className="hp-actions">
            {can("admissions.decide") && active.length > 0 && (
              <>
                <button className="hp-button secondary" onClick={() => open("admit")}>
                  Record admission decision
                </button>
                <button className="hp-button secondary" onClick={() => open("discharge")}>
                  Record discharge decision
                </button>
              </>
            )}
            {can("prescriptions.create") && (
              <button className="hp-button primary" onClick={() => open("prescribe")}>
                Prescribe medication
              </button>
            )}
            {can("ward.observations") && active.length > 0 && (
              <button className="hp-button secondary" onClick={() => open("observe")}>
                Record ward observations
              </button>
            )}
          </div>
          <h3>Admission & discharge decisions</h3>
          {data.decisions.length ? (
            data.decisions.map((d) => (
              <div className="hp-grant" key={d.id}>
                <div>
                  <strong>
                    {d.kind === "admit" ? "Admitted by" : "Discharged by"} {d.physician_name}
                  </strong>
                  <p>{d.reason}</p>
                  {d.observations && <p>{d.observations}</p>}
                  <small>
                    Decision {date(d.decided_at)} · Recorded {date(d.created_at)}
                  </small>
                </div>
              </div>
            ))
          ) : (
            <p className="hp-muted">
              No physician decisions available under your current sharing access. An operational
              episode alone is not a clinical admission or discharge decision.
            </p>
          )}
          <h3>Prescriptions & inpatient medication chart</h3>
          {!data.scopes.includes("medication") && (
            <p className="hp-muted">Medication records require medication sharing access.</p>
          )}
          {data.orders.map((o) => (
            <article className="hp-grant" key={o.id}>
              <div>
                <strong>
                  {o.medicine} · {o.status}
                </strong>
                <p>
                  {o.dose} · {o.route} · {o.frequency}
                  {o.prn ? " · As needed" : ""}
                </p>
                <p>Indication: {o.indication}</p>
                {o.instructions && <p>{o.instructions}</p>}
                <small>
                  Prescribed by {o.prescriber_name} · {o.facility_name} · {date(o.created_at)}
                  <br />
                  Course {date(o.starts_at)} – {date(o.ends_at)}
                </small>
                {o.stop_reason && (
                  <p>
                    Stopped {date(o.stopped_at || "")} · {o.stop_reason}
                  </p>
                )}
                <div className="hp-actions">
                  {can("medication.administer") &&
                    o.admission_id &&
                    active.some((a) => a.id === o.admission_id) &&
                    o.status === "active" && (
                      <button className="hp-button secondary" onClick={() => open("administer", o)}>
                        Record dose outcome
                      </button>
                    )}
                  {can("prescriptions.create") && o.status === "active" && (
                    <button className="hp-button secondary" onClick={() => open("stop", o)}>
                      Stop prescription
                    </button>
                  )}
                </div>
                {!!o.admission_id && (
                  <details>
                    <summary>Medication administration chart ({o.administrations.length})</summary>
                    {o.administrations.map((a) => (
                      <div key={a.id}>
                        <strong>
                          {a.outcome} {a.dose}
                        </strong>
                        <p>
                          {a.author_name} · {date(a.administered_at)}
                          {a.due_at ? ` · Due ${date(a.due_at)}` : " · As needed"}
                        </p>
                        {a.reason && <p>Reason: {a.reason}</p>}
                        {a.observations && <p>{a.observations}</p>}
                        <small>Recorded {date(a.created_at)}</small>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            </article>
          ))}
          {!data.orders.length && <p className="hp-muted">No prescriptions available.</p>}
          <h3>Vital records & ward observations</h3>
          <label>
            Trend measurement
            <select value={metric} onChange={(e) => setMetric(e.target.value)}>
              {vitals.map(([k, label, unit]) => (
                <option key={k} value={k}>
                  {label} ({unit})
                </option>
              ))}
            </select>
          </label>
          {points.length > 1 && (
            <figure>
              <svg
                viewBox="0 0 400 100"
                role="img"
                aria-label={`${metric} trend: ${range.length} observations, minimum ${lo}, maximum ${hi}`}
                style={{ width: "100%", height: 100 }}
              >
                <polyline
                  fill="none"
                  stroke="#287c78"
                  strokeWidth="2"
                  points={points
                    .map(
                      (o, i) =>
                        `${10 + (i * 380) / (points.length - 1)},${90 - ((o.values[metric] - lo) * 80) / (hi - lo || 1)}`,
                    )
                    .join(" ")}
                />
              </svg>
              <figcaption>
                Recorded values {lo}–{hi}, {date(points[0].observed_at)} to{" "}
                {date(points[points.length - 1].observed_at)}. This is a record trend, not an
                interpretation.
              </figcaption>
            </figure>
          )}
          <div className="hp-treatment-table">
            <table>
              <thead>
                <tr>
                  <th>Measured / author</th>
                  {vitals.map(([k, label]) => (
                    <th key={k}>{label}</th>
                  ))}
                  <th>Observations</th>
                </tr>
              </thead>
              <tbody>
                {data.observations.map((o) => (
                  <tr key={o.id}>
                    <td>
                      {date(o.observed_at)}
                      <br />
                      {o.author_name} · {o.source === "visit" ? "Visit" : "Ward"}
                      <br />
                      <small>Recorded {date(o.created_at)}</small>
                    </td>
                    {vitals.map(([k]) => (
                      <td key={k}>{o.values[k] ?? "—"}</td>
                    ))}
                    <td>{o.observations || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.observations.length && <p className="hp-muted">No ward observations available.</p>}
          <details>
            <summary>Treatment history</summary>
            {data.visitHistory?.map((h) => (
              <p key={h.id}>
                {h.action.replaceAll(".", " · ")} · {h.actor_name} · {date(h.created_at)}
                {h.reason && (
                  <>
                    <br />
                    {h.reason}
                  </>
                )}
              </p>
            ))}
            {data.history.map((h) => (
              <p key={h.id}>
                {h.action.replaceAll(".", " · ")} · {h.actor_name} · {date(h.created_at)}
                <br />
                {h.reason}
              </p>
            ))}
          </details>
        </>
      )}
      {modal && (
        <Modal
          title={
            {
              admit: "Record physician admission",
              discharge: "Record physician discharge",
              prescribe: "Sign prescription",
              observe: "Record ward observations",
              administer: "Record dose outcome",
              stop: "Stop prescription",
            }[modal.type]
          }
          onClose={() => {
            if (!busy) {
              setModal(null);
            }
          }}
        >
          {error && (
            <p className="hp-error" role="alert">
              {error}
            </p>
          )}
          <form onSubmit={(e) => void save(e)}>
            {["admit", "discharge", "observe", "prescribe"].includes(modal.type) && (
              <label>
                Care episode
                <select
                  aria-label="Care episode"
                  required={modal.type !== "prescribe"}
                  value={episode}
                  onChange={(e) => setEpisode(e.target.value)}
                >
                  {modal.type === "prescribe" && <option value="">Outpatient prescription</option>}
                  {active.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.area_name} · {a.kind}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {["admit", "discharge", "stop"].includes(modal.type) && (
              <label>
                Reason
                <textarea name="reason" required maxLength={2000} />
              </label>
            )}
            {["admit", "discharge"].includes(modal.type) && (
              <>
                <label>
                  Decision time (leave blank for now)
                  <input type="datetime-local" name="decided_at" />
                </label>
                <label className="hp-choice">
                  <input type="checkbox" name="confirm_physician" value="confirmed" required />
                  <span>I am the physician making this clinical decision.</span>
                </label>
                <p className="hp-fine">
                  This records your clinical decision. The facility separately manages ward visits
                  and closes the operational episode.
                </p>
              </>
            )}
            {modal.type === "prescribe" && (
              <>
                <label>
                  Medicine, strength and formulation
                  <input name="medicine" required maxLength={200} />
                </label>
                <div className="hp-form-grid">
                  <label>
                    Dose
                    <input name="dose" required maxLength={120} placeholder="e.g. 500 mg" />
                  </label>
                  <label>
                    Route
                    <input name="route" required maxLength={80} placeholder="e.g. oral" />
                  </label>
                </div>
                <label>
                  Frequency
                  <input name="frequency" required maxLength={150} />
                </label>
                <label>
                  Indication
                  <input name="indication" required maxLength={500} />
                </label>
                <label className="hp-choice">
                  <input type="checkbox" checked={prn} onChange={(e) => setPrn(e.target.checked)} />
                  <span>As needed (PRN)</span>
                </label>
                {episode && !prn && (
                  <label>
                    Hours between scheduled doses
                    <input
                      name="interval_hours"
                      type="number"
                      step="0.25"
                      min="0.25"
                      max="168"
                      required
                    />
                  </label>
                )}
                <label>
                  Start time (leave blank for now)
                  <input name="starts_at" type="datetime-local" />
                </label>
                <label>
                  Course end
                  <input name="ends_at" type="datetime-local" required />
                </label>
                <label>
                  Instructions
                  <textarea name="instructions" maxLength={1000} />
                </label>
                <label className="hp-choice">
                  <input name="confirm_prescription" type="checkbox" value="confirmed" required />
                  <span>
                    I reviewed allergies, medication details and clinical suitability before
                    signing.
                  </span>
                </label>
                <p className="hp-fine">
                  This records a signed prescription. Automated interaction checking and dispensing
                  are separate services. Correct an order by stopping it with a reason and signing a
                  replacement.
                </p>
              </>
            )}
            {modal.type === "observe" && (
              <>
                <label>
                  Discipline
                  <select name="discipline" required>
                    {(me.clinicalScopes || [])
                      .filter((s) => ["general", "nursing"].includes(s))
                      .map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="hp-form-grid">
                  {vitals.map(([k, label, unit]) => (
                    <label key={k}>
                      {label} ({unit})<input name={k} type="number" step="any" />
                    </label>
                  ))}
                </div>
                <label>
                  Measurement time (leave blank for now)
                  <input name="observed_at" type="datetime-local" />
                </label>
              </>
            )}
            {modal.type === "administer" && modal.order && (
              <>
                <p>
                  <strong>{modal.order.medicine}</strong> · {modal.order.dose} · {modal.order.route}
                </p>
                {!modal.order.prn && (
                  <label>
                    Scheduled dose
                    <select name="due_at" aria-label="Scheduled dose" required>
                      <option value="">Choose a due dose</option>
                      {slots(modal.order).map((s) => (
                        <option key={s} value={s}>
                          {date(s)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Outcome
                  <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                    {["given", "omitted", "refused", "held"].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                {outcome === "given" && (
                  <label>
                    Actual dose
                    <input name="dose" required defaultValue={modal.order.dose} />
                  </label>
                )}
                <label>
                  Reason (required for PRN, changed doses or a dose not given)
                  <textarea
                    name="reason"
                    required={outcome !== "given" || !!modal.order.prn}
                    maxLength={1000}
                  />
                </label>
                <label>
                  Actual time (leave blank for now)
                  <input name="administered_at" type="datetime-local" />
                </label>
              </>
            )}
            {modal.type !== "stop" && modal.type !== "prescribe" && (
              <label>
                Observations / comments
                <textarea name="observations" maxLength={2000} />
              </label>
            )}
            <button className="hp-button primary" disabled={busy}>
              {busy ? "Saving…" : modal.type === "prescribe" ? "Sign prescription" : "Save record"}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
