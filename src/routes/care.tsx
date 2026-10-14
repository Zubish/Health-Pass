import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  request,
  ApiError,
  type Session,
  type Workspace,
  type Item,
  type Analytics,
} from "@/components/care/api";

export const Route = createFileRoute("/care")({ component: Care });
const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
const buttonClass =
  "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const analyticsLabels: [keyof Analytics["metrics"], string][] = [
  ["prescription_count", "Prescriptions"],
  ["dispatched_prescription_count", "Sent to pharmacy"],
  ["acknowledged_prescription_count", "Pharmacy receipts acknowledged"],
  ["partially_dispensed_prescription_count", "Partially supplied prescriptions"],
  ["dispensed_prescription_count", "Fully supplied prescriptions"],
  ["cancelled_prescription_count", "Cancelled prescriptions"],
  ["pending_item_count", "Pending medicine items"],
];
function Field({
  label,
  name,
  type = "text",
  required = true,
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string | number;
}) {
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <input
        className={inputClass}
        name={name}
        type={type}
        step={type === "number" ? "any" : undefined}
        min={type === "number" ? 0 : undefined}
        required={required}
        defaultValue={defaultValue}
      />
    </label>
  );
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
function Care() {
  const [session, setSession] = useState<Session | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [patientId, setPatientId] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const [rai, setRai] = useState<Analytics | null>(null);
  useEffect(() => {
    let active = true;
    request<Session>("/session")
      .then(async (value) => {
        const data = await request<Workspace>("/workspace");
        if (active) {
          setSession(value);
          setWorkspace(data);
        }
      })
      .catch((e) => {
        if (active && (!(e instanceof ApiError) || e.status !== 401))
          setError(e instanceof Error ? e.message : "Workspace unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function mutate(path: string, body: unknown, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(path, "POST", body, session?.csrfToken);
      setWorkspace(await request<Workspace>("/workspace"));
      setNotice(message);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSession(null);
        setWorkspace(null);
        setRai(null);
      }
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const credentials = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await request("/auth/login", "POST", {
        email: credentials.get("email"),
        password: credentials.get("password"),
        otp: credentials.get("otp") || undefined,
      });
      const next = await request<Session>("/session");
      const nextWorkspace = await request<Workspace>("/workspace");
      setSession(next);
      setWorkspace(nextWorkspace);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }
  const provider =
    session?.user.role === "provider" ||
    session?.user.role === "prescriber" ||
    session?.user.role === "doctor";
  const patients = workspace?.patients ?? [];
  const encounters = (workspace?.encounters ?? []).filter((e) => e.patientId === patientId);
  async function createPrescription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const item: Item = {
      id: crypto.randomUUID(),
      name: String(f.get("name")),
      form: String(f.get("form")),
      strength: String(f.get("strength")),
      dose: Number(f.get("dose")),
      doseUnit: String(f.get("doseUnit")),
      route: String(f.get("route")),
      frequency: String(f.get("frequency")),
      duration: String(f.get("duration")),
      quantity: Number(f.get("quantity")),
      dispensingUnit: String(f.get("dispensingUnit")),
      instructions: String(f.get("instructions")),
      substitutionPolicy: String(f.get("substitutionPolicy")),
    };
    await mutate(
      "/prescriptions",
      {
        patientId,
        encounterId,
        validUntil: new Date(String(f.get("validUntil"))).toISOString(),
        items: [item],
      },
      "Prescription draft saved. Review before signing.",
    );
  }
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-5">
          <a href="/" className="font-display text-xl font-semibold text-primary">
            HealthPass
          </a>
          <h1 className="text-lg font-semibold">Care & prescriptions</h1>
          {session ? (
            <span className="text-sm">
              {session.user.name} · {session.user.role}
            </span>
          ) : null}
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-5 px-5 py-6">
        <p className="text-sm text-muted-foreground">
          HealthPass records care and sends authorized prescriptions to RxLedger. Pharmacy review
          and actual supply remain separate from prescribing. Clinical checks are unavailable;
          professional review is required.
        </p>
        {error ? (
          <div role="alert" className="rounded-lg border border-destructive p-3 text-destructive">
            {error}
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="rounded-lg bg-primary/5 p-3">
            {notice}
          </p>
        ) : null}
        {loading ? (
          <p role="status">Loading your secure workspace…</p>
        ) : !session ? (
          <Panel title="Sign in">
            <form onSubmit={login} className="grid max-w-md gap-4">
              <Field label="Email" name="email" type="email" />
              <Field label="Password" name="password" type="password" />
              <Field label="Authenticator code (when required)" name="otp" required={false} />
              <button disabled={busy} className={buttonClass}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <p className="text-sm text-muted-foreground">
                Accounts are provisioned by the participating care organization. Contact your
                administrator for access.
              </p>
            </form>
          </Panel>
        ) : (
          <>
            <div className="flex flex-wrap gap-3">
              <button
                className={buttonClass}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  request<Workspace>("/workspace")
                    .then(setWorkspace)
                    .catch((e) => {
                      if (e instanceof ApiError && e.status === 401) {
                        setSession(null);
                        setWorkspace(null);
                        setRai(null);
                      }
                      setError(e instanceof Error ? e.message : "Refresh failed.");
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Refresh status
              </button>
              <button
                className={buttonClass}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await request("/auth/logout", "POST", {}, session.csrfToken);
                    setSession(null);
                    setWorkspace(null);
                    setPatientId("");
                    setEncounterId("");
                    setRai(null);
                    setError("");
                    setNotice("");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Logout failed.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Sign out
              </button>
            </div>
            {provider ? (
              <div className="grid gap-5 md:grid-cols-2">
                <Panel title="Patient registration">
                  <form
                    className="grid gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void mutate("/patients", { name: f.get("name") }, "Patient registered.");
                    }}
                  >
                    <Field label="Patient name" name="name" />
                    <button disabled={busy} className={buttonClass}>
                      Register patient
                    </button>
                  </form>
                </Panel>
                <Panel title="Encounter">
                  <form
                    className="grid gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void mutate(
                        "/encounters",
                        { patientId, note: f.get("note") },
                        "Encounter draft saved.",
                      );
                    }}
                  >
                    <label className="grid gap-1 text-sm">
                      Patient
                      <select
                        required
                        className={inputClass}
                        value={patientId}
                        onChange={(e) => {
                          setPatientId(e.target.value);
                          setEncounterId("");
                        }}
                      >
                        <option value="">Choose patient</option>
                        {patients.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} · {p.healthPassId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-sm">
                      Encounter note
                      <textarea name="note" required className={inputClass} rows={3} />
                    </label>
                    <button disabled={busy || !patientId} className={buttonClass}>
                      Save encounter
                    </button>
                  </form>
                  {encounters.map((e) => (
                    <div key={e.id} className="mt-3 border-t pt-3 text-sm">
                      <p>{e.note}</p>
                      <p>
                        Status: {e.status} · version {e.version}
                      </p>
                      {e.status === "draft" ? (
                        <button
                          className={buttonClass}
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              `/encounters/${e.id}/sign`,
                              { version: e.version },
                              "Encounter signed.",
                            )
                          }
                        >
                          Sign encounter
                        </button>
                      ) : null}
                    </div>
                  ))}
                </Panel>
              </div>
            ) : null}
            {provider ? (
              <Panel title="Verified pharmacy patient link">
                <p className="mb-3 text-sm text-muted-foreground">
                  Establish the RxLedger partner identifier only after an authorized identity
                  review. Names and phone numbers never establish a link automatically.
                </p>
                <form
                  className="grid gap-3 sm:grid-cols-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void mutate(
                      `/patients/${patientId}/link`,
                      { patientLinkId: f.get("patientLinkId"), evidence: f.get("evidence") },
                      "Reviewed pharmacy patient link recorded.",
                    );
                  }}
                >
                  <Field label="RxLedger patient link ID" name="patientLinkId" />
                  <Field label="Identity review evidence" name="evidence" />
                  <button className={buttonClass} disabled={busy || !patientId}>
                    Record reviewed link for selected patient
                  </button>
                </form>
              </Panel>
            ) : null}
            <Panel title="Prescription sharing consent">
              <p className="mb-3 text-sm text-muted-foreground">
                Sharing covers the minimum prescription context needed by the configured RxLedger
                pharmacy. Consent can expire or be revoked.
              </p>
              {session.user.role === "patient" ? (
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void mutate(
                      "/consents",
                      {
                        patientId: session.user.patientId,
                        purpose: "prescription_fulfilment",
                        expiresAt: new Date(String(f.get("expiresAt"))).toISOString(),
                      },
                      "Sharing consent recorded.",
                    );
                  }}
                >
                  <Field label="Consent expires" name="expiresAt" type="datetime-local" />
                  <button disabled={busy} className={buttonClass}>
                    Allow prescription sharing
                  </button>
                </form>
              ) : (
                <p className="text-sm">Only the patient can grant or revoke consent.</p>
              )}
              {(workspace?.consents ?? []).map((c) => (
                <div
                  key={c.id}
                  className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm"
                >
                  <span>
                    {patients.find((p) => p.id === c.patientId)?.name ?? c.patientId} ·{" "}
                    {c.revokedAt
                      ? "Revoked"
                      : new Date(c.expiresAt) <= new Date()
                        ? "Expired"
                        : "Active"}{" "}
                    · expires {new Date(c.expiresAt).toLocaleString()}
                  </span>
                  {session.user.role === "patient" && !c.revokedAt ? (
                    <button
                      disabled={busy}
                      className={buttonClass}
                      onClick={() =>
                        void mutate(`/consents/${c.id}/revoke`, {}, "Consent revoked.")
                      }
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              ))}
            </Panel>
            {provider ? (
              <Panel title="Prescription composer">
                <p className="mb-3 text-sm">
                  One item per draft in this portal. Explicit units and instructions are required.
                </p>
                <form
                  onSubmit={createPrescription}
                  className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                >
                  <label className="grid gap-1 text-sm">
                    Signed encounter
                    <select
                      className={inputClass}
                      required
                      value={encounterId}
                      onChange={(e) => setEncounterId(e.target.value)}
                    >
                      <option value="">Choose signed encounter</option>
                      {encounters
                        .filter((e) => e.status === "signed")
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.id}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Field label="Valid until" name="validUntil" type="datetime-local" />
                  <Field label="Medicine name" name="name" />
                  <Field label="Dosage form" name="form" />
                  <Field label="Strength" name="strength" />
                  <Field label="Dose" name="dose" type="number" />
                  <Field label="Dose unit" name="doseUnit" />
                  <Field label="Route" name="route" />
                  <Field label="Frequency" name="frequency" />
                  <Field label="Duration" name="duration" />
                  <Field label="Quantity to supply" name="quantity" type="number" />
                  <Field label="Dispensing unit" name="dispensingUnit" />
                  <Field label="Instructions" name="instructions" />
                  <label className="grid gap-1 text-sm">
                    Substitution policy
                    <select name="substitutionPolicy" className={inputClass}>
                      <option value="not_permitted">Not permitted</option>
                      <option value="prescriber_approval_required">
                        Prescriber approval required
                      </option>
                    </select>
                  </label>
                  <button className={buttonClass} disabled={busy || !patientId || !encounterId}>
                    Save prescription draft
                  </button>
                </form>
              </Panel>
            ) : null}
            <Panel title="Prescriptions & pharmacy progress">
              {!workspace?.prescriptions.length ? (
                <p className="text-sm text-muted-foreground">
                  No prescriptions in your authorized scope.
                </p>
              ) : (
                workspace.prescriptions.map((p) => (
                  <article
                    key={p.prescriptionId}
                    className="mb-4 rounded-lg border border-border p-4"
                  >
                    <h3 className="font-semibold">
                      {patients.find((patient) => patient.id === p.patientId)?.name ??
                        "Prescription"}{" "}
                      · {p.prescriptionId}
                    </h3>
                    <p className="mt-1 text-sm">
                      Order: {p.orderStatus} · version {p.version}
                    </p>
                    <p className="text-sm">
                      Transport: {p.transport ?? "Not dispatched"} · Pharmacy review:{" "}
                      {p.review ?? "Awaiting review"} · Supply: {p.fulfilment ?? "Not reported"}
                    </p>
                    <ul className="my-3 grid gap-2 text-sm">
                      {p.items.map((i) => (
                        <li key={i.id}>
                          {i.name} {i.strength} · {i.dose} {i.doseUnit}, {i.route}, {i.frequency},{" "}
                          {i.duration}
                          <br />
                          Ordered: {i.quantity} {i.dispensingUnit} · {i.instructions}
                          <span>
                            {" "}
                            · Supplied: {p.dispensed[i.id] ?? 0}; pending:{" "}
                            {Math.max(0, i.quantity - (p.dispensed[i.id] ?? 0))} {i.dispensingUnit}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                      Prescription orders do not prove supply; supply does not prove medicine was
                      taken.
                    </p>
                    {provider ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {p.orderStatus === "draft" ? (
                          <button
                            className={buttonClass}
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                `/prescriptions/${p.prescriptionId}/sign`,
                                { version: p.version },
                                "Prescription signed.",
                              )
                            }
                          >
                            Sign reviewed prescription
                          </button>
                        ) : null}
                        {p.orderStatus === "active" ? (
                          <button
                            className={buttonClass}
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                `/prescriptions/${p.prescriptionId}/dispatch`,
                                { version: p.version },
                                "Prescription queued for pharmacy delivery.",
                              )
                            }
                          >
                            Send to RxLedger
                          </button>
                        ) : null}
                        {p.orderStatus !== "cancelled" ? (
                          <button
                            className={buttonClass}
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                `/prescriptions/${p.prescriptionId}/cancel`,
                                { version: p.version },
                                "Cancellation recorded; previously supplied quantities remain in the record.",
                              )
                            }
                          >
                            Cancel order
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {p.events?.length ? (
                      <details className="mt-3 text-sm">
                        <summary>Pharmacy event history</summary>
                        <ul>
                          {p.events.map((e, index) => (
                            <li key={e.eventId ?? index}>
                              {e.eventType} · {e.occurredAt ?? "Time unavailable"}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </article>
                ))
              )}
              {provider ? (
                <button
                  className={buttonClass}
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      "/integrations/rxledger/deliver",
                      {},
                      "Delivery attempts processed. Refresh and review each prescription for acknowledgement or failures.",
                    )
                  }
                >
                  Retry queued pharmacy deliveries
                </button>
              ) : null}
            </Panel>
            {provider ? (
              <Panel title="Rai · operational analytics">
                <p className="mb-3 text-sm text-muted-foreground">
                  Rai receives authorized aggregate metrics only. It cannot sign, prescribe or
                  change records.
                </p>
                <form
                  className="grid gap-3 sm:grid-cols-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    setBusy(true);
                    setError("");
                    try {
                      const result = await request<Analytics>(
                        "/rai/analytics",
                        "POST",
                        {
                          message: f.get("message"),
                          startDate: f.get("startDate"),
                          endDate: f.get("endDate"),
                        },
                        session.csrfToken,
                      );
                      setRai(result);
                    } catch (e) {
                      setRai(null);
                      if (e instanceof ApiError && e.status === 401) {
                        setSession(null);
                        setWorkspace(null);
                      }
                      setError(
                        e instanceof Error
                          ? e.message
                          : "Rai unavailable. Core care workflows remain available.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Field label="From" name="startDate" type="date" />
                  <Field label="To" name="endDate" type="date" />
                  <Field label="Question" name="message" />
                  <button disabled={busy} className={buttonClass}>
                    Ask Rai
                  </button>
                </form>
                {rai ? (
                  <div className="mt-4 grid gap-4">
                    <p className="text-sm">
                      Reporting period: {rai.scope.date_range.start_date} to{" "}
                      {rai.scope.date_range.end_date}
                    </p>
                    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {analyticsLabels.map(([key, label]) => (
                        <div key={key} className="rounded-lg border border-border p-3">
                          <dt className="text-sm text-muted-foreground">{label}</dt>
                          <dd className="mt-1 text-2xl font-semibold">{rai.metrics[key]}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="text-sm text-muted-foreground">
                      These counts describe prescription workflow, not unique patients, medicine
                      taken or clinical outcomes.
                    </p>
                    {rai.explanation_status === "unavailable" || !rai.explanation ? (
                      <p role="status" className="text-sm">
                        Rai's explanation is unavailable. The verified metrics above remain
                        available.
                      </p>
                    ) : (
                      <div className="rounded-lg bg-secondary p-4">
                        <h3 className="font-semibold">
                          Supplementary explanation · requires review
                        </h3>
                        <p className="mt-2 whitespace-pre-wrap text-sm">{rai.explanation}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Use the metrics above for authoritative numerical values.
                        </p>
                      </div>
                    )}
                  </div>
                ) : null}
              </Panel>
            ) : null}
            <Panel title="Access & activity history">
              <ul className="grid gap-2 text-sm">
                {(workspace?.audit ?? [])
                  .slice(-30)
                  .reverse()
                  .map((a) => (
                    <li key={a.id}>
                      {a.action} · {a.createdAt ?? a.occurredAt ?? "Time unavailable"}
                    </li>
                  ))}
              </ul>
            </Panel>
          </>
        )}
      </div>
    </main>
  );
}
