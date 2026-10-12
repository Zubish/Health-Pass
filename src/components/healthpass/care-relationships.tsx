import { useEffect, useState, useCallback } from "react";
import { careApi } from "@/lib/healthpass-client";
import { date, type Me } from "@/lib/healthpass-types";
import { Empty } from "./primitives";
type RequestRow = {
  id: string;
  facility_name: string;
  branch_name?: string;
  patient_name?: string;
  purpose?: string;
  status: string;
  expires_at: string;
  created_at: string;
};
type Primary = { organization_id: string; facility_name: string; source: string };
export function CareRelationships({ me }: { me: Me }) {
  const patient = !!me.user.patient_id,
    canRegister = me.permissions?.includes("registry.create"),
    canManage = me.permissions?.includes("primary.manage");
  const [requests, setRequests] = useState<RequestRow[]>([]),
    [primaryRequests, setPrimaryRequests] = useState<RequestRow[]>([]),
    [primary, setPrimary] = useState<Primary | null>(null),
    [first, setFirst] = useState<Primary | null>(null),
    [branches, setBranches] = useState<{ id: string; name: string }[]>([]),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [approved, setApproved] = useState<Record<string, boolean>>({}),
    [profiles, setProfiles] = useState<Record<string, boolean>>({});
  const branchId = me.branch?.id;
  const refresh = useCallback(async () => {
    const [access, care, workspace] = await Promise.all([
      patient || canRegister
        ? careApi("/facility-access-requests")
        : Promise.resolve({ requests: [] }),
      patient
        ? careApi("/primary-care")
        : canManage
          ? careApi("/primary-care/requests")
          : Promise.resolve({ requests: [] }),
      !patient && canRegister && !branchId
        ? careApi("/patient-registration-options")
        : Promise.resolve(null),
    ]);
    setRequests(access.requests);
    setPrimaryRequests(care.requests);
    if (patient) {
      setPrimary(care.primary);
      setFirst(care.first_registration);
    }
    if (workspace) setBranches(workspace.branches ?? []);
  }, [patient, canRegister, canManage, branchId]);
  useEffect(() => {
    let active = true;
    void refresh()
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const rowActions = (row: RequestRow, kind: "access" | "primary") => (
    <div className="hp-relationship-actions">
      {row.status === "pending" && (
        <>
          {((kind === "access" && patient) || (kind === "primary" && !patient)) && (
            <>
              {kind === "access" && (
                <label className="hp-check-row">
                  <input
                    type="checkbox"
                    checked={approved[row.id] ?? false}
                    onChange={(e) => setApproved({ ...approved, [row.id]: e.target.checked })}
                  />
                  <span>
                    Register me at this branch for care. Its approved care team can use my
                    demographic details and records they create, subject to my sharing restrictions.
                    This does not share other facilities’ history.
                  </span>
                </label>
              )}
              {kind === "access" && (
                <label className="hp-check-row">
                  <input
                    type="checkbox"
                    checked={profiles[row.id] ?? false}
                    onChange={(e) =>
                      setProfiles((current) => ({ ...current, [row.id]: e.target.checked }))
                    }
                  />
                  <span>
                    Also share my current allergy information and emergency contact with this
                    branch’s authorised care team, subject to my sharing restrictions.
                  </span>
                </label>
              )}
              <button
                className="hp-button primary"
                disabled={busy || (kind === "access" && !approved[row.id])}
                onClick={() =>
                  void act(
                    () =>
                      careApi(
                        kind === "access"
                          ? `/facility-access-requests/${row.id}/accept`
                          : `/primary-care/requests/${row.id}/accept`,
                        "POST",
                        {
                          acknowledge_registration: true,
                          share_profile: profiles[row.id] === true,
                        },
                      ),
                    kind === "access"
                      ? "Registration approved. Choose record-sharing permissions separately."
                      : "Primary care request accepted. Record permissions are unchanged.",
                  )
                }
              >
                {kind === "access" ? "Approve registration" : "Accept request"}
              </button>
              <button
                className="hp-button secondary"
                disabled={busy}
                onClick={() =>
                  void act(
                    () =>
                      careApi(
                        kind === "access"
                          ? `/facility-access-requests/${row.id}/decline`
                          : `/primary-care/requests/${row.id}/decline`,
                        "POST",
                        {},
                      ),
                    "Request declined.",
                  )
                }
              >
                Decline
              </button>
            </>
          )}
          {((kind === "access" && !patient) || (kind === "primary" && patient)) && (
            <button
              className="hp-button secondary"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    careApi(
                      kind === "access"
                        ? `/facility-access-requests/${row.id}/withdraw`
                        : `/primary-care/requests/${row.id}/withdraw`,
                      "POST",
                      {},
                    ),
                  "Request withdrawn.",
                )
              }
            >
              Withdraw request
            </button>
          )}
        </>
      )}
    </div>
  );
  return (
    <>
      <div className="hp-heading">
        <div>
          <span className="hp-eyebrow">CLEAR CARE RELATIONSHIPS</span>
          <h1>Care relationships</h1>
          <p>
            {patient
              ? "Manage facility registration requests and choose your primary care facility."
              : "Request patient registration and review primary care responsibilities."}
          </p>
        </div>
        <button
          className="hp-button secondary"
          disabled={busy || loading}
          onClick={() => void act(refresh, "Requests refreshed.")}
        >
          Refresh
        </button>
      </div>
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
      {loading && <p role="status">Loading care relationships…</p>}
      {!loading && (
        <div className="hp-relationship-grid">
          {patient && (
            <section className="hp-panel hp-padded">
              <h2>Primary care facility</h2>
              <p>{primary ? primary.facility_name : "No primary care facility selected."}</p>
              <p className="hp-muted">
                Primary status never grants access to your records. Use Sharing to choose
                facilities, professionals, record categories and expiry.
              </p>
              {primary && (
                <button
                  className="hp-button secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => careApi("/primary-care/clear", "POST", {}),
                      "Primary designation cleared. Existing sharing permissions are unchanged.",
                    )
                  }
                >
                  Remove primary designation
                </button>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void act(
                    () =>
                      careApi("/primary-care", "POST", {
                        workspace_code: data.get("workspace_code"),
                        acknowledge_no_access_grant: data.get("acknowledge") === "on",
                      }),
                    "Primary care selection saved. Facilities other than your first registering facility must accept the request.",
                  );
                }}
              >
                <label>
                  Facility workspace code
                  <input name="workspace_code" required maxLength={80} placeholder="HP-…" />
                </label>
                {first && (
                  <p className="hp-muted">
                    Your first registering facility, {first.facility_name}, does not need to accept
                    a new primary designation.
                  </p>
                )}
                <label className="hp-check-row">
                  <input name="acknowledge" type="checkbox" required />
                  <span>
                    I understand that this selection does not change record-sharing permissions. My
                    current primary facility remains until a replacement accepts.
                  </span>
                </label>
                <button className="hp-button primary" disabled={busy}>
                  Choose primary care facility
                </button>
              </form>
            </section>
          )}
          {!patient && canRegister && (
            <section className="hp-panel hp-padded">
              <h2>Request patient registration</h2>
              <p className="hp-muted">
                For a patient with an existing profile. Ask them to sign in to approve the request.
                Do not create another profile or infer identity from email alone.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void act(
                    () =>
                      careApi("/facility-access-requests", "POST", {
                        ...Object.fromEntries(data),
                        identity_confirmed: data.get("identity_confirmed") === "on",
                      }),
                    "Request submitted. Ask the patient to check Care relationships in their account.",
                  );
                }}
              >
                <label>
                  Patient email
                  <input name="email" type="email" required maxLength={254} />
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
                <label>
                  Purpose
                  <input
                    name="purpose"
                    required
                    maxLength={500}
                    placeholder="For example: registration for consultation"
                  />
                </label>
                <label>
                  Identity review reference
                  <input
                    name="review_reference"
                    required
                    maxLength={500}
                    placeholder="Review reference, without identity document numbers"
                  />
                </label>
                <label className="hp-check-row">
                  <input name="identity_confirmed" type="checkbox" required />
                  <span>
                    I checked the patient’s identity with them, and they supplied this email to
                    receive care here. Email matching alone is not an identity check.
                  </span>
                </label>
                <button className="hp-button primary" disabled={busy}>
                  Request access
                </button>
              </form>
            </section>
          )}
          {(patient || canRegister) && (
            <section className="hp-panel hp-padded">
              <h2>{patient ? "Facility registration requests" : "Registration request history"}</h2>
              <p className="hp-muted">
                Approval registers a care relationship. Older cross-facility records require
                separate sharing.
              </p>
              {!requests.length && (
                <Empty
                  title="No registration requests"
                  text="Facility requests will appear here."
                />
              )}
              {requests.map((row) => (
                <div className="hp-grant hp-relationship-row" key={row.id}>
                  <div>
                    <strong>{row.facility_name}</strong>
                    <p>{row.branch_name}</p>
                    <p>{row.purpose}</p>
                    <span className="hp-chip neutral">{row.status}</span>
                    <small>Expires {date(row.expires_at)}</small>
                    {rowActions(row, "access")}
                  </div>
                </div>
              ))}
            </section>
          )}
          {(patient || canManage) && (
            <section className="hp-panel hp-padded">
              <h2>{patient ? "Primary care request history" : "Primary care requests"}</h2>
              {!patient && (
                <p className="hp-muted">
                  Accepting confirms the facility’s primary care responsibility. It grants no
                  clinical record access.
                </p>
              )}
              {!primaryRequests.length && (
                <Empty
                  title="No primary care requests"
                  text="Pending decisions and their history will appear here."
                />
              )}
              {primaryRequests.map((row) => (
                <div className="hp-grant hp-relationship-row" key={row.id}>
                  <div>
                    <strong>{row.patient_name ?? row.facility_name}</strong>
                    <p>{row.facility_name}</p>
                    <span className="hp-chip neutral">{row.status}</span>
                    <small>Expires {date(row.expires_at)}</small>
                    {rowActions(row, "primary")}
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </>
  );
}

export function PatientRelationshipNotice({ onOpen }: { onOpen: () => void }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () =>
      void careApi("/facility-access-requests")
        .then((data) => {
          if (active)
            setCount(data.requests.filter((r: RequestRow) => r.status === "pending").length);
        })
        .catch(() => {});
    load();
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.removeEventListener("focus", load);
    };
  }, []);
  return count > 0 ? (
    <div className="hp-notice" role="status">
      <p>
        {count} facility registration {count === 1 ? "request needs" : "requests need"} your
        decision.
      </p>
      <button className="hp-button secondary" onClick={onOpen}>
        Review care requests
      </button>
    </div>
  ) : null;
}
