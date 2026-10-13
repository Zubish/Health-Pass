import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import { careApi } from "@/lib/healthpass-client";
import { date } from "@/lib/healthpass-types";
import type { Me, Patient } from "@/lib/healthpass-types";
import type { CareVisit, VisitDetail } from "@/lib/healthpass-visit-types";
import { Empty, Modal } from "./primitives";
import type { CareArea } from "./individual-access";
import { VisitHandoff } from "./visit-handoff";

type Team = {
  professionals: { id: string; name: string; clinicalScopes: string[] }[];
  branches: { id: string; name: string }[];
};
const statuses = {
  waiting: "Waiting",
  "in-progress": "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};
const vitalFields = [
  ["systolic", "Systolic blood pressure", "mmHg"],
  ["diastolic", "Diastolic blood pressure", "mmHg"],
  ["pulse", "Pulse", "beats/min"],
  ["temperature", "Temperature", "°C"],
  ["spo2", "Oxygen saturation", "%"],
  ["respiratory_rate", "Respiratory rate", "breaths/min"],
  ["weight", "Weight", "kg"],
] as const;
export function Visits({
  me,
  onOpenChart,
  onDocumentVisit,
}: {
  me: Me;
  onOpenChart: (patientId: string) => void;
  onDocumentVisit: (visit: CareVisit) => void;
}) {
  const search = useSearch({ from: "/workspace" });
  const navigate = useNavigate({ from: "/workspace" });
  const visitId = search.visit;
  const branch = me.branch?.id ?? search.branch ?? "";
  const setBranch = (id: string) => {
    void navigate({ search: { tab: "today", branch: id || undefined } });
  };
  const onSelectVisit = (id?: string) => {
    void navigate({ search: { tab: "today", branch: branch || undefined, visit: id } });
  };
  const can = (permission: string) => me.permissions?.includes(permission) ?? false;
  const [visits, setVisits] = useState<CareVisit[]>([]);
  const [detail, setDetail] = useState<VisitDetail | null>(null);
  const canContribute = detail?.accessScope?.canContribute ?? false;
  const contributionScopes = detail?.accessScope?.contributionScopes ?? [];
  const [team, setTeam] = useState<Team>({ professionals: [], branches: [] });
  const [status, setStatus] = useState("active");
  const [mine, setMine] = useState(!can("visits.manage"));
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checkIn, setCheckIn] = useState(false);
  const [observing, setObserving] = useState(false);
  const [cancelling, setCancelling] = useState<{
    id: string;
    version: number;
    task: boolean;
  } | null>(null);
  const [followUp, setFollowUp] = useState(false);
  const [observationRequest, setObservationRequest] = useState("");
  const [followUpRequest, setFollowUpRequest] = useState("");
  const [assignment, setAssignment] = useState("");
  async function load(next?: string) {
    const query = new URLSearchParams({ status, limit: "50" });
    if (branch) {
      query.set("branch_id", branch);
    }
    if (next) {
      query.set("cursor", next);
    }
    const data = await careApi(`/visits?${query}`);
    setVisits((previous) => (next ? [...previous, ...data.visits] : data.visits));
    setCursor(data.nextCursor ?? null);
  }
  async function loadDetail() {
    if (visitId) {
      const data = await careApi(`/visits/${visitId}`);
      setDetail(data);
      setAssignment(data.visit.assigned_user_id ?? "");
    }
  }
  async function action(run: () => Promise<void>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await run();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setDetail(null);
    const query = new URLSearchParams({ status, limit: "50" });
    if (branch) {
      query.set("branch_id", branch);
    }
    const work = visitId
      ? careApi(`/visits/${visitId}`).then((data) => {
          if (current) {
            setDetail(data);
            setAssignment(data.visit.assigned_user_id ?? "");
          }
        })
      : careApi(`/visits?${query}`).then((data) => {
          if (current) {
            setVisits(data.visits);
            setCursor(data.nextCursor ?? null);
          }
        });
    work
      .catch((e) => {
        if (current) {
          setError(e.message);
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [visitId, branch, status]);
  const teamBranch = detail?.visit.branch_id ?? branch;
  useEffect(() => {
    let current = true;
    const query = teamBranch ? `?branch_id=${encodeURIComponent(teamBranch)}` : "";
    careApi(`/visits/team${query}`)
      .then((data) => {
        if (current) {
          setTeam(data);
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
  }, [teamBranch]);
  const shown = mine
    ? visits.filter(
        (v) => v.assigned_user_id === me.user.id || v.pending_handoff_to_user_id === me.user.id,
      )
    : visits;
  const visit = detail?.visit;
  const own = visit?.assigned_user_id === me.user.id;
  return (
    <>
      <div className="hp-heading">
        <div>
          <span className="hp-eyebrow">
            {me.organization?.name} · {visit?.branch_name || me.branch?.name || "CARE DELIVERY"}
          </span>
          <h1>{visit ? visit.patient_name : "Today's work"}</h1>
          <p>
            {visit
              ? `${visit.healthpass_id} · ${statuses[visit.status]}`
              : "Receive patients, find your assignments and complete each care visit."}
          </p>
        </div>
        <div className="hp-form-actions">
          {visit ? (
            <button className="hp-button secondary" onClick={() => onSelectVisit()}>
              <ArrowLeft size={17} />
              Back to visits
            </button>
          ) : (
            can("visits.manage") && (
              <button className="hp-button primary" onClick={() => setCheckIn(true)}>
                <Plus size={17} />
                Check in patient
              </button>
            )
          )}
          <button
            className="hp-button secondary"
            disabled={busy || loading}
            onClick={() => void action(visitId ? loadDetail : load, "Visits refreshed.")}
          >
            <RefreshCw size={17} />
            Refresh
          </button>
        </div>
      </div>
      {error && (
        <p className="hp-error" role="alert">
          {error}
          <button
            className="hp-text-button"
            disabled={busy}
            onClick={() => void action(visitId ? loadDetail : load, "Refreshed.")}
          >
            Retry
          </button>
        </p>
      )}
      {notice && (
        <p className="hp-success" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading visits…</p>
      ) : !visitId ? (
        <>
          <section className="hp-panel hp-padded">
            <div className="hp-form-grid">
              <label>
                Branch
                <select
                  value={branch}
                  disabled={!!me.branch}
                  onChange={(e) => setBranch(e.target.value)}
                >
                  <option value="">All permitted branches</option>
                  {team.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Visit status
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="active">Active visits</option>
                  {Object.entries(statuses).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                  <option value="all">All visits</option>
                </select>
              </label>
            </div>
            <label style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={mine}
                onChange={(e) => setMine(e.target.checked)}
                style={{ width: 18, height: 18, flexShrink: 0 }}
              />
              <span>My assignments and incoming handoffs</span>
            </label>
          </section>
          <section className="hp-panel">
            <div className="hp-panel-heading">
              <h2>{mine ? "My work and incoming handoffs" : "Branch arrival queue"}</h2>
            </div>
            {shown.length ? (
              shown.map((v) => (
                <button
                  className="hp-patient-row"
                  key={v.id}
                  onClick={() => onSelectVisit(v.id)}
                  style={{ flexWrap: "wrap" }}
                >
                  <span className="hp-patient-name">
                    <strong>{v.patient_name}</strong>
                    <small>
                      {v.healthpass_id} · {v.branch_name}
                    </small>
                    <small>
                      {v.assigned_name ? `Assigned to ${v.assigned_name}` : "Unassigned"} · Arrived{" "}
                      {date(v.checked_in_at)}
                    </small>
                    {v.pending_handoff_id && (
                      <small>
                        {v.pending_handoff_expires_at &&
                        Date.parse(v.pending_handoff_expires_at) <= Date.now()
                          ? "Expired handoff"
                          : "Handoff requested"}{" "}
                        · {v.pending_handoff_to_name}
                      </small>
                    )}
                  </span>
                  <span
                    style={{ display: "inline-flex" }}
                    className={`hp-chip ${v.status === "in-progress" ? "teal" : v.status === "waiting" ? "amber" : "neutral"}`}
                  >
                    {statuses[v.status]}
                  </span>
                </button>
              ))
            ) : (
              <Empty
                title={mine ? "No assigned visits in this view" : "No visits in this view"}
                text={
                  mine
                    ? "Change the filters or ask your care coordinator about an assignment."
                    : "Check in a registered patient when they arrive for care."
                }
              />
            )}
            {cursor && (
              <div className="hp-padded">
                <button
                  className="hp-button secondary"
                  disabled={busy}
                  onClick={() => void action(() => load(cursor), "More visits loaded.")}
                >
                  Load more visits
                </button>
              </div>
            )}
          </section>
        </>
      ) : (
        detail &&
        visit && (
          <>
            <section className="hp-panel hp-padded">
              <h2>Visit context</h2>
              <p>
                {visit.branch_name} · Arrived {date(visit.checked_in_at)}
              </p>
              <p>
                <strong>Accountable professional:</strong> {visit.assigned_name || "Unassigned"}
              </p>
              <div className="hp-form-actions">
                {can("records.view") && detail.clinicalAllowed && (
                  <button
                    className="hp-button secondary"
                    onClick={() => onOpenChart(visit.patient_id)}
                  >
                    Open patient record
                  </button>
                )}
                {own &&
                  detail.clinicalAllowed &&
                  canContribute &&
                  can("visits.document") &&
                  visit.status === "waiting" && (
                    <button
                      className="hp-button primary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await careApi(`/visits/${visit.id}`, "PATCH", {
                            version: visit.version,
                            status: "in-progress",
                          });
                          await loadDetail();
                        }, "Visit started.")
                      }
                    >
                      Start consultation
                    </button>
                  )}
                {own &&
                  detail.clinicalAllowed &&
                  canContribute &&
                  can("notes.create") &&
                  visit.status === "in-progress" && (
                    <button className="hp-button primary" onClick={() => onDocumentVisit(visit)}>
                      Document visit
                    </button>
                  )}
                {own &&
                  detail.clinicalAllowed &&
                  canContribute &&
                  can("visits.document") &&
                  visit.status === "in-progress" && (
                    <button
                      className="hp-button secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await careApi(`/visits/${visit.id}`, "PATCH", {
                            version: visit.version,
                            status: "completed",
                          });
                          await loadDetail();
                        }, "Visit completed.")
                      }
                    >
                      Complete visit
                    </button>
                  )}
                {can("visits.manage") && ["waiting", "in-progress"].includes(visit.status) && (
                  <button
                    className="hp-text-button"
                    disabled={busy}
                    onClick={() =>
                      setCancelling({ id: visit.id, version: visit.version, task: false })
                    }
                  >
                    Cancel visit
                  </button>
                )}
              </div>
              {visit.status === "in-progress" && own && (
                <p className="hp-fine">Sign your visit note before completing this visit.</p>
              )}
              {can("visits.manage") && visit.status === "waiting" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      await careApi(`/visits/${visit.id}`, "PATCH", {
                        version: visit.version,
                        assigned_user_id: assignment,
                      });
                      await loadDetail();
                    }, "Assignment updated.");
                  }}
                >
                  <label>
                    Assigned professional
                    <select
                      required
                      value={assignment}
                      onChange={(e) => setAssignment(e.target.value)}
                    >
                      <option value="">Choose an accountable professional</option>
                      {team.professionals.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.clinicalScopes.join(", ")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="hp-button secondary" disabled={busy}>
                    Save assignment
                  </button>
                </form>
              )}
            </section>
            <VisitHandoff visit={visit} me={me} onChanged={loadDetail} onOpenChart={onOpenChart} />
            {!detail.clinicalAllowed ? (
              <p className="hp-notice">
                This view contains arrival and assignment information. Clinical care is available
                only to authorised care participants with current patient access and reviewed
                permissions. New visit documentation remains the assigned professional’s work.
              </p>
            ) : (
              <>
                <section className="hp-panel hp-padded">
                  <div className="hp-panel-heading">
                    <h2>Observations</h2>
                    {can("observations.create") &&
                      canContribute &&
                      contributionScopes.some(
                        (scope) => scope === "general" || scope === "nursing",
                      ) &&
                      own &&
                      visit.status === "in-progress" && (
                        <button
                          className="hp-button secondary"
                          onClick={() => {
                            setObservationRequest(crypto.randomUUID());
                            setObserving(true);
                          }}
                        >
                          Record observations
                        </button>
                      )}
                  </div>
                  {detail.observations.length ? (
                    detail.observations.map((o) => (
                      <div className="hp-grant" key={o.id}>
                        <div>
                          <strong>{date(o.observed_at)}</strong>
                          {o.observations && <p>{o.observations}</p>}
                          <p>
                            {vitalFields
                              .filter(([key]) => o.values[key] !== undefined)
                              .map(([key, label, unit]) => `${label}: ${o.values[key]} ${unit}`)
                              .join(" · ")}
                          </p>
                          {o.author_name && <small>{o.author_name}</small>}
                        </div>
                      </div>
                    ))
                  ) : (
                    <Empty
                      title="No observations recorded"
                      text="Record measurements you have taken; do not infer missing values."
                    />
                  )}
                </section>
                <section className="hp-panel hp-padded">
                  <div className="hp-panel-heading">
                    <h2>Follow-up work</h2>
                    {can("followups.manage") &&
                      canContribute &&
                      contributionScopes.length > 0 &&
                      own &&
                      !["cancelled"].includes(visit.status) && (
                        <button
                          className="hp-button secondary"
                          onClick={() => {
                            setFollowUpRequest(crypto.randomUUID());
                            setFollowUp(true);
                          }}
                        >
                          Add follow-up
                        </button>
                      )}
                  </div>
                  {detail.followUps.length ? (
                    detail.followUps.map((f) => (
                      <div className="hp-grant" key={f.id}>
                        <div>
                          <strong>{f.title}</strong>
                          <p>Due {date(f.due_at)}</p>
                          <small>
                            {f.status} · {f.author_name || "Original task author"} ·{" "}
                            {date(f.updated_at || f.created_at || "")}
                          </small>
                        </div>
                        {f.status === "open" &&
                          detail.clinicalAllowed &&
                          f.author_id === me.user.id &&
                          can("followups.manage") &&
                          canContribute &&
                          (contributionScopes.includes(f.discipline ?? "general") ||
                            (f.discipline === "unknown" && !detail.accessScope?.restricted)) && (
                            <div className="hp-form-actions">
                              <button
                                className="hp-button secondary"
                                disabled={busy}
                                onClick={() =>
                                  void action(async () => {
                                    await careApi(
                                      `/visits/${visit.id}/follow-ups/${f.id}`,
                                      "PATCH",
                                      {
                                        version: f.version,
                                        status: "completed",
                                      },
                                    );
                                    await loadDetail();
                                  }, "Follow-up completed.")
                                }
                              >
                                Mark completed
                              </button>
                              <button
                                className="hp-text-button"
                                disabled={busy}
                                onClick={() =>
                                  setCancelling({ id: f.id, version: f.version, task: true })
                                }
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                      </div>
                    ))
                  ) : (
                    <Empty
                      title="No follow-up tasks"
                      text="Add an accountable next step when it is needed for this visit."
                    />
                  )}
                </section>
              </>
            )}
          </>
        )
      )}
      {checkIn && (
        <CheckIn
          me={me}
          team={team}
          initialBranch={branch}
          onClose={() => setCheckIn(false)}
          onCreated={(id) => {
            setCheckIn(false);
            onSelectVisit(id);
          }}
        />
      )}
      {cancelling && visit && (
        <Modal
          title={cancelling.task ? "Cancel follow-up" : "Cancel visit"}
          onClose={() => {
            if (!busy) {
              setCancelling(null);
            }
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const reason = String(new FormData(e.currentTarget).get("reason") || "");
              void action(async () => {
                await careApi(
                  cancelling.task
                    ? `/visits/${visit.id}/follow-ups/${cancelling.id}`
                    : `/visits/${visit.id}`,
                  "PATCH",
                  { version: cancelling.version, status: "cancelled", reason },
                );
                setCancelling(null);
                await loadDetail();
              }, "Cancellation recorded; care history preserved.");
            }}
          >
            <label>
              Reason for cancellation
              <textarea name="reason" required maxLength={1000} />
            </label>
            <button className="hp-button primary" disabled={busy}>
              Confirm cancellation
            </button>
          </form>
        </Modal>
      )}
      {observing && visit && (
        <Modal
          title="Record visit observations"
          onClose={() => {
            if (!busy) {
              setObserving(false);
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
              const fields = new FormData(e.currentTarget);
              const values = Object.fromEntries(
                vitalFields
                  .filter(([key]) => String(fields.get(key) || "").trim())
                  .map(([key]) => [key, Number(fields.get(key))]),
              );
              void action(async () => {
                await careApi(`/visits/${visit.id}/observations`, "POST", {
                  values,
                  observations: String(fields.get("observations") || ""),
                  ...(fields.get("observed_at")
                    ? { observed_at: new Date(String(fields.get("observed_at"))).toISOString() }
                    : {}),
                  client_request_id: observationRequest,
                });
                setObserving(false);
                await loadDetail();
              }, "Observations recorded.");
            }}
          >
            <p className="hp-muted">Leave measurements you have not taken blank.</p>
            <div className="hp-form-grid">
              {vitalFields.map(([key, label, unit]) => (
                <label key={key}>
                  {label} ({unit})<input name={key} type="number" min="0" step="any" />
                </label>
              ))}
            </div>
            <label>
              Measurement time (leave blank for now)
              <input type="datetime-local" name="observed_at" />
            </label>
            <label>
              Observations / comments
              <textarea name="observations" maxLength={2000} />
            </label>
            <button className="hp-button primary" disabled={busy}>
              Save observations
            </button>
          </form>
        </Modal>
      )}
      {followUp && visit && (
        <Modal
          title="Add visit follow-up"
          onClose={() => {
            if (!busy) {
              setFollowUp(false);
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
              const fields = new FormData(e.currentTarget);
              void action(async () => {
                await careApi(`/visits/${visit.id}/follow-ups`, "POST", {
                  client_request_id: followUpRequest,
                  title: fields.get("title"),
                  due_at: new Date(String(fields.get("due_at"))).toISOString(),
                });
                setFollowUp(false);
                await loadDetail();
              }, "Follow-up added.");
            }}
          >
            <p className="hp-muted">
              This task remains assigned to you. It does not grant another professional record
              access.
            </p>
            <label>
              Follow-up task
              <input name="title" required maxLength={500} />
            </label>
            <label>
              Due date and time
              <input name="due_at" type="datetime-local" required />
            </label>
            <button className="hp-button primary" disabled={busy}>
              Save follow-up
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
function CheckIn({
  me,
  team,
  initialBranch,
  onClose,
  onCreated,
}: {
  me: Me;
  team: Team;
  initialBranch: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [query, setQuery] = useState("");
  const [patient, setPatient] = useState("");
  const [branch, setBranch] = useState(initialBranch || me.branch?.id || "");
  const [professionals, setProfessionals] = useState(team.professionals);
  const [assignee, setAssignee] = useState("");
  const [areas, setAreas] = useState<CareArea[]>([]);
  const [areaId, setAreaId] = useState("");
  useEffect(() => {
    void careApi("/care-areas")
      .then((v) => setAreas(v.areas))
      .catch(() => {});
  }, []);
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!branch) {
      setPatients([]);
      setPatient("");
      setLoading(false);
      return;
    }
    let current = true;
    setPatient("");
    setLoading(true);
    const timer = setTimeout(() => {
      careApi(
        `/visits/patients?branch_id=${encodeURIComponent(branch)}&search=${encodeURIComponent(query.trim())}&limit=25`,
      )
        .then((data) => {
          if (current) {
            setPatients(data.patients);
          }
        })
        .catch((e) => {
          if (current) {
            setError(e.message);
          }
        })
        .finally(() => {
          if (current) {
            setLoading(false);
          }
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, branch]);
  useEffect(() => {
    if (!branch) {
      return;
    }
    let current = true;
    setAssignee("");
    careApi(`/visits/team?branch_id=${encodeURIComponent(branch)}`)
      .then((data) => {
        if (current) {
          setProfessionals(data.professionals);
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
  }, [branch]);
  return (
    <Modal
      title="Check in a registered patient"
      onClose={() => {
        if (!busy) {
          onClose();
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
          setBusy(true);
          setError("");
          careApi("/visits", "POST", {
            patient_id: patient,
            branch_id: branch,
            assigned_user_id: assignee,
            client_request_id: requestId,
            care_area_id: areaId || undefined,
          })
            .then((data) => onCreated(data.id))
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Find a patient
          <input
            value={query}
            placeholder="Name or HealthPass ID"
            onChange={(e) => {
              setQuery(e.target.value);
              setPatient("");
            }}
          />
        </label>
        {loading && <p role="status">Finding registered patients…</p>}
        <label>
          Registered patient
          <select required value={patient} onChange={(e) => setPatient(e.target.value)}>
            <option value="">Choose the correct patient</option>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.healthpass_id} · {p.dob || "DOB unknown"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Arrival branch
          <select
            required
            value={branch}
            disabled={!!me.branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">Choose a branch</option>
            {team.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Department / ward
          <select
            value={areaId}
            onChange={(e) => setAreaId(e.target.value)}
            required={!!me.careAreaRestricted}
          >
            <option value="">
              {me.careAreaRestricted
                ? "Choose assigned care area"
                : "No outpatient department recorded / use current admission area"}
            </option>
            {areas
              .filter((a) => a.active && a.branch_id === branch)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.kind}
                </option>
              ))}
          </select>
        </label>
        <label>
          Assigned professional
          <select required value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Choose an accountable professional</option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.clinicalScopes.join(", ")}
              </option>
            ))}
          </select>
        </label>
        <p className="hp-fine">
          Check-in records arrival and assignment. It does not share prior facilities’ records or
          grant clinical permissions.
        </p>
        <button className="hp-button primary" disabled={busy || !patient || !branch || !assignee}>
          {busy ? "Checking in…" : "Check in patient"}
        </button>
      </form>
    </Modal>
  );
}
