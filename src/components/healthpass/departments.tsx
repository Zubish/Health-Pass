import { useCallback, useEffect, useRef, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import { date, type Me } from "@/lib/healthpass-types";
import { Empty, Modal } from "./primitives";
type Department = "laboratory" | "radiology" | "pharmacy";
const actionLabels: Record<string, string> = {
  accept: "Accept request",
  start: "Start service",
  report: "Sign report",
  release: "Release outcome",
  decline: "Decline request",
  cancel: "Cancel request",
  amend: "Amend report",
  acknowledge: "Record clinical review",
  clarify: "Request clarification",
  respond: "Respond to department",
  schedule: "Schedule service",
  complete: "Complete examination",
  "take-report": "Take for interpretation",
};
const names: Record<Department, string> = {
  laboratory: "Laboratory",
  radiology: "Radiology",
  pharmacy: "Pharmacy",
};
type Report = {
  id: string;
  report: string;
  author_name: string;
  signed_at: string;
  amendment_reason: string;
  details: string;
};
type Order = {
  id: string;
  patient_id: string;
  patient_name: string;
  facility_name: string;
  requested_by_name: string;
  assigned_to_name: string | null;
  healthpass_id: string;
  department: Department;
  service: string;
  indication: string;
  priority: string;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  prescription: {
    medicine: string;
    dose: string;
    route: string;
    frequency: string;
    instructions: string;
    status: string;
    starts_at: string;
    ends_at: string;
  } | null;
  allergy_context: { status: string; details: string } | null;
  can_take_report: boolean;
  can_report: boolean;
  can_work: boolean;
  can_release: boolean;
  can_cancel: boolean;
  can_acknowledge: boolean;
  reports: Report[];
  events: {
    id?: string;
    action: string;
    reason?: string;
    created_at: string;
    actor_name?: string;
    payload: string;
  }[];
};
export function Departments({ me, patientId }: { me: Me; patientId?: string }) {
  const patient = me.role === "patient",
    can = (p: string) => me.permissions?.includes(p) ?? false;
  const generation = useRef(0);
  const [requestDepartment, setRequestDepartment] = useState<Department>(
    can("diagnostics.order") ? "laboratory" : "pharmacy",
  );
  const [department, setDepartment] = useState(""),
    [orders, setOrders] = useState<Order[]>([]),
    [next, setNext] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [creating, setCreating] = useState(false),
    [action, setAction] = useState<{ order: Order; kind: string } | null>(null),
    [key, setKey] = useState("");
  const [medications, setMedications] = useState<
    { id: string; medicine: string; dose: string; status: string }[]
  >([]);
  const load = useCallback(
    async (before?: string) => {
      const current = ++generation.current;
      setLoading(true);
      try {
        const q = new URLSearchParams();
        if (patientId) q.set("patient_id", patientId);
        if (department) q.set("department", department);
        if (before) q.set("before", before);
        const data = await careApi<{ orders: Order[]; next: string | null }>("/departments?" + q);
        if (current !== generation.current) return;
        setOrders((old) => (before ? [...old, ...data.orders] : data.orders));
        setNext(data.next);
        setError("");
      } catch (e) {
        if (current === generation.current) setError((e as Error).message);
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [patientId, department],
  );
  useEffect(() => {
    setOrders([]);
    void load();
    return () => {
      // Invalidate pending fetches; this ref is a request counter, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
    };
  }, [load]);
  async function openRequest() {
    setError("");
    setKey(crypto.randomUUID());
    if (can("prescriptions.create") && patientId) {
      try {
        const data = await careApi("/treatment/patients/" + patientId);
        setMedications(data.orders.filter((m: { status: string }) => m.status === "active"));
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    setCreating(true);
  }
  async function submit(form: HTMLFormElement) {
    setBusy(true);
    setError("");
    const f = Object.fromEntries(new FormData(form));
    try {
      if (creating) {
        await careApi("/departments/orders", "POST", {
          ...f,
          patient_id: patientId,
          priority: f.priority || "routine",
          client_request_id: key,
        });
      } else if (action) {
        await careApi(`/departments/orders/${action.order.id}/${action.kind}`, "POST", {
          ...f,
          version: action.order.version,
          client_request_id: key,
          confirmed: f.confirmed === "on",
          critical: f.critical === "on",
          ...(f.quantity ? { quantity: Number(f.quantity) } : {}),
          ...(f.scheduled_at
            ? { scheduled_at: new Date(String(f.scheduled_at)).toISOString() }
            : {}),
        });
      }
      setCreating(false);
      setAction(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const startAction = (order: Order, kind: string) => {
    setError("");
    setKey(crypto.randomUUID());
    setAction({ order, kind });
  };
  return (
    <section className="hp-panel hp-departments">
      <div className="hp-panel-heading">
        <div>
          <h2>{patient ? "Tests, imaging & medicines" : "Department work"}</h2>
          <p>
            {patient
              ? "Released reports and pharmacy progress from your care facilities."
              : "Manage laboratory, imaging and pharmacy requests."}
          </p>
        </div>
        {patientId && !patient && (can("diagnostics.order") || can("prescriptions.create")) && (
          <button className="hp-button primary" onClick={() => void openRequest()}>
            Request department care
          </button>
        )}
      </div>
      <div className="hp-department-toolbar">
        <label>
          Department
          <select value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">All departments</option>
            {Object.entries(names).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button className="hp-button secondary" disabled={loading} onClick={() => void load()}>
          Refresh worklist
        </button>
      </div>
      {error && !creating && !action && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Loading department work…</p>}
      {!loading && !orders.length && !error && (
        <Empty
          title="No department requests"
          text={
            patient
              ? "Requests and released reports will appear here when your care team adds them."
              : patientId
                ? "Request a test, imaging study or pharmacy review for this patient."
                : "Open a patient’s record to create a request."
          }
        />
      )}
      {orders.map((order) => (
        <article className="hp-department-order" key={order.id}>
          <div className="hp-panel-heading">
            <div>
              <span className="hp-chip blue">{names[order.department]}</span>
              <h3>{order.service}</h3>
              <p>
                {order.patient_name} · {order.healthpass_id}
              </p>
            </div>
            <span className="hp-chip">
              {order.status.replaceAll("-", " ")}
              {order.priority === "urgent" ? " · Urgent" : ""}
            </span>
          </div>
          <p>
            {order.facility_name} · Requested by {order.requested_by_name}
            {order.assigned_to_name
              ? ` · Assigned to ${order.assigned_to_name}`
              : " · Awaiting acceptance"}
          </p>
          <p>
            <strong>Clinical reason:</strong> {order.indication}
          </p>
          <p className="hp-muted">
            Requested {date(order.created_at)} · Updated {date(order.updated_at)}
          </p>
          {order.prescription && (
            <div className="hp-department-report">
              <strong>Signed prescription</strong>
              <p>
                {order.prescription.medicine} · {order.prescription.dose} ·{" "}
                {order.prescription.route} · {order.prescription.frequency}
              </p>
              <p>{order.prescription.instructions}</p>
              <p>
                {order.prescription.status} · {date(order.prescription.starts_at)} to{" "}
                {date(order.prescription.ends_at)}
              </p>
              {order.allergy_context ? (
                <p>
                  Allergies ({order.allergy_context.status}):{" "}
                  {order.allergy_context.details || "No details recorded"}
                </p>
              ) : (
                <p>
                  Allergy profile is not shared. Obtain the required clinical information before
                  supply.
                </p>
              )}
            </div>
          )}
          {order.reports.map((report) => (
            <div className="hp-department-report" key={report.id}>
              <strong>{report.amendment_reason ? "Amended report" : "Signed report"}</strong>
              <p style={{ whiteSpace: "pre-wrap" }}>{report.report}</p>
              {JSON.parse(report.details).critical && (
                <p role="note">
                  <strong>Critical finding:</strong>{" "}
                  {JSON.parse(report.details).critical_communication}
                </p>
              )}
              {report.amendment_reason && <p>Amendment reason: {report.amendment_reason}</p>}
              <p className="hp-muted">
                {report.author_name} · {date(report.signed_at)}
              </p>
            </div>
          ))}
          {patient && order.status !== "released" && (
            <p>The report will appear after release by the department.</p>
          )}
          {!patient && (
            <div className="hp-department-actions">
              {order.can_work && order.status === "requested" && (
                <button className="hp-button primary" onClick={() => startAction(order, "accept")}>
                  Accept request
                </button>
              )}
              {order.can_work && ["requested", "accepted"].includes(order.status) && (
                <button
                  className="hp-button secondary"
                  onClick={() => startAction(order, "decline")}
                >
                  Decline with reason
                </button>
              )}
              {order.can_work && order.status === "accepted" && (
                <button
                  className="hp-button secondary"
                  onClick={() => startAction(order, "schedule")}
                >
                  Schedule service
                </button>
              )}
              {order.can_work && order.status === "accepted" && (
                <button className="hp-button primary" onClick={() => startAction(order, "start")}>
                  {order.department === "laboratory"
                    ? "Record collection"
                    : order.department === "radiology"
                      ? "Start examination"
                      : "Start medication review"}
                </button>
              )}
              {order.can_work && ["accepted", "in-progress"].includes(order.status) && (
                <button
                  className="hp-button secondary"
                  onClick={() => startAction(order, "clarify")}
                >
                  Request clarification
                </button>
              )}
              {order.can_work &&
                order.department === "radiology" &&
                order.status === "in-progress" && (
                  <button
                    className="hp-button primary"
                    onClick={() => startAction(order, "complete")}
                  >
                    Complete examination
                  </button>
                )}
              {order.can_take_report && (
                <button
                  className="hp-button secondary"
                  onClick={() => startAction(order, "take-report")}
                >
                  Take for interpretation
                </button>
              )}
              {order.can_report &&
                (order.department === "radiology"
                  ? order.status === "awaiting-report"
                  : order.status === "in-progress") && (
                  <button
                    className="hp-button primary"
                    onClick={() => startAction(order, "report")}
                  >
                    {order.department === "pharmacy" ? "Sign pharmacy review" : "Sign report"}
                  </button>
                )}
              {order.can_release && order.status === "reported" && (
                <button className="hp-button primary" onClick={() => startAction(order, "release")}>
                  {order.department === "pharmacy" ? "Record supply & release" : "Release report"}
                </button>
              )}
              {order.can_report && ["reported", "released"].includes(order.status) && (
                <button className="hp-button secondary" onClick={() => startAction(order, "amend")}>
                  Amend report
                </button>
              )}
              {order.can_cancel && ["accepted", "in-progress"].includes(order.status) && (
                <button
                  className="hp-button secondary"
                  onClick={() => startAction(order, "respond")}
                >
                  Respond to department
                </button>
              )}
              {order.can_cancel && ["requested", "accepted"].includes(order.status) && (
                <button
                  className="hp-button secondary"
                  onClick={() => startAction(order, "cancel")}
                >
                  Cancel request
                </button>
              )}
              {order.can_acknowledge && order.status === "released" && (
                <button
                  className="hp-button secondary"
                  onClick={() => startAction(order, "acknowledge")}
                >
                  Record clinical review
                </button>
              )}
            </div>
          )}
          <details>
            <summary>Action history</summary>
            {order.events.map((event, index) => (
              <p key={event.id || index}>
                <strong>{event.action}</strong> · {date(event.created_at)}{" "}
                {event.actor_name && `· ${event.actor_name}`}
                {event.reason && ` — ${event.reason}`}
                {JSON.parse(event.payload || "{}").scheduled_at &&
                  ` · Scheduled ${date(JSON.parse(event.payload).scheduled_at)}`}
                {JSON.parse(event.payload || "{}").quantity &&
                  ` · Supplied ${JSON.parse(event.payload).quantity} ${JSON.parse(event.payload).unit} · ${JSON.parse(event.payload).reference}`}
              </p>
            ))}
          </details>
        </article>
      ))}
      {next && (
        <button className="hp-button secondary" disabled={loading} onClick={() => void load(next)}>
          Load more requests
        </button>
      )}
      {(creating || action) && (
        <Modal
          title={
            creating
              ? "Request department care"
              : `${actionLabels[action!.kind]} · ${action?.order.service}`
          }
          onClose={() => {
            if (!busy) {
              setCreating(false);
              setAction(null);
            }
          }}
        >
          <form
            className="hp-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(e.currentTarget);
            }}
          >
            {creating ? (
              <>
                <label>
                  Department
                  <select
                    name="department"
                    value={requestDepartment}
                    onChange={(e) => setRequestDepartment(e.target.value as Department)}
                    required
                  >
                    {can("diagnostics.order") && (
                      <>
                        <option value="laboratory">Laboratory</option>
                        <option value="radiology">Radiology</option>
                      </>
                    )}
                    {can("prescriptions.create") && <option value="pharmacy">Pharmacy</option>}
                  </select>
                </label>
                {requestDepartment !== "pharmacy" && (
                  <label>
                    Test or imaging study
                    <input
                      name="service"
                      maxLength={200}
                      required
                      placeholder="Enter the requested investigation"
                    />
                  </label>
                )}
                {requestDepartment === "pharmacy" && can("prescriptions.create") && (
                  <label>
                    Prescription for pharmacy review
                    <select name="medication_order_id" required>
                      <option value="">Choose when requesting pharmacy care</option>
                      {medications.map((m) => (
                        <option value={m.id} key={m.id}>
                          {m.medicine} · {m.dose}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Clinical reason
                  <textarea name="indication" maxLength={2000} required />
                </label>
                <label>
                  Priority
                  <select name="priority">
                    <option value="routine">Routine</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </label>
              </>
            ) : (
              <>
                <p>
                  {action?.order.patient_name} · {names[action!.order.department]}
                </p>
                {action?.kind === "schedule" && (
                  <label>
                    Service date and time
                    <input type="datetime-local" name="scheduled_at" required />
                  </label>
                )}
                {["start", "report", "amend"].includes(action!.kind) && (
                  <label>
                    {action?.order.department === "laboratory"
                      ? "Specimen / method reference"
                      : action?.order.department === "radiology"
                        ? "Examination / modality reference"
                        : "Medication review reference"}
                    <input name="reference" maxLength={500} required />
                  </label>
                )}
                {["report", "amend"].includes(action!.kind) && (
                  <>
                    <label>
                      {action?.order.department === "pharmacy"
                        ? "Medication review and counselling plan"
                        : "Findings, measurements, units and interpretation"}
                      <textarea name="report" rows={7} maxLength={12000} required />
                    </label>
                    <label className="hp-department-check">
                      <input type="checkbox" name="critical" />
                      Critical finding
                    </label>
                    <label>
                      Critical finding communication
                      <textarea
                        name="critical_communication"
                        placeholder="Who was contacted, when, and the agreed escalation"
                        maxLength={2000}
                      />
                    </label>
                    <label className="hp-department-check">
                      <input type="checkbox" name="confirmed" required />I confirm this report is
                      complete and ready to sign.
                    </label>
                  </>
                )}
                {action?.kind === "release" &&
                  action.order.department === "pharmacy" &&
                  !action.order.events.some((e) => e.action === "release") && (
                    <>
                      <p>
                        Record actual supply using the dispensing record. Inventory and sales remain
                        in RxLedger.
                      </p>
                      <label>
                        Quantity supplied
                        <input
                          name="quantity"
                          type="number"
                          min="0.001"
                          max="100000"
                          step="any"
                          required
                        />
                      </label>
                      <label>
                        Unit
                        <input name="unit" placeholder="e.g. tablets" maxLength={60} required />
                      </label>
                      <label>
                        Dispensing reference
                        <input name="reference" maxLength={300} required />
                      </label>
                      <label>
                        Counselling / instructions
                        <textarea name="counselling" maxLength={3000} required />
                      </label>
                    </>
                  )}
                <label>
                  {["decline", "cancel", "amend", "clarify"].includes(action!.kind)
                    ? "Reason"
                    : "Observations / clinical review"}
                  <textarea
                    name="reason"
                    maxLength={3000}
                    required={[
                      "decline",
                      "cancel",
                      "amend",
                      "clarify",
                      "acknowledge",
                      "respond",
                      "complete",
                    ].includes(action!.kind)}
                  />
                </label>
              </>
            )}
            {error && (
              <p className="hp-error" role="alert">
                {error}
              </p>
            )}
            <button className="hp-button primary" disabled={busy}>
              {busy
                ? "Saving…"
                : creating
                  ? "Send request"
                  : action?.kind === "report"
                    ? "Sign report"
                    : action?.kind === "decline"
                      ? "Decline request"
                      : "Confirm"}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
