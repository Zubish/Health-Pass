import { useSuccessFeedback } from "@/lib/healthpass-preferences";
import { useCallback, useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import { date, type Me } from "@/lib/healthpass-types";
import { Modal, Empty } from "./primitives";
import type { CareArea } from "./individual-access";
type Episode = {
  id: string;
  version: number;
  patient_id: string;
  patient_name: string;
  healthpass_id: string;
  branch_id: string;
  branch_name: string;
  care_area_id: string;
  area_name: string;
  kind: string;
  status: string;
  created_at: string;
  end_reason: string | null;
  consultant: {
    id: string;
    version: number;
    name: string;
    consultant_id: string;
    service: string;
  } | null;
  team: {
    id: string;
    user_id: string;
    name: string;
    duty: string;
    active: number;
    version: number;
  }[];
  history: { action: string; payload: string; created_at: string; actor_name?: string }[];
};
type Options = {
  patients: { id: string; name: string; healthpass_id: string; branch_id: string }[];
  professionals: {
    id: string;
    name: string;
    clinicalScopes: string[];
    careAreaRestricted: boolean;
    careAreaIds: string[];
    branch_id: string | null;
  }[];
};
export function AdmissionCare({ me }: { me: Me }) {
  const manager = me.permissions?.includes("admissions.manage") ?? false;
  const leadManager = me.permissions?.includes("careteam.manage") ?? false;
  const patient = me.role === "patient";
  const [rows, setRows] = useState<Episode[]>([]);
  const [areas, setAreas] = useState<CareArea[]>([]);
  const [options, setOptions] = useState<Options>({ patients: [], professionals: [] });
  const [consultants, setConsultants] = useState<
    { id: string; name: string; branch_id: string | null }[]
  >([]);
  const [modal, setModal] = useState<{
    type: "new" | "team" | "lead" | "move" | "end";
    episode?: Episode;
  } | null>(null);
  const [selectedArea, setSelectedArea] = useState("");
  const [duty, setDuty] = useState("doctor");
  const [error, setError] = useState("");
  const setNotice = useSuccessFeedback();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState("");
  const refresh = useCallback(async () => {
    const [list, areaData, choices, leadChoices] = await Promise.all([
      careApi("/admissions"),
      manager ? careApi("/care-areas") : Promise.resolve({ areas: [] }),
      manager
        ? careApi("/admissions/options")
        : Promise.resolve({ patients: [], professionals: [] }),
      leadManager
        ? careApi("/care-responsibilities/options")
        : Promise.resolve({ consultants: [] }),
    ]);
    setRows(list.admissions);
    setAreas(areaData.areas);
    setOptions(choices);
    setConsultants(leadChoices.consultants);
  }, [manager, leadManager]);
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [refresh]);
  async function change(path: string, values: unknown, method = "POST") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await careApi(path, method, values);
      await refresh();
      setModal(null);
      setNotice("Care episode updated.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const open = (type: "new" | "team" | "lead" | "move" | "end", episode?: Episode) => {
    setError("");
    setRequestId(crypto.randomUUID());
    setSelectedArea(episode?.care_area_id ?? "");
    setModal({ type, episode });
  };
  const episode = modal?.episode;
  const area = areas.find((a) => a.id === selectedArea);
  return (
    <>
      <div className="hp-heading">
        <div>
          <span className="hp-eyebrow">{patient ? "MY CARE" : "WARD & OBSERVATION"}</span>
          <h1>{patient ? "My care episodes" : "Admissions & care teams"}</h1>
          <p>
            {patient
              ? "Your admissions and assigned care teams."
              : "Ward admissions and assigned care teams."}
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
          {manager && (
            <button className="hp-button primary" onClick={() => open("new")}>
              Open care episode
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
        <p role="status">Loading care episodes…</p>
      ) : !rows.length ? (
        <Empty
          title="No care episodes"
          text={
            manager
              ? "Create a ward or observation area under Workspace & branches, then open an episode for a registered patient."
              : "Inpatient and observation care will appear here when recorded."
          }
        />
      ) : (
        <div className="hp-care-episode-grid">
          {rows.map((row) => (
            <section className="hp-panel hp-padded" key={row.id}>
              <span className="hp-chip">
                {row.status} · {row.kind}
              </span>
              <h2>{row.patient_name}</h2>
              <p>
                {row.healthpass_id} · {row.branch_name}
              </p>
              <div className="hp-episode-context">
                {(patient || me.permissions?.includes("records.view")) && (
                  <p>
                    <a
                      className="hp-button secondary"
                      href={`/workspace?tab=patients&patient=${encodeURIComponent(row.patient_id)}`}
                    >
                      Open treatment & ward record
                    </a>
                  </p>
                )}
                <p>
                  <strong>{row.area_name}</strong> · Opened {date(row.created_at)}
                </p>
              </div>
              <p>
                Responsible consultant: <strong>{row.consultant?.name ?? "Not assigned"}</strong>
                {row.consultant ? ` · ${row.consultant.service}` : ""}
              </p>
              <h3>Supporting care team</h3>
              {row.team.filter((t) => t.active).length ? (
                row.team
                  .filter((t) => t.active)
                  .map((t) => (
                    <div className="hp-grant" key={t.id}>
                      <div>
                        <strong>{t.name}</strong>
                        <p>{t.duty}</p>
                      </div>
                      {manager && row.status === "active" && (
                        <button
                          className="hp-text-button"
                          disabled={busy}
                          onClick={() => {
                            setModal({ type: "team", episode: row });
                            setDuty(t.duty);
                          }}
                        >
                          Manage team
                        </button>
                      )}
                    </div>
                  ))
              ) : (
                <p>No supporting doctors or nurses assigned.</p>
              )}
              {row.status === "active" && (
                <div className="hp-inline-actions">
                  {manager && (
                    <>
                      <button className="hp-button secondary" onClick={() => open("team", row)}>
                        Manage supporting team
                      </button>
                      <button className="hp-button secondary" onClick={() => open("move", row)}>
                        Change ward / area
                      </button>
                      <button className="hp-text-button" onClick={() => open("end", row)}>
                        End care episode
                      </button>
                    </>
                  )}
                  {leadManager && (
                    <button className="hp-button secondary" onClick={() => open("lead", row)}>
                      {row.consultant ? "Reassign consultant" : "Assign consultant"}
                    </button>
                  )}
                </div>
              )}
              {row.end_reason && <p>Episode ended: {row.end_reason}</p>}
              <details>
                <summary>Episode history</summary>
                {row.history.map((h, i) => (
                  <p key={i}>
                    {h.action.replaceAll("admission.", "").replaceAll("_", " ")} ·{" "}
                    {date(h.created_at)} · {h.actor_name || "Historical actor"}
                  </p>
                ))}
              </details>
            </section>
          ))}
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal.type === "new"
              ? "Open inpatient or observation episode"
              : modal.type === "team"
                ? "Manage supporting care team"
                : modal.type === "lead"
                  ? "Assign responsible consultant"
                  : modal.type === "move"
                    ? "Change recorded care area"
                    : "End recorded care episode"
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              if (modal.type === "new") {
                void change("/admissions", {
                  ...f,
                  care_area_id: selectedArea,
                  client_request_id: requestId,
                });
              } else if (modal.type === "lead" && episode) {
                void change(
                  episode.consultant
                    ? `/care-responsibilities/${episode.consultant.id}`
                    : "/care-responsibilities",
                  {
                    ...f,
                    patient_id: episode.patient_id,
                    branch_id: episode.branch_id,
                    consultant_id: f.consultant_id,
                    ward: episode.area_name,
                    care_setting: "inpatient",
                    specialty_confirmed: f.specialty_confirmed === "confirmed",
                    client_request_id: requestId,
                    ...(episode.consultant
                      ? { action: "reassign", version: episode.consultant.version }
                      : {}),
                  },
                  episode.consultant ? "PATCH" : "POST",
                );
              } else if (episode) {
                void change(`/admissions/${episode.id}/${modal.type}`, {
                  ...f,
                  care_area_id: selectedArea,
                  version: episode.version,
                  duty,
                  confirm_episode_end: f.confirm_episode_end === "confirmed",
                });
              }
            }}
          >
            {episode && (
              <p>
                <strong>{episode.patient_name}</strong> · {episode.area_name}
              </p>
            )}
            {(modal.type === "new" || modal.type === "move") && (
              <label>
                Ward or observation area
                <select
                  aria-label="Ward or observation area"
                  required
                  value={selectedArea}
                  onChange={(e) => setSelectedArea(e.target.value)}
                >
                  <option value="">Choose recorded care area</option>
                  {areas
                    .filter(
                      (a) =>
                        a.active &&
                        a.kind !== "outpatient" &&
                        (!episode || a.branch_id === episode.branch_id),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.branch_name} · {a.kind}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {modal.type === "new" && (
              <label>
                Registered patient
                <select aria-label="Registered patient" name="patient_id" required disabled={!area}>
                  <option value="">Choose patient registered in this branch</option>
                  {options.patients
                    .filter((p) => p.branch_id === area?.branch_id)
                    .map((p) => (
                      <option key={p.id + ":" + p.branch_id} value={p.id}>
                        {p.name} · {p.healthpass_id}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {modal.type === "team" && episode && (
              <>
                <label>
                  Action
                  <select aria-label="Action" name="action">
                    <option value="assign">Assign / update supporting professional</option>
                    <option value="remove">Remove from active care team</option>
                  </select>
                </label>
                <label>
                  Duty
                  <select aria-label="Duty" value={duty} onChange={(e) => setDuty(e.target.value)}>
                    <option value="doctor">Supporting doctor</option>
                    <option value="nurse">Assigned nurse / midwife</option>
                    <option value="medication">Pharmacist / medication review</option>
                  </select>
                </label>
                <label>
                  Professional
                  <select aria-label="Professional" name="user_id" required>
                    <option value="">Choose professional</option>
                    {options.professionals
                      .filter(
                        (p) =>
                          (!p.branch_id || p.branch_id === episode.branch_id) &&
                          p.clinicalScopes.includes(
                            duty === "doctor"
                              ? "general"
                              : duty === "medication"
                                ? "medication"
                                : "nursing",
                          ),
                      )
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
                <p className="hp-fine">
                  Roles, individual restrictions, area scope and current patient sharing are checked
                  before assignment. Assignment does not grant record access.
                </p>
              </>
            )}
            {modal.type === "lead" && episode && (
              <>
                <label>
                  Consultant
                  <select
                    aria-label="Consultant"
                    name="consultant_id"
                    required
                    defaultValue={episode.consultant?.consultant_id ?? ""}
                  >
                    <option value="">Choose reviewed consultant</option>
                    {consultants
                      .filter((c) => !c.branch_id || c.branch_id === episode.branch_id)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Clinical service
                  <input
                    name="service"
                    required
                    maxLength={80}
                    defaultValue={episode.consultant?.service ?? ""}
                    placeholder="For example, Paediatrics"
                  />
                </label>
                <label>
                  Specialty credential review reference
                  <input name="specialty_review_reference" required maxLength={500} />
                </label>
                <label className="hp-permission-option">
                  <input name="specialty_confirmed" value="confirmed" type="checkbox" required />
                  <span>I have confirmed the reviewed credentials cover this service.</span>
                </label>
              </>
            )}
            {modal.type !== "new" && (
              <label>
                Reason
                <input
                  name="reason"
                  required
                  maxLength={500}
                  placeholder="Operational change reason; no clinical case details"
                />
              </label>
            )}
            {modal.type === "end" && (
              <>
                <p>
                  This records the end of this episode and closes its active team and consultant
                  assignment. It preserves records and history and does not sign a clinical
                  discharge decision.
                </p>
                <label className="hp-permission-option">
                  <input type="checkbox" name="confirm_episode_end" value="confirmed" required />
                  <span>
                    The admission or observation episode has ended under the facility’s approved
                    care process.
                  </span>
                </label>
              </>
            )}
            <button className="hp-button primary" disabled={busy}>
              {busy
                ? "Saving…"
                : modal.type === "new"
                  ? "Open care episode"
                  : modal.type === "end"
                    ? "Confirm episode ended"
                    : "Save assignment"}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
