import { useSuccessFeedback } from "@/lib/healthpass-preferences";
import { useCallback, useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import { date, type Me, type Patient } from "@/lib/healthpass-types";
import { Empty, Modal } from "./primitives";
type Referral = {
  id: string;
  version: number;
  patient_id: string;
  patient_name: string;
  healthpass_id: string;
  from_user_id: string;
  from_name: string;
  consultant_id: string;
  consultant_name: string;
  kind: "advice" | "transfer";
  status: string;
  scheduled_at: string | null;
  decline_reason: string | null;
  reason_hidden?: boolean;
  accepted_at?: string | null;
  visit_id: string | null;
  created_at: string;
};
type Choices = {
  sources: { id: string; version: number; complaint: string; visit_id: string | null }[];
  consultants: { id: string; name: string }[];
};
export function ConsultantReferrals({ me }: { me: Me }) {
  const patient = me.role === "patient";
  const canCreate = me.permissions?.includes("referrals.create") ?? false;
  const canRespond = me.permissions?.includes("referrals.respond") ?? false;
  const [rows, setRows] = useState<Referral[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState("");
  const [choices, setChoices] = useState<Choices>({ sources: [], consultants: [] });
  const [modal, setModal] = useState<{
    type: "new" | "accept" | "decline" | "withdraw" | "complete" | "cancel" | "reschedule";
    row?: Referral;
  } | null>(null);
  const [schedule, setSchedule] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setNotice = useSuccessFeedback();
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<
    Record<string, { source: Record<string, string>; version: number }>
  >({});
  const [responseNotes, setResponseNotes] = useState<{ id: string; complaint: string }[]>([]);
  const refresh = useCallback(async () => {
    const [list, directory] = await Promise.all([
      careApi("/consultant-referrals"),
      canCreate ? careApi("/patients") : Promise.resolve({ patients: [] }),
    ]);
    setRows(list.referrals);
    setPatients(directory.patients);
  }, [canCreate]);
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [refresh]);
  useEffect(() => {
    setChoices({ sources: [], consultants: [] });
    if (!selectedPatient) {
      return;
    }
    let current = true;
    void careApi(`/consultant-referrals/options?patient_id=${encodeURIComponent(selectedPatient)}`)
      .then((v) => {
        if (current) {
          setChoices(v);
        }
      })
      .catch((e) => {
        if (current) {
          setError(e.message);
        }
      });
    return () => {
      current = false;
    };
  }, [selectedPatient]);
  async function change(path: string, values: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await careApi(path, "POST", values);
      await refresh();
      setModal(null);
      setNotice("Referral updated.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function open(
    type: "new" | "accept" | "decline" | "withdraw" | "complete" | "cancel" | "reschedule",
    row?: Referral,
  ) {
    setError("");
    setModal({ type, row });
    setSchedule(type === "reschedule");
    setRequestId(crypto.randomUUID());
    if (type === "new") {
      setSelectedPatient("");
    }
    if (type === "complete" && row) {
      setResponseNotes([]);
      void careApi(`/patients/${row.patient_id}`)
        .then((v) =>
          setResponseNotes(
            v.encounters.filter(
              (n: {
                id: string;
                author_id: string;
                status: string;
                note_kind: string;
                visit_id: string | null;
                created_at: string;
              }) =>
                n.author_id === me.user.id &&
                n.status !== "draft" &&
                n.note_kind === "general" &&
                n.created_at >= row.created_at &&
                (row.kind !== "transfer" || n.visit_id === row.visit_id),
            ),
          ),
        )
        .catch((e) => setError(e.message));
    }
  }
  async function preview(row: Referral) {
    setError("");
    try {
      const data = await careApi(`/consultant-referrals/${row.id}/source`);
      setSources((previous) => ({ ...previous, [row.id]: data }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="hp-heading">
        <div>
          <span className="hp-eyebrow">OUTPATIENT SPECIALIST CARE</span>
          <h1>{patient ? "My consultant referrals" : "Consultant referrals"}</h1>
          <p>
            {patient
              ? "Track your specialist referrals and appointments."
              : "Review, schedule and respond to specialist referrals."}
          </p>
        </div>
        <div className="hp-inline-actions">
          <button
            className="hp-button secondary"
            disabled={busy}
            onClick={() => void refresh().catch((e) => setError(e.message))}
          >
            Refresh
          </button>
          {canCreate && (
            <button className="hp-button primary" onClick={() => open("new")}>
              Refer to consultant
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p role="status">Loading referrals…</p>
      ) : !rows.length ? (
        <Empty
          title="No consultant referrals"
          text="Requests, decisions and scheduled consultations will appear here."
        />
      ) : (
        <div className="hp-care-episode-grid">
          {rows.map((row) => (
            <section className="hp-panel hp-padded" key={row.id}>
              <span className="hp-chip">
                {row.status} · {row.kind === "advice" ? "Specialist advice" : "Transfer of care"}
              </span>
              <h2>{row.patient_name}</h2>
              <p>{row.healthpass_id}</p>
              <p>
                From {row.from_name} → <strong>{row.consultant_name}</strong>
              </p>
              {row.scheduled_at && <p>Scheduled: {date(row.scheduled_at)}</p>}
              {row.decline_reason && <p>Reason: {row.decline_reason}</p>}
              {row.reason_hidden && (
                <p className="hp-fine">
                  Detailed reason is unavailable under current patient sharing.
                </p>
              )}
              {!patient && (
                <button
                  className="hp-text-button"
                  disabled={busy}
                  onClick={() => void preview(row)}
                >
                  View signed referral source
                </button>
              )}
              {sources[row.id] && (
                <section className="hp-notice">
                  <h3>Signed source · version {sources[row.id].version}</h3>
                  {["complaint", "history", "findings", "assessment", "plan"].map((field) => (
                    <p key={field}>
                      <strong>{field.charAt(0).toUpperCase() + field.slice(1)}</strong>
                      <br />
                      {sources[row.id].source[field] || "Not recorded"}
                    </p>
                  ))}
                </section>
              )}
              {row.status === "pending" && row.consultant_id === me.user.id && canRespond && (
                <div className="hp-inline-actions">
                  <button
                    className="hp-button primary"
                    disabled={busy}
                    onClick={() => open("accept", row)}
                  >
                    Accept
                  </button>
                  <button
                    className="hp-button secondary"
                    disabled={busy}
                    onClick={() => open("decline", row)}
                  >
                    Decline
                  </button>
                </div>
              )}
              {["pending", "scheduled"].includes(row.status) &&
                row.from_user_id === me.user.id &&
                canCreate && (
                  <button
                    className="hp-text-button"
                    disabled={busy}
                    onClick={() => open("withdraw", row)}
                  >
                    Withdraw referral
                  </button>
                )}
              {row.status === "scheduled" && row.consultant_id === me.user.id && canRespond && (
                <button
                  className="hp-button primary"
                  disabled={busy || Date.parse(row.scheduled_at ?? "") > Date.now()}
                  onClick={() =>
                    void change(`/consultant-referrals/${row.id}/start`, { version: row.version })
                  }
                >
                  Start scheduled consultation
                </button>
              )}
              {row.status === "scheduled" && row.consultant_id === me.user.id && canRespond && (
                <div className="hp-inline-actions">
                  <button
                    className="hp-button secondary"
                    onClick={() => open("reschedule", row)}
                    disabled={busy}
                  >
                    Reschedule
                  </button>
                  <button
                    className="hp-text-button"
                    onClick={() => open("cancel", row)}
                    disabled={busy}
                  >
                    Cancel scheduled consultation
                  </button>
                </div>
              )}
              {row.status === "accepted" && row.consultant_id === me.user.id && canRespond && (
                <>
                  <p className="hp-fine">
                    Document and sign your own consultation record in the patient chart
                    {row.kind === "transfer" ? " through the transferred visit" : ""}, then link it
                    here.
                  </p>
                  <button
                    className="hp-button secondary"
                    disabled={busy}
                    onClick={() => open("complete", row)}
                  >
                    Complete consultation
                  </button>
                </>
              )}
            </section>
          ))}
        </div>
      )}
      {modal && (
        <Modal
          title={
            {
              new: "Refer outpatient to consultant",
              accept: "Accept consultant referral",
              decline: "Decline referral",
              withdraw: "Withdraw referral",
              cancel: "Cancel scheduled consultation",
              reschedule: "Reschedule consultation",
              complete: "Complete consultant consultation",
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
          {modal.row && (
            <p>
              <strong>{modal.row.patient_name}</strong> ·{" "}
              {modal.row.kind === "advice" ? "Specialist advice" : "Transfer of care"}
            </p>
          )}
          {modal.type === "accept" && !schedule ? (
            <>
              <p>
                Accept now to begin, or choose a consultation date and time. A scheduled transfer
                does not change the GP’s responsibility until you start it.
              </p>
              <div className="hp-inline-actions">
                <button
                  className="hp-button primary"
                  disabled={busy}
                  onClick={() =>
                    void change(`/consultant-referrals/${modal.row!.id}/accept`, {
                      version: modal.row!.version,
                      decision: "now",
                    })
                  }
                >
                  Accept now
                </button>
                <button
                  className="hp-button secondary"
                  disabled={busy}
                  onClick={() => setSchedule(true)}
                >
                  Schedule
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = Object.fromEntries(new FormData(e.currentTarget));
                if (modal.type === "new") {
                  void change("/consultant-referrals", { ...f, client_request_id: requestId });
                } else if (modal.row) {
                  void change(`/consultant-referrals/${modal.row.id}/${modal.type}`, {
                    ...f,
                    version: modal.row.version,
                    ...(["accept", "reschedule"].includes(modal.type)
                      ? {
                          decision: "schedule",
                          scheduled_at: new Date(String(f.scheduled_at)).toISOString(),
                        }
                      : {}),
                  });
                }
              }}
            >
              {modal.type === "new" && (
                <>
                  <label>
                    Patient
                    <select
                      required
                      value={selectedPatient}
                      onChange={(e) => {
                        setError("");
                        setSelectedPatient(e.target.value);
                      }}
                    >
                      <option value="">Choose outpatient</option>
                      {patients.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.healthpass_id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Your signed referral source
                    <select
                      aria-label="Your signed referral source"
                      name="source_encounter_id"
                      required
                      disabled={!choices.sources.length}
                    >
                      <option value="">Choose your signed clinical note</option>
                      {choices.sources.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.complaint || "Signed consultation"} · version {n.version}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Consultant
                    <select
                      aria-label="Consultant"
                      name="consultant_id"
                      required
                      disabled={!choices.consultants.length}
                    >
                      <option value="">Choose reviewed consultant</option>
                      {choices.consultants.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Referral purpose
                    <select aria-label="Referral purpose" name="kind" required>
                      <option value="advice">Specialist advice — retain GP responsibility</option>
                      <option value="transfer">
                        Transfer care — consultant takes over this visit on acceptance
                      </option>
                    </select>
                  </label>
                  <p className="hp-fine">
                    The consultant needs independent patient permission and reviewed clinical
                    authority. A referral grants neither. New source notes must be signed before
                    referral.
                  </p>
                </>
              )}
              {["accept", "reschedule"].includes(modal.type) && schedule && (
                <label>
                  Consultation date and time
                  <input name="scheduled_at" type="datetime-local" required />
                </label>
              )}
              {["decline", "withdraw", "cancel"].includes(modal.type) && (
                <label>
                  {modal.type === "decline"
                    ? "Reason for declining"
                    : modal.type === "cancel"
                      ? "Reason for cancellation"
                      : "Reason for withdrawing"}
                  <textarea name="reason" required maxLength={1000} />
                </label>
              )}
              {modal.type === "complete" && (
                <label>
                  Your signed consultation record
                  <select
                    aria-label="Your signed consultation record"
                    name="response_encounter_id"
                    required
                  >
                    <option value="">Choose your signed note</option>
                    {responseNotes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.complaint || "Signed consultation"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="hp-button primary"
                disabled={
                  busy ||
                  (modal.type === "new" && (!choices.sources.length || !choices.consultants.length))
                }
              >
                {busy
                  ? "Saving…"
                  : modal.type === "new"
                    ? "Send referral"
                    : modal.type === "decline"
                      ? "Decline referral"
                      : modal.type === "withdraw"
                        ? "Confirm withdrawal"
                        : ["accept", "reschedule"].includes(modal.type)
                          ? "Confirm schedule"
                          : modal.type === "cancel"
                            ? "Confirm cancellation"
                            : "Complete consultation"}
              </button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
