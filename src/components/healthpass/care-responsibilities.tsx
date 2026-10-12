import { useCallback, useEffect, useRef, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import { date, type Me } from "@/lib/healthpass-types";
import { Empty, Modal } from "./primitives";
type Responsibility = {
  id: string;
  version: number;
  status: string;
  patient_id: string;
  patient_name: string;
  healthpass_id: string;
  consultant_id: string;
  consultant_name: string;
  facility_name: string;
  branch_id: string;
  branch_name: string;
  service: string;
  ward: string;
  care_setting: string;
  access_available: boolean;
  history: {
    id: string;
    action: string;
    reason: string;
    created_at: string;
    actor_name: string;
    consultant_name: string;
    service: string;
    ward: string;
  }[];
};
type Options = {
  branches: { id: string; name: string }[];
  patients: { id: string; name: string; healthpass_id: string; branch_id: string }[];
  consultants: { id: string; name: string; branch_id: string | null; role_names: string[] }[];
};
export function CareResponsibilities({ me }: { me: Me }) {
  const patient = me.role === "patient",
    manager = me.permissions?.includes("careteam.manage") ?? false;
  const [rows, setRows] = useState<Responsibility[]>([]),
    [options, setOptions] = useState<Options | null>(null),
    [editing, setEditing] = useState<Responsibility | "new" | null>(null),
    [ending, setEnding] = useState<Responsibility | null>(null),
    [branch, setBranch] = useState(me.branch?.id ?? ""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [hasMore, setHasMore] = useState(false),
    [nextOffset, setNextOffset] = useState(0);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const refresh = useCallback(async () => {
    const [roster, directory] = await Promise.all([
      careApi("/care-responsibilities"),
      manager ? careApi("/care-responsibilities/options") : Promise.resolve(null),
    ]);
    setRows(roster.responsibilities);
    setHasMore(roster.has_more);
    setNextOffset(roster.next_offset);
    if (directory) setOptions(directory);
  }, [manager]);
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [refresh]);
  async function change(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
      setEditing(null);
      setEnding(null);
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = rows.filter((row) =>
    (
      row.patient_name +
      " " +
      row.healthpass_id +
      " " +
      row.consultant_name +
      " " +
      row.service +
      " " +
      row.ward
    )
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const activeBranch = typeof editing === "object" && editing ? editing.branch_id : branch;
  return (
    <>
      <div className="hp-heading">
        <div>
          <span className="hp-eyebrow">ACCOUNTABLE CARE</span>
          <h1>{patient ? "My care team" : "Care responsibility"}</h1>
          <p>
            {patient
              ? "See the consultant responsible for your ongoing care at each facility."
              : "A lead consultant remains responsible for overall management while authorised colleagues provide day-to-day care."}
          </p>
        </div>
        <div className="hp-responsibility-actions">
          <button
            className="hp-button secondary"
            disabled={busy || loading}
            onClick={() => void change(refresh, "Responsibilities refreshed.")}
          >
            Refresh
          </button>
          {manager && (
            <button
              className="hp-button primary"
              disabled={busy || !options}
              onClick={() => {
                setError("");
                retry.current = null;
                setBranch(me.branch?.id ?? options?.branches[0]?.id ?? "");
                setEditing("new");
              }}
            >
              Assign responsible consultant
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="hp-notice" role="status">
          {notice}
        </p>
      )}
      <div className="hp-notice">
        <p>
          Individual visits keep their assigned professional. Consultant responsibility does not
          change patient sharing permissions or ownership of signed records.
        </p>
      </div>
      {loading && <p role="status">Loading care responsibilities…</p>}
      {!loading && (
        <>
          <div className="hp-search">
            <input
              aria-label="Search care responsibilities"
              placeholder="Patient, consultant, service or ward"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {!filtered.length && (
            <Empty
              title="No care responsibilities to show"
              text={
                patient
                  ? "Your facility will assign a lead consultant when needed."
                  : "Register the patient at this branch and assign an appropriately reviewed consultant."
              }
            />
          )}
          <div className="hp-responsibility-grid">
            {filtered.map((row) => (
              <section className="hp-panel hp-padded" key={row.id}>
                <div className="hp-panel-heading">
                  <div>
                    <h2>{row.patient_name}</h2>
                    <p>
                      {row.healthpass_id} · {row.facility_name}
                    </p>
                  </div>
                  <span className={`hp-chip ${row.status === "active" ? "teal" : "neutral"}`}>
                    {row.status === "active" ? "Active responsibility" : "Ended"}
                  </span>
                </div>
                <dl className="hp-responsibility-details">
                  <dt>Responsible consultant</dt>
                  <dd>
                    <strong>{row.consultant_name}</strong>
                  </dd>
                  <dt>Service</dt>
                  <dd>{row.service}</dd>
                  <dt>Care setting</dt>
                  <dd>{row.care_setting === "inpatient" ? "Inpatient care" : "Ongoing care"}</dd>
                  <dt>Branch / ward</dt>
                  <dd>
                    {row.branch_name}
                    {row.ward ? " · " + row.ward : ""}
                  </dd>
                </dl>
                {row.status === "active" && !row.access_available && (
                  <p className="hp-error">
                    The consultant’s record access is currently unavailable. Reviewed roles and
                    patient permission must be restored, or the administrator must reassign
                    responsibility.
                  </p>
                )}
                {manager && row.status === "active" && (
                  <div className="hp-responsibility-actions">
                    <button
                      className="hp-button secondary"
                      disabled={busy}
                      onClick={() => {
                        setError("");
                        setEditing(row);
                      }}
                    >
                      Update or reassign
                    </button>
                    <button
                      className="hp-text-button"
                      disabled={busy}
                      onClick={() => {
                        setError("");
                        setEnding(row);
                      }}
                    >
                      End responsibility
                    </button>
                  </div>
                )}
                <details className="hp-responsibility-history">
                  <summary>Responsibility history</summary>
                  {row.history.map((event) => (
                    <div key={event.id}>
                      <strong>
                        {event.action === "assigned"
                          ? "Assigned"
                          : event.action === "ended"
                            ? "Ended"
                            : "Updated / reassigned"}{" "}
                        · {event.consultant_name}
                      </strong>
                      <p>
                        {event.service}
                        {event.ward ? " · " + event.ward : ""}
                      </p>
                      <p>{event.reason}</p>
                      <small>
                        {event.actor_name} · {date(event.created_at)}
                      </small>
                    </div>
                  ))}
                </details>
              </section>
            ))}
          </div>
          <p className="hp-muted">
            Showing the most recent {rows.length} responsibility records in your permitted scope.
          </p>
          {hasMore && (
            <button
              className="hp-button secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const page = await careApi(`/care-responsibilities?offset=${nextOffset}`);
                  setRows((current) => [
                    ...current,
                    ...page.responsibilities.filter(
                      (row: Responsibility) => !current.some((existing) => existing.id === row.id),
                    ),
                  ]);
                  setHasMore(page.has_more);
                  setNextOffset(page.next_offset);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Load more responsibilities
            </button>
          )}
        </>
      )}
      {editing && options && (
        <Modal
          title={editing === "new" ? "Assign responsible consultant" : "Update care responsibility"}
          onClose={() => {
            if (!busy) setEditing(null);
          }}
        >
          {error && (
            <p className="hp-error" role="alert">
              {error}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget),
                values = {
                  ...Object.fromEntries(form),
                  specialty_confirmed: form.get("specialty_confirmed") === "on",
                };
              if (editing === "new") {
                const payload = JSON.stringify(values);
                if (!retry.current || retry.current.payload !== payload)
                  retry.current = { payload, key: crypto.randomUUID() };
                void change(
                  () =>
                    careApi("/care-responsibilities", "POST", {
                      ...values,
                      client_request_id: retry.current!.key,
                    }),
                  "Consultant assigned. Individual visit assignments and sharing permissions are unchanged.",
                );
              } else {
                void change(
                  () =>
                    careApi(`/care-responsibilities/${editing.id}`, "PATCH", {
                      ...values,
                      version: editing.version,
                      action: "reassign",
                    }),
                  "Care responsibility updated; its history is preserved.",
                );
              }
            }}
          >
            {editing === "new" ? (
              <>
                <label>
                  Branch
                  <select
                    name="branch_id"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    required
                    disabled={!!me.branch}
                  >
                    <option value="">Choose a branch</option>
                    {options.branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                  {me.branch && <input type="hidden" name="branch_id" value={me.branch.id} />}
                </label>
                <label>
                  Registered patient
                  <select name="patient_id" required key={branch}>
                    <option value="">Choose a patient</option>
                    {options.patients
                      .filter((p) => p.branch_id === branch)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.healthpass_id}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            ) : (
              <p className="hp-notice">
                {editing.patient_name} · {editing.branch_name}
                <br />
                Current lead: {editing.consultant_name}
              </p>
            )}
            <label>
              Responsible consultant
              <select
                name="consultant_id"
                required
                defaultValue={editing === "new" ? "" : editing.consultant_id}
                key={activeBranch}
              >
                <option value="">Choose a reviewed professional</option>
                {options.consultants
                  .filter((c) => !c.branch_id || c.branch_id === activeBranch)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.role_names.join(", ")}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Consultant service
              <input
                name="service"
                required
                maxLength={80}
                placeholder="For example: Paediatrics"
                defaultValue={editing === "new" ? "" : editing.service}
              />
            </label>
            <label>
              Care setting
              <select
                name="care_setting"
                defaultValue={editing === "new" ? "inpatient" : editing.care_setting}
              >
                <option value="inpatient">Inpatient care</option>
                <option value="ongoing">Ongoing care</option>
              </select>
            </label>
            <label>
              Ward <small>Optional</small>
              <input
                name="ward"
                maxLength={100}
                defaultValue={editing === "new" ? "" : editing.ward}
              />
            </label>
            <label>
              Specialty review reference
              <input
                name="specialty_review_reference"
                required
                maxLength={500}
                placeholder="Reference to reviewed credentials; no document numbers"
              />
            </label>
            <label className="hp-check-row">
              <input name="specialty_confirmed" type="checkbox" required />
              <span>
                I checked that the consultant’s reviewed credentials cover this service and the
                patient’s care. A job title alone does not establish specialty authority.
              </span>
            </label>
            {editing !== "new" && (
              <label>
                Reason for change
                <input
                  name="reason"
                  required
                  maxLength={500}
                  placeholder="Administrative reason; no clinical case details"
                />
              </label>
            )}
            <p className="hp-muted">
              The consultant must already have current patient permission to contribute. Other
              authorised GPs can continue care without replacing this lead.
            </p>
            <button className="hp-button primary" disabled={busy}>
              {busy
                ? "Saving…"
                : editing === "new"
                  ? "Assign consultant"
                  : "Save responsibility change"}
            </button>
          </form>
        </Modal>
      )}
      {ending && (
        <Modal
          title="End consultant responsibility"
          onClose={() => {
            if (!busy) setEnding(null);
          }}
        >
          {error && (
            <p className="hp-error" role="alert">
              {error}
            </p>
          )}
          <p>
            {ending.patient_name} · {ending.consultant_name}
          </p>
          <p>
            Ending responsibility preserves its history, signed records and individual visits.
            Confirm that ongoing management has been concluded or otherwise arranged.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void change(
                () =>
                  careApi(`/care-responsibilities/${ending.id}`, "PATCH", {
                    version: ending.version,
                    action: "end",
                    reason: data.get("reason"),
                  }),
                "Responsibility ended. Records, patient permissions and visit assignments are preserved.",
              );
            }}
          >
            <label>
              Reason
              <input name="reason" required maxLength={500} />
            </label>
            <button className="hp-button primary" disabled={busy}>
              {busy ? "Saving…" : "Confirm end of responsibility"}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}

export function PatientResponsibleConsultant({ patientId }: { patientId: string }) {
  const [rows, setRows] = useState<Responsibility[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setRows([]);
    setError("");
    void careApi(`/care-responsibilities?patient_id=${encodeURIComponent(patientId)}&status=active`)
      .then((data) => {
        if (current) setRows(data.responsibilities);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [patientId]);
  return (
    <div className="hp-responsibility-summary">
      <h3>Responsible consultant</h3>
      {error ? (
        <p className="hp-muted">{error}</p>
      ) : rows.length ? (
        rows.map((row) => (
          <div key={row.id}>
            <strong>{row.consultant_name}</strong>
            <p>
              {row.service} · {row.facility_name}
              {row.ward ? " · " + row.ward : ""}
            </p>
            {!row.access_available && <small>Record access currently unavailable</small>}
          </div>
        ))
      ) : (
        <p className="hp-muted">
          No active consultant responsibility recorded in your permitted scope.
        </p>
      )}
    </div>
  );
}
