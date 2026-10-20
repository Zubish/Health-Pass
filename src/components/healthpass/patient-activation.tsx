import { useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import { Mark } from "./primitives";
export function PatientActivation({
  claimId,
  onSuccess,
  onSignIn,
}: {
  claimId: string;
  onSuccess: () => Promise<void>;
  onSignIn: () => void;
}) {
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<{
    name: string;
    email: string;
    facility_name: string;
    expires_at: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("claim-token") ?? "";
    setToken(value);
    setPreview(null);
    setError("");
    if (!value) {
      setError("Open the complete verification link from your email.");
      return;
    }
    let current = true;
    void careApi("/auth/patient-claim", "POST", { claim_id: claimId, token: value, review: true })
      .then((data) => {
        if (current) {
          setPreview(data);
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
  }, [claimId]);
  return (
    <main className="hp-auth">
      <div className="hp-auth-card">
        <Mark />
        <h1>Activate your patient account</h1>
        <p>Verify your email and choose a password to view your care and manage sharing.</p>
        {error && (
          <p className="hp-error" role="alert">
            {error}
          </p>
        )}
        {!preview && !error && <p role="status">Checking your invitation…</p>}
        {preview && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              setBusy(true);
              setError("");
              try {
                await careApi("/auth/patient-claim", "POST", {
                  claim_id: claimId,
                  token,
                  password: data.get("password"),
                  confirm_registration: data.get("confirm") === "on",
                  keep_primary: data.get("primary") === "on",
                });
                await onSuccess();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="hp-notice">
              <strong>{preview.facility_name}</strong>
              <p>Registered profile: {preview.name}</p>
              <p>Email: {preview.email}</p>
            </div>
            <label>
              Password
              <input
                name="password"
                type="password"
                minLength={12}
                maxLength={256}
                required
                autoComplete="new-password"
              />
              <small>At least 12 characters.</small>
            </label>
            <label className="hp-check-row">
              <input name="confirm" type="checkbox" required />
              <span>I recognise this registration and want to activate my patient account.</span>
            </label>
            <label className="hp-check-row">
              <input name="primary" type="checkbox" defaultChecked />
              <span>
                Keep {preview.facility_name} as my primary care facility. I can change this later;
                this does not grant access to other facilities’ records.
              </span>
            </label>
            <button className="hp-button primary" disabled={busy}>
              {busy ? "Activating…" : "Verify email and create account"}
            </button>
          </form>
        )}
        <button className="hp-text-button" disabled={busy} onClick={onSignIn}>
          Back to sign in
        </button>
      </div>
    </main>
  );
}
