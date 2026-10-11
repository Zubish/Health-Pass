import { useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import { date } from "@/lib/healthpass-types";
import { Empty, Modal } from "./primitives";

type Invitation = {
  id: string;
  facility_name: string;
  branch_name: string;
  expires_at: string;
  created_at: string;
  status: string;
};
type Identity = { id: string; healthpass_id: string; name: string; dob: string | null };
type Review = {
  invitation_id: string;
  patient: Identity;
  facility: { id: string; name: string };
  branch: { id: string; name: string };
  already_registered: boolean;
  possible_duplicates: Identity[];
};

export function PatientLinking() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [workspaceCode, setWorkspaceCode] = useState("");
  const [options, setOptions] = useState<{
    facility: { id: string; name: string };
    branches: { id: string; name: string }[];
  } | null>(null);
  const [branch, setBranch] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [issued, setIssued] = useState<{ code: string; invitation: Invitation } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  async function load() {
    setInvitations((await careApi("/patient-link-invitations")).invitations);
  }
  useEffect(() => {
    let current = true;
    careApi("/patient-link-invitations")
      .then((data) => {
        if (current) setInvitations(data.invitations);
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
  }, []);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="hp-panel hp-padded">
      <h2>Connect a facility</h2>
      <p className="hp-muted">
        Bring your existing HealthPass identity to a facility. Its team will confirm your identity
        before registering you.
      </p>
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            const result = await careApi(
              `/patient-link-options?workspace_code=${encodeURIComponent(workspaceCode.trim())}`,
            );
            setOptions(result);
            setBranch(result.branches.length === 1 ? result.branches[0].id : "");
          });
        }}
      >
        <label>
          Facility workspace code
          <input
            required
            value={workspaceCode}
            maxLength={80}
            placeholder="HP-…"
            onChange={(e) => {
              setWorkspaceCode(e.target.value);
              setOptions(null);
              setBranch("");
              setAcknowledged(false);
            }}
          />
        </label>
        <button className="hp-button secondary" disabled={busy || !workspaceCode.trim()}>
          Check facility
        </button>
      </form>
      {options && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              setCopied(false);
              setIssued(
                await careApi("/patient-link-invitations", "POST", {
                  workspace_code: workspaceCode.trim(),
                  branch_id: branch,
                  acknowledge_registration: acknowledged,
                }),
              );
              await load();
            });
          }}
        >
          <p className="hp-notice">
            <strong>{options.facility.name}</strong>
          </p>
          <label>
            Care branch
            <select required value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">Choose a branch</option>
              {options.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <input
              type="checkbox"
              required
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              style={{ width: 18, height: 18, flexShrink: 0, marginTop: 3 }}
            />
            <span>
              I agree to registration at this branch. Permitted facility staff can access care
              recorded there. Access to previous facilities’ signed records requires separate
              sharing.
            </span>
          </label>
          <p className="hp-fine">
            This connects your identity. It does not merge another record or share your entire
            history.
          </p>
          <button className="hp-button primary" disabled={busy || !branch || !acknowledged}>
            Create registration code
          </button>
        </form>
      )}
      {issued && (
        <div className="hp-notice" role="status">
          <strong>Your registration code</strong>
          <p style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{issued.code}</p>
          <p>
            Show this code privately to {issued.invitation.facility_name} ·{" "}
            {issued.invitation.branch_name}. It expires {date(issued.invitation.expires_at)} and can
            be used once.
          </p>
          <p className="hp-fine">
            The code is shown only here. If you leave without saving it, revoke the invitation and
            create another.
          </p>
          <button
            className="hp-button secondary"
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(issued.code)
                .then(() => setCopied(true))
                .catch(() =>
                  setError("Copy is unavailable. Select the visible code and copy it manually."),
                );
            }}
          >
            {copied ? "Code copied" : "Copy registration code"}
          </button>
          <button className="hp-text-button" onClick={() => setIssued(null)}>
            Hide code
          </button>
        </div>
      )}
      <h3>Registration invitations</h3>
      {loading ? (
        <p role="status">Loading invitations…</p>
      ) : !invitations.length ? (
        <Empty
          title="No registration invitations"
          text="Check the facility code when you are ready to register for care."
        />
      ) : (
        invitations.map((i) => (
          <div className="hp-grant" key={i.id}>
            <div>
              <strong>{i.facility_name}</strong>
              <p>{i.branch_name}</p>
              <small>Expires {date(i.expires_at)}</small>
            </div>
            <span className={`hp-chip ${i.status === "pending" ? "teal" : "neutral"}`}>
              {i.status}
            </span>
            {i.status === "pending" && (
              <button
                className="hp-text-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await careApi(`/patient-link-invitations/${i.id}/revoke`, "POST", {});
                    if (issued?.invitation.id === i.id) setIssued(null);
                    await load();
                  })
                }
              >
                Revoke invitation
              </button>
            )}
          </div>
        ))
      )}
    </section>
  );
}

