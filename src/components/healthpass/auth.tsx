import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, ArrowRight, ShieldCheck, LockKeyhole } from "lucide-react";
import { careApi } from "@/lib/healthpass-client";
import type { Me } from "@/lib/healthpass-types";
import { Mark } from "./primitives";
import {
  readSigninPreference,
  rememberSigninWorkspace,
  workspaceSigninPath,
} from "@/lib/healthpass-signin";
export type AccountMode =
  "register" | "patient" | "professional" | "facility" | "professional-signin";
export function Auth({
  onSuccess,
  serviceError,
  initialMode,
  initialSetup,
  initialWorkspace,
  onModeChange,
  onForgetWorkspace,
}: {
  onSuccess: () => Promise<void>;
  serviceError: string;
  initialMode?: AccountMode;
  initialSetup?: boolean;
  initialWorkspace?: string;
  onModeChange: (mode?: AccountMode, setup?: boolean) => void;
  onForgetWorkspace: () => void;
}) {
  const [view, setView] = useState(initialMode ?? "signin");
  const [accountType, setAccountType] = useState(
    ["professional-signin", "professional", "facility"].includes(initialMode ?? "")
      ? "professional"
      : "patient",
  );
  const [workspaceCode, setWorkspaceCode] = useState(""),
    [confirmedWorkspace, setConfirmedWorkspace] = useState<{ code: string; name: string } | null>(
      null,
    ),
    [checkingWorkspace, setCheckingWorkspace] = useState(false);
  const workspaceCheck = useRef(0);
  const [rememberWorkspace, setRememberWorkspace] = useState(false);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    const saved = readSigninPreference();
    const code =
      initialWorkspace ||
      (initialMode === "professional-signin" ? saved?.workspaceCode : undefined);
    if (!code) return;
    setWorkspaceCode(code.trim().toUpperCase());
    setRememberWorkspace(saved?.workspaceCode === code.trim().toUpperCase());
    setRestoring(true);
    const attempt = ++workspaceCheck.current;
    let cancelled = false;
    void careApi<{ workspace: { name: string; workspace_code: string } }>(
      "/auth/workspace-check",
      "POST",
      { workspace_code: code },
    )
      .then(({ workspace }) => {
        if (!cancelled && attempt === workspaceCheck.current)
          setConfirmedWorkspace({ code: workspace.workspace_code, name: workspace.name });
      })
      .catch((e: Error) => {
        if (!cancelled && attempt === workspaceCheck.current) setError(e.message);
      })
      .finally(() => {
        if (!cancelled && attempt === workspaceCheck.current) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialWorkspace, initialMode]);
  const [firstAccess, setFirstAccess] = useState(!!initialSetup),
    [error, setError] = useState(serviceError),
    [busy, setBusy] = useState(false);
  const choosing = view === "register",
    patientCreate = view === "patient",
    facilityCreate = view === "facility";
  const staffSetup = view === "professional" || (view === "professional-signin" && firstAccess);
  const signin = !choosing && !patientCreate && !facilityCreate && !staffSetup;
  const needsWorkspace = staffSetup || (signin && accountType === "professional");
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
  async function checkWorkspace() {
    const attempt = ++workspaceCheck.current;
    setCheckingWorkspace(true);
    setConfirmedWorkspace(null);
    setError("");
    try {
      const result = await careApi<{ workspace: { name: string; workspace_code: string } }>(
        "/auth/workspace-check",
        "POST",
        { workspace_code: workspaceCode },
      );
      if (attempt === workspaceCheck.current)
        setConfirmedWorkspace({
          code: result.workspace.workspace_code,
          name: result.workspace.name,
        });
    } catch (e) {
      if (attempt === workspaceCheck.current) setError((e as Error).message);
    } finally {
      if (attempt === workspaceCheck.current) setCheckingWorkspace(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    if (
      needsWorkspace &&
      (!confirmedWorkspace || confirmedWorkspace.code !== workspaceCode.trim().toUpperCase())
    ) {
      setError("Check your workspace code and confirm the facility before continuing.");
      setBusy(false);
      return;
    }
    try {
      const path = patientCreate
        ? "/auth/register"
        : facilityCreate
          ? "/auth/facility-register"
          : staffSetup
            ? "/auth/workspace-register"
            : "/auth/login";
      await careApi(path, "POST", {
        ...values,
        account_type: needsWorkspace || facilityCreate ? "professional" : "patient",
      });
      if (signin && accountType === "professional") {
        rememberSigninWorkspace(rememberWorkspace ? confirmedWorkspace?.code : undefined);
      }
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
                    ? "Create your professional account"
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
                    ? "Confirm your facility’s workspace, then request access. Your administrator reviews your details before you can work."
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
                <strong>Professional</strong>
                <span>Work with your care team in your facility’s workspace.</span>
                <ArrowRight size={18} />
              </button>
              <button className="hp-account-option" onClick={() => change("facility")}>
                <strong>Facility</strong>
                <span>Create your facility workspace and branches.</span>
                <ArrowRight size={18} />
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
                {needsWorkspace && (
                  <div>
                    {restoring && <p role="status">Confirming your facility…</p>}
                    {!confirmedWorkspace && (
                      <label>
                        Workspace code
                        <input
                          name="workspace_code"
                          required
                          maxLength={80}
                          autoCapitalize="characters"
                          autoComplete="off"
                          placeholder="HP-…"
                          value={workspaceCode}
                          onChange={(e) => {
                            ++workspaceCheck.current;
                            setWorkspaceCode(e.target.value);
                            setConfirmedWorkspace(null);
                            setCheckingWorkspace(false);
                            setRestoring(false);
                            setError("");
                          }}
                        />
                        <small>
                          Provided by your facility administrator. Check the code to confirm where
                          you will work.
                        </small>
                      </label>
                    )}
                    {!confirmedWorkspace && (
                      <button
                        type="button"
                        className="hp-button secondary"
                        disabled={restoring || checkingWorkspace || !workspaceCode.trim() || busy}
                        onClick={() => void checkWorkspace()}
                      >
                        {checkingWorkspace ? "Checking workspace…" : "Check workspace"}
                      </button>
                    )}
                    {confirmedWorkspace && (
                      <div className="hp-notice" role="status">
                        <input
                          type="hidden"
                          name="workspace_code"
                          value={confirmedWorkspace.code}
                        />
                        <strong>{confirmedWorkspace.name}</strong>
                        <p>
                          {staffSetup
                            ? "You are requesting access to this facility."
                            : "You are signing in to this facility."}
                        </p>
                      </div>
                    )}
                    {confirmedWorkspace && (
                      <button
                        type="button"
                        className="hp-text-button"
                        disabled={busy}
                        onClick={() => {
                          ++workspaceCheck.current;
                          rememberSigninWorkspace();
                          setRememberWorkspace(false);
                          setConfirmedWorkspace(null);
                          setWorkspaceCode("");
                          setRestoring(false);
                          setCheckingWorkspace(false);
                          onForgetWorkspace();
                        }}
                      >
                        Use another workspace
                      </button>
                    )}
                    {confirmedWorkspace && (
                      <p className="hp-fine">
                        <a
                          href={workspaceSigninPath(
                            confirmedWorkspace.name,
                            confirmedWorkspace.code,
                          )}
                        >
                          Facility sign-in link
                        </a>
                      </p>
                    )}
                    {signin && (
                      <p className="hp-fine">
                        Created this facility? Sign in here with the email and password you used to
                        create its workspace.
                      </p>
                    )}
                    {staffSetup && (
                      <p className="hp-fine">
                        If your facility is not on HealthPass yet, its administrator can create a
                        Facility workspace first.
                      </p>
                    )}
                  </div>
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
                {signin && accountType === "professional" && (
                  <>
                    <label className="hp-permission-option">
                      <input
                        type="checkbox"
                        checked={rememberWorkspace}
                        onChange={(e) => setRememberWorkspace(e.target.checked)}
                      />
                      <span>Remember this workspace on this device</span>
                    </label>
                    <p className="hp-fine">
                      For 30 days. You still sign in with your password. Leave unchecked on shared
                      devices.
                    </p>
                  </>
                )}
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
                <button
                  className="hp-button primary"
                  disabled={busy || (needsWorkspace && !confirmedWorkspace)}
                >
                  {busy
                    ? "Please wait…"
                    : facilityCreate
                      ? "Create facility workspace"
                      : staffSetup
                        ? "Request access"
                        : patientCreate
                          ? "Create patient account"
                          : "Sign in"}
                  <ArrowRight size={16} />
                </button>
              </form>
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
          {needsWorkspace && (
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
    [dontShowAgain, setDontShowAgain] = useState(false),
    [code, setCode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function setup() {
    setBusy(true);
    setError("");
    try {
      const result = await careApi("/auth/mfa/setup", "POST", {});
      setSecret(result.secret);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function skip() {
    setBusy(true);
    setError("");
    try {
      await careApi("/auth/mfa/skip", "POST", { dont_show_again: dontShowAgain });
      await onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
        <h1>Authenticator protection is optional</h1>
        {me.organization && (
          <div className="hp-notice" role="status">
            <strong>{me.organization.name}</strong>
            <p>You are continuing into this facility’s workspace.</p>
            {me.organization.workspace_code && (
              <p>
                Workspace code: <strong>{me.organization.workspace_code}</strong>
              </p>
            )}
          </div>
        )}
        <p>
          {me.mfaEnrolled
            ? "Enter the six-digit code from your authenticator, or continue without it."
            : "Add an authenticator for extra protection, or continue to your workspace without setting it up."}
        </p>
        {!me.mfaEnrolled && !secret && (
          <button className="hp-button secondary" disabled={busy} onClick={setup}>
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
        <label className="hp-permission-option">
          <input
            type="checkbox"
            checked={dontShowAgain}
            disabled={busy}
            onChange={(e) => setDontShowAgain(e.target.checked)}
          />
          <span>Don't show this again</span>
        </label>
        <p className="hp-fine">Remember this choice for your account in this facility.</p>
        <button className="hp-button primary" disabled={busy} onClick={() => void skip()}>
          {busy ? "Please wait…" : "Continue"}
        </button>
        {error && (
          <p className="hp-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
