import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, ArrowRight, ShieldCheck, LockKeyhole } from "lucide-react";
import { careApi } from "@/lib/healthpass-client";
import type { Me } from "@/lib/healthpass-types";
import { Mark } from "./primitives";
export function Auth({
  onSuccess,
  serviceError,
}: {
  onSuccess: () => Promise<void>;
  serviceError: string;
}) {
  const [register, setRegister] = useState(false),
    [error, setError] = useState(serviceError),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      await careApi(register ? "/auth/register" : "/auth/login", "POST", values);
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
          <Mark /> HealthPass
        </a>
        <div>
          <span className="hp-eyebrow">CONTINUITY OF CARE</span>
          <h1>
            A familiar place.
            <br />A fuller picture.
          </h1>
          <p>
            One patient identity. A connected care history. Access that stays in the right hands.
          </p>
          <div className="hp-story-card">
            <ShieldCheck />
            <div>
              <strong>Care with context</strong>
              <p>Patient-controlled sharing and a clear record of who accessed your information.</p>
            </div>
          </div>
        </div>
        <span className="hp-ecosystem">
          HealthPass <span>·</span> RxLedger <span>·</span> Rai
        </span>
      </section>
      <section className="hp-login-form">
        <a href="/" className="hp-back">
          <ArrowLeft size={16} /> Back to HealthPass
        </a>
        <div className="hp-auth-card">
          <span className="hp-icon-tile teal">
            <LockKeyhole />
          </span>
          <h2>{register ? "Create your patient account" : "Welcome back"}</h2>
          <p>
            {register
              ? "Start with your identity. Add your care history with your care team."
              : "Sign in to your patient or facility workspace."}
          </p>
          <form onSubmit={submit}>
            {register && (
              <>
                <label>
                  Full name
                  <input name="name" autoComplete="name" required maxLength={160} />
                </label>
                <label>
                  Date of birth <small>Optional; leave blank if unknown</small>
                  <input name="dob" type="date" max={new Date().toISOString().slice(0, 10)} />
                </label>
              </>
            )}
            <label>
              Email address
              <input type="email" name="email" autoComplete="email" required />
            </label>
            <label>
              Password
              <input
                type="password"
                name="password"
                autoComplete={register ? "new-password" : "current-password"}
                required
                minLength={register ? 12 : undefined}
                maxLength={256}
              />
            </label>
            {error && (
              <div className="hp-error" role="alert">
                {error}
              </div>
            )}
            <button className="hp-button primary" disabled={busy}>
              {busy ? "Please wait…" : register ? "Create account" : "Sign in"}
              <ArrowRight size={16} />
            </button>
          </form>
          <button
            className="hp-text-button"
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register ? "Already registered? Sign in" : "New patient? Create an account"}
          </button>
          <p className="hp-fine">
            Professional accounts are provisioned and verified by the facility. Contact your
            administrator for access.
          </p>
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
