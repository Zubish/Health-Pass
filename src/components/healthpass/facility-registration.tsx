import { useEffect, useState, useRef, useCallback } from "react";
import { careApi } from "@/lib/healthpass-client";
import type { Me } from "@/lib/healthpass-types";
import { Modal } from "./primitives";
const deliveryText: Record<string, string> = {
  queued: "The verification invitation is queued for email delivery.",
  sent: "The verification invitation was sent. Ask the patient to open the link and choose a password.",
  awaiting_email_configuration:
    "The profile is saved, but email delivery is not configured yet. An invitation has not been sent. You can resend it here once delivery is connected.",
  no_email:
    "The facility profile is saved without a patient account. Add the patient’s own email later to invite them.",
  expired: "The invitation expired or was replaced. Send a new invitation.",
  retry_pending: "Email delivery failed and is awaiting retry. You can send a new invitation.",
  claimed: "The patient has activated their account.",
};
export function FacilityRegistration({
  me,
  onClose,
  onRegistered,
  onExisting,
}: {
  me: Me;
  onClose: () => void;
  onRegistered: (id: string, message: string) => void;
  onExisting: () => void;
}) {
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState(false);
  const [email, setEmail] = useState("");
  const retry = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => {
    void careApi("/patient-registration-options")
      .then((data) => setBranches(data.branches))
      .catch((e) => setError(e.message));
  }, []);
  return (
    <Modal title="Register a patient" onClose={onClose}>
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      <p className="hp-muted">
        Register a new profile for this care visit. An existing patient email uses the existing
        identity; names and shared phones never merge records.
      </p>
      {existing ? (
        <div className="hp-notice">
          <p>
            An account or registration already uses this email. No new profile was created. Ask the
            patient to share their profile or request access.
          </p>
          <button className="hp-button primary" onClick={onExisting}>
            Request access to an existing profile
          </button>
          <button className="hp-button secondary" onClick={() => setExisting(false)}>
            Review registration details
          </button>
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              const payload = {
                ...Object.fromEntries(data),
                identity_confirmed: data.get("identity_confirmed") === "on",
              };
              const signature = JSON.stringify(payload);
              if (!retry.current || retry.current.payload !== signature) {
                retry.current = { payload: signature, id: crypto.randomUUID() };
              }
              const result = await careApi("/patients", "POST", {
                ...payload,
                client_request_id: retry.current.id,
              });
              if (result.existing_account) {
                setExisting(true);
                return;
              }
              onRegistered(result.id, deliveryText[result.activation] ?? "Patient registered.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Full name
            <input name="name" required maxLength={160} />
          </label>
          <label>
            Date of birth <small>Optional; leave blank if unknown</small>
            <input name="dob" type="date" max={new Date().toISOString().slice(0, 10)} />
          </label>
          <label>
            Contact phone <small>Optional; may be shared</small>
            <input name="phone" type="tel" maxLength={40} />
          </label>
          <label>
            Patient email <small>Optional; use the patient’s own address</small>
            <input
              name="email"
              type="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {!me.branch && (
            <label>
              Receiving branch
              <select name="branch_id" required>
                <option value="">Choose a branch</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {email && (
            <label className="hp-check-row">
              <input name="identity_confirmed" type="checkbox" required />
              <span>
                I checked the patient’s identity and confirmed this is their own email. They will
                verify it and choose their password.
              </span>
            </label>
          )}
          <p className="hp-muted">
            Without email, this remains a facility profile. Do not substitute a relative’s email;
            proxy accounts will have a separate approval flow.
          </p>
          <button className="hp-button primary" disabled={busy}>
            {busy ? "Registering…" : "Register patient"}
          </button>
        </form>
      )}
    </Modal>
  );
}
export function FacilityActivation({
  patientId,
  onClose,
}: {
  patientId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    email: string | null;
    claimed: boolean;
    delivery: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    setData(await careApi(`/patient-activation?patient_id=${encodeURIComponent(patientId)}`));
  }, [patientId]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [refresh]);
  return (
    <Modal title="Patient account invitation" onClose={onClose}>
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
      {!data && !error && <p role="status">Checking account status…</p>}
      {data && (
        <>
          <p>{deliveryText[data.delivery] ?? "Invitation status unavailable."}</p>
          {!data.claimed && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  const result = await careApi("/patient-activation", "POST", {
                    patient_id: patientId,
                    ...Object.fromEntries(form),
                    identity_confirmed: form.get("identity_confirmed") === "on",
                  });
                  await refresh();
                  setNotice(deliveryText[result.activation]);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Patient email
                <input
                  name="email"
                  type="email"
                  defaultValue={data.email ?? ""}
                  readOnly={!!data.email}
                  required
                  maxLength={254}
                />
              </label>
              <label>
                Identity review reference
                <input
                  name="review_reference"
                  required
                  maxLength={500}
                  placeholder="Reference only; no identity document numbers"
                />
              </label>
              <label className="hp-check-row">
                <input name="identity_confirmed" type="checkbox" required />
                <span>
                  I checked the patient’s identity and confirmed their own email with them.
                </span>
              </label>
              <p className="hp-muted">
                A new invitation replaces earlier links. This cannot claim or merge older facility
                charts.
              </p>
              <button className="hp-button primary" disabled={busy}>
                {busy ? "Preparing…" : "Send new verification invitation"}
              </button>
            </form>
          )}
        </>
      )}
    </Modal>
  );
}
