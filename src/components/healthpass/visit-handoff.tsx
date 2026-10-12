import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { careApi } from "@/lib/healthpass-client";
import { date } from "@/lib/healthpass-types";
import type { Me } from "@/lib/healthpass-types";
import type { CareVisit } from "@/lib/healthpass-visit-types";
import type { VisitHandoffEntry, VisitHandoffState } from "@/lib/healthpass-handoff-types";
import { Empty } from "./primitives";

const categories: Record<string, string> = {
  general: "General care",
  nursing: "Nursing care",
  medication: "Medication review",
};
const statusNames = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  cancelled: "Withdrawn / cancelled",
};
const touchButton = { minHeight: 44, maxWidth: "100%", whiteSpace: "normal" as const };
const empty: VisitHandoffState = {
  handoffs: [],
  canRequest: false,
  canAccept: false,
  canWithdraw: false,
  sourceNotes: [],
  professionals: [],
};
export function VisitHandoff({
  visit,
  me,
  onChanged,
  onOpenChart,
}: {
  visit: CareVisit;
  me: Me;
  onChanged: () => void | Promise<void>;
  onOpenChart?: (patientId: string) => void;
}) {
  const navigate = useNavigate({ from: "/workspace" });
  const [data, setData] = useState<VisitHandoffState>(empty);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recipient, setRecipient] = useState("");
  const [source, setSource] = useState("");
  const request = useRef<{ signature: string; id: string; version: number } | null>(null);
  const path = `/visits/${encodeURIComponent(visit.id)}/handoffs`;
  useEffect(() => {
    setRecipient("");
    setSource("");
    setNotice("");
    request.current = null;
  }, [visit.id]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoaded(false);
    setError("");
    careApi<VisitHandoffState>(path)
      .then((next) => {
        if (current) {
          setData(next);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [path, visit.version]);
  async function refresh() {
    const next = await careApi<VisitHandoffState>(path);
    setData(next);
    setLoaded(true);
    return next;
  }
  async function update(message: string, requestedId?: string) {
    try {
      await onChanged();
      const next = await refresh();
      const saved = requestedId
        ? next.handoffs.find((handoff) => handoff.id === requestedId)
        : null;
      setNotice(
        requestedId && saved?.status !== "pending"
          ? "This saved request has already been resolved. Review its history before requesting another handoff."
          : message,
      );
    } catch (e) {
      setNotice(
        requestedId
          ? "The request was acknowledged. Refresh to check its current status."
          : message,
      );
      setError(
        "The change was saved, but the current visit could not be refreshed. Refresh handoffs before continuing.",
      );
    }
  }
  function reviewChart() {
    if (onOpenChart) onOpenChart(visit.patient_id);
    else
      void navigate({
        search: {
          tab: "patients",
          patient: visit.patient_id,
          visit: visit.id,
          branch: visit.branch_id,
        },
      });
  }
  async function create() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const signature = JSON.stringify({ visit: visit.id, recipient, source });
      if (!request.current || request.current.signature !== signature)
        request.current = { signature, id: crypto.randomUUID(), version: visit.version };
      const saved = await careApi<{ id: string }>(path, "POST", {
        version: request.current.version,
        to_user_id: recipient,
        source_encounter_id: source,
        client_request_id: request.current.id,
      });
      request.current = null;
      setRecipient("");
      setSource("");
      await update(
        "Handoff requested. You remain responsible until the recipient accepts.",
        saved.id,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function transition(
    handoff: VisitHandoffEntry,
    operation: "accept" | "decline" | "withdraw",
  ) {
    const confirmations = {
      accept:
        "Accept responsibility for this visit? Your own patient permissions still apply. The outgoing professional’s records and tasks retain their authorship.",
      decline:
        "Decline this handoff? The current professional will remain responsible for this visit.",
      withdraw:
        "Withdraw this handoff request? The current professional will remain responsible for this visit.",
    };
    if (!window.confirm(confirmations[operation])) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await careApi(`${path}/${encodeURIComponent(handoff.id)}/${operation}`, "POST", {
        version: visit.version,
      });
      request.current = null;
      await update(
        operation === "accept"
          ? "Handoff accepted. You are now the accountable professional for this visit."
          : operation === "decline"
            ? "Handoff declined. Responsibility stays with the current professional."
            : "Handoff withdrawn. Responsibility stays with the current professional.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const outgoing = visit.assigned_user_id === me.user.id;
  const pending = data.handoffs.find((h) => h.status === "pending" && h.pending_live);
  const recipients = data.professionals.filter(
    (professional) =>
      !source ||
      !professional.allowed_source_note_ids ||
      professional.allowed_source_note_ids.includes(source),
  );
  return (
    <section className="hp-panel hp-padded hp-handoff" style={{ overflowWrap: "anywhere" }}>
      <div className="hp-panel-heading" style={{ padding: 0, flexWrap: "wrap", gap: 12 }}>
        <h2>Care handoff</h2>
        <button
          style={touchButton}
          className="hp-button secondary"
          disabled={busy || loading}
          onClick={() => {
            setBusy(true);
            setError("");
            void Promise.resolve()
              .then(onChanged)
              .then(refresh)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          Refresh handoffs
        </button>
      </div>
      <p className="hp-muted">
        Transfer this visit’s responsibility to an eligible professional in {visit.branch_name}.
        Patient access and signed-note ownership stay separate.
      </p>
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="hp-success" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading handoff information…</p>
      ) : !loaded ? (
        <p className="hp-notice">
          Handoff status is unavailable. Refresh before making a care transfer.
        </p>
      ) : (
        <>
          {pending && (
            <div className="hp-notice">
              <strong>Awaiting {pending.to_name}</strong>
              <p>
                {pending.from_name} remains responsible until acceptance. This request expires{" "}
                {date(pending.expires_at)}.
              </p>
              <p className="hp-fine">
                The visit cannot be completed while this request is pending.
              </p>
            </div>
          )}
          {data.canRequest && (
            <>
              {!data.sourceNotes.length ? (
                <div className="hp-notice">
                  <strong>A signed visit note is required</strong>
                  <p>
                    Finish your outgoing drafts and sign your own note linked to this visit before
                    requesting a handoff.
                  </p>
                  <button style={touchButton} className="hp-button secondary" onClick={reviewChart}>
                    Review visit notes
                  </button>
                </div>
              ) : !data.professionals.length ? (
                <div className="hp-notice">
                  <strong>No eligible receiving professionals</strong>
                  <p>
                    The recipient needs reviewed clinical authority, patient contribution access and
                    permission to read the source note in this branch. A handoff cannot grant those
                    permissions.
                  </p>
                </div>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void create();
                  }}
                >
                  <label>
                    Signed handoff note
                    <select
                      required
                      disabled={busy}
                      value={source}
                      onChange={(e) => {
                        setSource(e.target.value);
                        setRecipient("");
                      }}
                    >
                      <option value="">Choose your signed note from this visit</option>
                      {data.sourceNotes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {categories[n.note_kind] || n.note_kind} · version {n.version} ·{" "}
                          {date(n.created_at)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Receiving professional
                    <select
                      required
                      disabled={busy}
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                    >
                      <option value="">Choose an eligible professional</option>
                      {recipients.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ·{" "}
                          {p.clinicalScopes.map((scope) => categories[scope] || scope).join(", ")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="hp-fine">
                    The recipient has 24 hours to accept. You stay responsible until they do. Signed
                    care remains attributed to its author; unfinished drafts must be resolved first.
                  </p>
                  <div className="hp-form-actions">
                    <button
                      style={touchButton}
                      className="hp-button primary"
                      disabled={busy || !source || !recipient}
                    >
                      {busy ? "Requesting…" : "Request handoff"}
                    </button>
                    <button
                      style={touchButton}
                      className="hp-button secondary"
                      type="button"
                      disabled={busy}
                      onClick={reviewChart}
                    >
                      Review visit notes
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
          {!data.canRequest && !pending && outgoing && visit.status === "in-progress" && (
            <p className="hp-notice">
              {data.sourceNotes.length && !data.professionals.length
                ? "No receiving professional currently has both contribution permission and access to your signed source note in this branch. Ask the patient to review their selected-professional grants."
                : "Requesting a handoff requires your current clinical contribution access and an eligible signed linked note. Finish any outgoing drafts first."}
            </p>
          )}
          <h3>Handoff history</h3>
          {!data.handoffs.length ? (
            <Empty
              title="No handoffs for this visit"
              text="The assigned professional remains accountable for this care visit."
            />
          ) : (
            data.handoffs.map((h) => (
              <div
                className="hp-grant"
                key={h.id}
                style={{ flexWrap: "wrap", alignItems: "flex-start" }}
              >
                <div style={{ minWidth: 0, flex: "1 1 220px" }}>
                  <strong>
                    {h.from_name} → {h.to_name}
                  </strong>
                  <p>
                    {categories[h.source_note_kind] || "Signed care note"} · source version{" "}
                    {h.source_version}
                  </p>
                  <small>Requested {date(h.created_at)}</small>
                  <p className="hp-fine">
                    {h.resolved_at
                      ? `Resolved ${date(h.resolved_at)}`
                      : `Expires ${date(h.expires_at)}`}
                  </p>
                  {h.unavailable_reason && <p className="hp-notice">{h.unavailable_reason}</p>}
                </div>
                <span
                  className={`hp-chip ${h.status === "accepted" ? "teal" : h.status === "pending" && h.pending_live ? "amber" : "neutral"}`}
                >
                  {h.status === "pending" &&
                  !h.pending_live &&
                  Date.parse(h.expires_at) <= Date.now()
                    ? "Expired"
                    : h.status === "cancelled"
                      ? "Withdrawn / cancelled"
                      : h.status}
                </span>
                <div className="hp-form-actions" style={{ width: "100%", flexWrap: "wrap" }}>
                  {h.can_accept && (
                    <>
                      <button
                        style={touchButton}
                        className="hp-button secondary"
                        disabled={busy}
                        onClick={reviewChart}
                      >
                        Review signed care
                      </button>
                      <button
                        style={touchButton}
                        className="hp-button primary"
                        disabled={busy}
                        onClick={() => void transition(h, "accept")}
                      >
                        Accept handoff
                      </button>
                    </>
                  )}
                  {h.can_decline && (
                    <button
                      style={touchButton}
                      className="hp-button secondary"
                      disabled={busy}
                      onClick={() => void transition(h, "decline")}
                    >
                      Decline handoff
                    </button>
                  )}
                  {h.can_withdraw && (
                    <button
                      style={touchButton}
                      className="hp-text-button"
                      disabled={busy}
                      onClick={() => void transition(h, "withdraw")}
                    >
                      Withdraw request
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </section>
  );
}
