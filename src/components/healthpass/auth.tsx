import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, ArrowRight, ShieldCheck, LockKeyhole } from "lucide-react";
import { careApi } from "@/lib/healthpass-client";
import type { Me } from "@/lib/healthpass-types";
import { Mark } from "./primitives";
export type AccountMode = "register" | "patient" | "professional" | "professional-signin";
export function Auth({
  onSuccess,
  serviceError,
  initialMode,
  initialSetup,
  onModeChange,
}: {
  onSuccess: () => Promise<void>;
  serviceError: string;
  initialMode?: AccountMode;
  initialSetup?: boolean;
  onModeChange: (mode?: AccountMode, setup?: boolean) => void;
}) {
  const [view, setView] = useState(initialMode ?? "signin");
  const [accountType, setAccountType] = useState(
    initialMode === "professional-signin" ? "professional" : "patient",
  );
  const [firstAccess, setFirstAccess] = useState(!!initialSetup),
    [error, setError] = useState(serviceError),
    [busy, setBusy] = useState(false);
  const choosing = view === "register",
    patientCreate = view === "patient",
    facilityCreate = view === "professional",
    signin = !choosing && !patientCreate && !facilityCreate;
  const staffSetup = signin && accountType === "professional" && firstAccess;
  const creating = patientCreate || facilityCreate || staffSetup;
  function change(next: string) {
    onModeChange(
      next === "signin"
        ? accountType === "professional"
          ? "professional-signin"
          : undefined
        : (next as AccountMode),
    );
    setView(next);
    setFirstAccess(false);
    setError("");
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const path = patientCreate
        ? "/auth/register"
        : facilityCreate
          ? "/auth/facility-register"
          : staffSetup
            ? "/auth/workspace-register"
            : "/auth/login";
      await careApi(path, "POST", { ...values, account_type: accountType });
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="hp-login">
      <section className="hp-login-story">
        <a href="/" className="hp-brand">
          <img src="/healthpass-wordmark.png" alt="HealthPass" className="hp-wordmark" />
        </a>
        <div>
          <span className="hp-eyebrow">CONTINUITY OF CARE</span>
          <h1>
            A familiar place.
            <br />A fuller picture.
          </h1>
          <p>
            A personal care history for patients. A dedicated workspace for each facility and its
            care team.
          </p>
          <div className="hp-story-card">
            <ShieldCheck />
            <div>
              <strong>Care with context</strong>
              <p>Patient-controlled sharing and a clear record of who accessed your information.</p>
            </div>
          </div>
        </div>
        <span className="hp-ecosystem">HealthPass · RxLedger · Rai</span>
      </section>
      <section className="hp-login-form">
        <a href="/" className="hp-back">
          <ArrowLeft size={16} /> Back to HealthPass
        </a>
        <div className="hp-auth-card">
          <span className="hp-icon-tile teal">
            <LockKeyhole />
          </span>
          <h2>
            {choosing
              ? "Create account"
              : patientCreate
                ? "Create your patient account"
                : facilityCreate
                  ? "Create your facility workspace"
                  : staffSetup
                    ? "Set up your workspace access"
                    : "Welcome back"}
          </h2>
          <p>
            {choosing
              ? "Choose how you will use HealthPass."
              : patientCreate
                ? "Your care history, with records from your participating care teams."
                : facilityCreate
                  ? "Create a dedicated EMR/EHR workspace and its first branch. You will manage workspace access as its administrator."
                  : staffSetup
                    ? "Use your facility’s workspace code. Your administrator reviews your access before you can work."
                    : "Sign in to your patient account or your facility workspace."}
          </p>
          {choosing ? (
            <div className="hp-account-options">
              <button className="hp-account-option" onClick={() => change("patient")}>
                <strong>Patient</strong>
                <span>View your records and manage sharing.</span>
                <ArrowRight size={18} />
              </button>
              <button className="hp-account-option" onClick={() => change("professional")}>
                <strong>Healthcare professional / facility</strong>
                <span>Create your facility’s workspace and branches.</span>
                <ArrowRight size={18} />
              </button>
              <button
                className="hp-text-button"
                onClick={() => {
                  setAccountType("professional");
                  onModeChange("professional-signin");
                }}
              >
                Existing facility workspace? Sign in
              </button>
            </div>
          ) : (
            <>
              {signin && (
                <fieldset className="hp-account-switch">
                  <legend>Account type</legend>
                  <label>
                    <input
                      type="radio"
                      name="account-choice"
                      checked={accountType === "patient"}
                      onChange={() => {
                        setAccountType("patient");
                        onModeChange(undefined);
                        setFirstAccess(false);
                        setError("");
                      }}
                    />{" "}
                    Patient
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="account-choice"
                      checked={accountType === "professional"}
                      onChange={() => {
                        setAccountType("professional");
                        onModeChange("professional-signin");
                        setError("");
                      }}
                    />{" "}
                    Professional
                  </label>
                </fieldset>
              )}
              <form onSubmit={submit}>
                {signin && accountType === "professional" && (
                  <label>
                    Workspace code
                    <input
                      name="workspace_code"
                      required
                      maxLength={80}
                      autoCapitalize="characters"
                      placeholder="HP-…"
                    />
                    <small>
                      Provided by your facility administrator. Credentials apply to this workspace.
                    </small>
                  </label>
                )}
                {creating && (
                  <label>
                    Full name
                    <input name="name" required maxLength={160} autoComplete="name" />
                  </label>
                )}
                {patientCreate && (
                  <>
                    <label>
                      Date of birth <small>Optional; leave blank if unknown</small>
                      <input name="dob" type="date" max={new Date().toISOString().slice(0, 10)} />
                    </label>
                    <label>
                      Contact phone <small>Optional</small>
                      <input name="phone" type="tel" maxLength={40} autoComplete="tel" />
                    </label>
                  </>
                )}
                {facilityCreate && (
                  <>
                    <label>
                      Facility name
                      <input name="facility_name" required maxLength={160} />
                    </label>
                    <label>
                      Facility type
                      <select name="facility_type" required>
                        <option value="clinic">Clinic / primary care</option>
                        <option value="hospital">Hospital</option>
                        <option value="therapy">Therapy / rehabilitation</option>
                        <option value="other">Other care facility</option>
                      </select>
                    </label>
                    <label>
                      Facility address
                      <input name="address" required maxLength={500} />
                    </label>
                    <label>
                      First branch name
                      <input
                        name="branch_name"
                        required
                        maxLength={160}
                        placeholder="Main branch"
                      />
                    </label>
                  </>
                )}
                {staffSetup && (
                  <>
                    <label>
                      Profession / job title
                      <input name="profession" required maxLength={100} />
                    </label>
                    <label>
                      Professional registration number{" "}
                      <small>If applicable to your profession</small>
                      <input name="registration_number" maxLength={160} />
                    </label>
                  </>
                )}
                <label>
                  Email address
                  <input name="email" type="email" required autoComplete="email" />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={creating ? 12 : undefined}
                    maxLength={256}
                    autoComplete={creating ? "new-password" : "current-password"}
                  />
                </label>
                {facilityCreate && (
                  <label className="hp-checkbox">
                    <input name="authority" type="checkbox" value="confirmed" required /> I am
                    authorized to create and administer this facility workspace.
                  </label>
                )}
                {error && (
                  <div className="hp-error" role="alert">
                    {error}
                  </div>
                )}
                <button className="hp-button primary" disabled={busy}>
                  {busy
                    ? "Please wait…"
                    : facilityCreate
                      ? "Create facility workspace"
                      : staffSetup
                        ? "Request workspace access"
                        : patientCreate
                          ? "Create patient account"
                          : "Sign in"}
                  <ArrowRight size={16} />
                </button>
              </form>
              {signin && accountType === "professional" && (
                <button
                  className="hp-text-button"
                  disabled={busy}
                  onClick={() => {
                    setFirstAccess(!firstAccess);
                    onModeChange("professional-signin", !firstAccess);
                    setError("");
                  }}
                >
                  {firstAccess
                    ? "Already set up? Sign in"
                    : "First time in this workspace? Set up access"}
                </button>
              )}
            </>
          )}
          <button
            className="hp-text-button"
            disabled={busy}
            onClick={() => change(choosing || creating ? "signin" : "register")}
          >
            {choosing || creating ? "Already have an account? Sign in" : "Create account"}
          </button>
          {facilityCreate && (
            <p className="hp-fine">
              Creating a workspace grants administration access. Clinical roles require reviewed
              membership and authenticator verification.
            </p>
          )}
          {signin && accountType === "professional" && (
            <p className="hp-fine">
              You may use the same or different credentials at another facility. Each workspace
              keeps its own identity and permissions.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
export function Mfa({ me, onSuccess }: { me: Me; onSuccess: () => Promise<void> }) {
  const [secret, setSecret] = useState(""),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function setup() {
    try {
      const result = await careApi("/auth/mfa/setup", "POST", {});
      setSecret(result.secret);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await careApi("/auth/mfa/verify", "POST", { code });
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="hp-auth">
      <div className="hp-auth-card">
        <Mark />
        <h1>Protect your care workspace</h1>
        <p>
          {me.mfaEnrolled
            ? "Enter the six-digit code from your authenticator."
            : "Add HealthPass to your authenticator before accessing clinical records."}
        </p>
        {!me.mfaEnrolled && !secret && (
          <button className="hp-button primary" onClick={setup}>
            Set up authenticator
          </button>
        )}
        {secret && (
          <div className="hp-notice">
            <strong>Manual setup key</strong>
            <code className="hp-secret">{secret}</code>
            <p>
              In your authenticator, choose a time-based account, issuer HealthPass, and paste this
              key. Keep it private.
            </p>
          </div>
        )}
        {(me.mfaEnrolled || secret) && (
          <form onSubmit={submit}>
            <label>
              Authenticator code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                required
              />
            </label>
            <button className="hp-button primary" disabled={busy}>
              Verify and continue
            </button>
          </form>
        )}
        {error && (
          <p className="hp-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="hp-text-button"
          onClick={async () => {
            await careApi("/auth/logout", "POST", {});
            await onSuccess();
          }}
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