export function FacilityLinking({
  onClose,
  onLinked,
}: {
  onClose: () => void;
  onLinked: (patientId: string) => void;
}) {
  const [code, setCode] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [reference, setReference] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [duplicatesReviewed, setDuplicatesReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Link an existing HealthPass account"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="hp-muted">
        Ask the patient for their registration code. Confirm their identity before connecting this
        facility to their existing HealthPass identity.
      </p>
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () =>
            setReview(
              await careApi("/patient-link-invitations/review", "POST", { code: code.trim() }),
            ),
          );
        }}
      >
        <label>
          Patient registration code
          <input
            required
            value={code}
            autoComplete="off"
            maxLength={200}
            onChange={(e) => {
              setCode(e.target.value);
              setReview(null);
              setConfirmed(false);
              setDuplicatesReviewed(false);
              setReference("");
            }}
          />
        </label>
        <button className="hp-button secondary" disabled={busy || !code.trim()}>
          Review invitation
        </button>
      </form>
      {review && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const result = await careApi("/patient-link-invitations/redeem", "POST", {
                code: code.trim(),
                identity_confirmed: confirmed,
                review_reference: reference.trim(),
                duplicate_reviewed: duplicatesReviewed,
              });
              onLinked(result.id);
            });
          }}
        >
          <div className="hp-notice">
            <strong>{review.patient.name}</strong>
            <p>
              {review.patient.healthpass_id} · {review.patient.dob || "Date of birth not recorded"}
            </p>
            <p>
              {review.facility.name} · {review.branch.name}
            </p>
            {review.already_registered && (
              <p>Already registered at this branch. Confirming will consume this invitation.</p>
            )}
          </div>
          {!!review.possible_duplicates.length && (
            <div className="hp-discard-notice">
              <strong>Review possible existing records</strong>
              <p>
                Similar details do not prove identity. These records will remain separate; no
                clinical history is merged.
              </p>
              {review.possible_duplicates.map((p) => (
                <p key={p.id}>
                  {p.name} · {p.healthpass_id} · {p.dob || "DOB unknown"}
                </p>
              ))}
              <label style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  required
                  checked={duplicatesReviewed}
                  onChange={(e) => setDuplicatesReviewed(e.target.checked)}
                  style={{ width: 18, height: 18, flexShrink: 0 }}
                />
                <span>
                  I reviewed these possible duplicates and understand they will not be merged.
                </span>
              </label>
            </div>
          )}
          <label>
            Identity review reference
            <input
              required
              maxLength={500}
              value={reference}
              placeholder="Reference to your identity check, without document numbers"
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          <label style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              required
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ width: 18, height: 18, flexShrink: 0 }}
            />
            <span>
              I confirmed that the person presenting this invitation is the patient shown above.
            </span>
          </label>
          <button
            className="hp-button primary"
            disabled={
              busy ||
              !confirmed ||
              !reference.trim() ||
              (!!review.possible_duplicates.length && !duplicatesReviewed)
            }
          >
            {busy ? "Connecting…" : "Confirm identity and link"}
          </button>
        </form>
      )}
    </Modal>
  );
}
