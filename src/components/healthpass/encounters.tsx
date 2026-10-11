import { useBlocker } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Stethoscope } from "lucide-react";
import { blank, date } from "@/lib/healthpass-types";
import type { Note, Encounter } from "@/lib/healthpass-types";
import { Modal } from "./primitives";
export function NoteEditor({
  encounter,
  error,
  busy,
  onClose,
  onSave,
}: {
  error: string;
  encounter: Encounter | "new";
  busy: boolean;
  onClose: () => void;
  onSave: (note: Note, operation: string, reason?: string) => void;
}) {
  const [initial] = useState<Note>(() =>
      encounter === "new"
        ? { ...blank }
        : (Object.fromEntries(
            Object.keys(blank).map((key) => [key, encounter[key as keyof Note]]),
          ) as Note),
    ),
    [note, setNote] = useState<Note>(initial),
    [reason, setReason] = useState(""),
    [discard, setDiscard] = useState(false);
  const signed = encounter !== "new" && encounter.status !== "draft";
  const dirty =
    Object.keys(blank).some((key) => note[key as keyof Note] !== initial[key as keyof Note]) ||
    !!reason;
  useBlocker({
    shouldBlockFn: () =>
      busy || (dirty && !window.confirm("Leave this page? Unsaved note changes will be lost.")),
  });
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  function requestClose() {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  return (
    <Modal
      title={
        encounter === "new"
          ? "New encounter"
          : signed
            ? "Sign a versioned amendment"
            : "Encounter draft"
      }
      onClose={requestClose}
    >
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      <p className="hp-muted">
        {signed
          ? "Describe the correction and its reason. Earlier signed versions remain available."
          : "Save a draft before signing. Clinical content is never signed automatically."}
      </p>
      {discard && (
        <div className="hp-discard-notice" role="alert">
          <strong>You have unsaved changes.</strong>
          <p>Keep editing to save your note, or discard the changes made in this editor.</p>
          <div className="hp-form-actions">
            <button
              className="hp-button secondary"
              type="button"
              autoFocus
              onClick={() => setDiscard(false)}
            >
              Keep editing
            </button>
            <button className="hp-text-button" type="button" onClick={onClose} disabled={busy}>
              Discard changes
            </button>
          </div>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          onSave(note, signed ? "amend" : "save", reason);
        }}
      >
        {Object.keys(blank).map((key) => (
          <label key={key}>
            {
              (
                {
                  complaint: "Presenting complaint",
                  history: "History",
                  findings: "Findings & observations",
                  assessment: "Assessment",
                  plan: "Care plan & follow-up",
                } as Record<string, string>
              )[key]
            }
            <textarea
              value={note[key as keyof Note]}
              disabled={busy}
              required={key === "complaint" || (signed && ["assessment", "plan"].includes(key))}
              maxLength={6000}
              onChange={(e) => setNote({ ...note, [key]: e.target.value })}
            />
          </label>
        ))}
        {signed && (
          <label>
            Reason for amendment
            <textarea
              required
              disabled={busy}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        <div className="hp-form-actions">
          <button
            className="hp-button secondary"
            type="button"
            onClick={requestClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="hp-button primary" disabled={busy}>
            {signed ? "Sign amendment" : "Save draft"}
          </button>
          {encounter !== "new" && !signed && (
            <button
              className="hp-button primary"
              disabled={busy || !note.assessment.trim() || !note.plan.trim()}
              type="button"
              onClick={() => onSave(note, "sign")}
            >
              Save & sign
            </button>
          )}
        </div>
        <p className="hp-fine">
          {signed
            ? "Signing creates a new retained version attributed to you."
            : "Save status is confirmed only after the server responds. Sign when your assessment and plan are complete."}
        </p>
      </form>
    </Modal>
  );
}
export function EncounterCard({
  encounter,
  onEdit,
}: {
  encounter: Encounter;
  onEdit?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="hp-encounter">
      <div className="hp-encounter-head">
        <span className="hp-icon-tile blue">
          <Stethoscope size={19} />
        </span>
        <div>
          <h3>{encounter.complaint}</h3>
          <small>
            {date(encounter.created_at)} · {encounter.organization_name}
          </small>
        </div>
        <span className={`hp-chip ${encounter.status === "draft" ? "amber" : "teal"}`}>
          {encounter.status}
        </span>
      </div>
      <p>{encounter.assessment || "Assessment not yet recorded."}</p>
      <div className="hp-encounter-footer">
        <small>
          {encounter.author_name} · Version {encounter.version}
        </small>
        <div>
          <button className="hp-text-button" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide details" : "View details"}
          </button>
          {onEdit && (
            <button className="hp-text-button" onClick={onEdit}>
              {encounter.status === "draft" ? "Edit draft" : "Amend"}
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="hp-note-details">
          {Object.entries(blank)
            .filter(([key]) => key !== "complaint")
            .map(([key]) => (
              <div key={key}>
                <strong>{key}</strong>
                <p>{encounter[key as keyof Note] || "Not recorded"}</p>
              </div>
            ))}
          <h4>Signed version history</h4>
          {encounter.versions.map((v) => (
            <details key={v.id}>
              <summary>
                Version {v.version} · {v.signer_name} · {date(v.signed_at)}
              </summary>
              {v.amendment_reason && (
                <p>
                  <strong>Amendment reason:</strong> {v.amendment_reason}
                </p>
              )}
              {Object.entries(v.payload).map(([key, value]) => (
                <p key={key}>
                  <strong>{key}:</strong> {value || "Not recorded"}
                </p>
              ))}
              <small>Integrity digest: {v.signature_hash.slice(0, 16)}…</small>
            </details>
          ))}
          {!encounter.versions.length && <p>No signed version yet.</p>}
        </div>
      )}
    </article>
  );
}
