import { useEffect, useRef, useState, type ReactNode } from "react";
import { careApi } from "@/lib/healthpass-client";
import { date } from "@/lib/healthpass-types";
import type { Me } from "@/lib/healthpass-types";
import type {
  AccessScope,
  ProfessionalAccessState,
  ProfessionalGrant,
  ProfessionalOptions,
} from "@/lib/healthpass-access-types";
import { Empty, Modal } from "./primitives";

const scopeNames: Record<AccessScope, string> = {
  general: "General care notes",
  nursing: "Nursing care notes",
  medication: "Medication review notes",
  laboratory: "Laboratory requests and results",
  radiology: "Imaging requests and reports",
};
const allScopes: AccessScope[] = ["general", "nursing", "medication", "laboratory", "radiology"];
function Choice({
  children,
  checked,
  onChange,
  disabled = false,
  required = false,
}: {
  children: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        minHeight: 44,
        padding: "8px 0",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        required={required}
        style={{ width: 18, height: 18, flexShrink: 0, marginTop: 3 }}
      />
      <span>{children}</span>
    </label>
  );
}
function useAccess(patientId?: string) {
  const [data, setData] = useState<ProfessionalAccessState>({ restricted: false, grants: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const path = `/professional-access${patientId ? `?patient_id=${encodeURIComponent(patientId)}` : ""}`;
  async function reload() {
    const next = await careApi<ProfessionalAccessState>(path);
    setData(next);
    setReady(true);
    setError("");
  }
  useEffect(() => {
    let current = true;
    setLoading(true);
    setReady(false);
    setError("");
    careApi<ProfessionalAccessState>(path)
      .then((next) => {
        if (current) {
          setData(next);
          setReady(true);
        }
      })
      .catch((e) => {
        if (current) {
          setError(e.message);
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [path]);
  return { data, error, setError, loading, ready, reload };
}
export function PatientProfessionalAccess({
  onChanged,
}: { onChanged?: (restricted: boolean) => void } = {}) {
  const { data, error, setError, loading, ready, reload } = useAccess();
  useEffect(() => {
    if (ready) {
      onChanged?.(data.restricted);
    }
  }, [ready, data.restricted, onChanged]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function revoke(grant: ProfessionalGrant) {
    if (
      !window.confirm(
        grant.parent_id
          ? "Revoke this professional’s future access? Existing care records remain saved."
          : "Revoke this professional and any delegated access? Existing care records remain saved; facility access will not be restored.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await careApi(`/professional-access/${grant.id}/revoke`, "POST", {});
      await reload();
      setNotice("Future access revoked. Your care records remain saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="hp-panel hp-padded">
      <h2>Choose your professionals</h2>
      <button
        className="hp-button secondary"
        disabled={busy || loading}
        onClick={() => {
          setBusy(true);
          void reload()
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        Refresh access
      </button>
      <p className="hp-muted">
        Choose who may read your signed care records and whether they may contribute or share access
        with another reviewed professional.
      </p>
      {loading ? (
        <p role="status">Loading professional access…</p>
      ) : !ready ? (
        <div>
          <p className="hp-error" role="alert">
            {error || "Your access settings are unavailable."}
          </p>
          <button
            className="hp-button secondary"
            onClick={() => {
              void reload().catch((e) => setError(e.message));
            }}
          >
            Retry access settings
          </button>
        </div>
      ) : (
        <>
          <div className="hp-notice">
            <strong>
              {data.restricted
                ? "Only selected professionals: On"
                : "Current access: facility-based"}
            </strong>
            <p>
              {data.restricted
                ? "Only effective named grants permit future clinical access. Revoking the last grant keeps this protection on."
                : "Your existing facility access stays in place until you deliberately grant access to a selected professional and enable this protection."}
            </p>
            <p>
              Registration and arrival details remain available to permitted facility staff. Earlier
              records remain saved.
            </p>
          </div>
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
          <GrantForm
            restricted={data.restricted}
            onSaved={async () => {
              onChanged?.(true);
              setNotice(
                "Professional access saved. Only selected professionals can access your clinical record.",
              );
              try {
                await reload();
              } catch {
                setError(
                  "Access was saved, but history could not be refreshed. Use Refresh access to check it.",
                );
              }
            }}
          />
          <h3>Professional access history</h3>
          <GrantList grants={data.grants} busy={busy} onRevoke={revoke} patient />
        </>
      )}
    </section>
  );
}
export function ProfessionalAccess({
  patientId,
  me,
  onChanged,
}: {
  patientId: string;
  me: Me;
  onChanged?: () => void | Promise<void>;
}) {
  const { data, error, setError, loading, ready, reload } = useAccess(patientId);
  const [selected, setSelected] = useState<ProfessionalGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function changed() {
    await reload();
    await onChanged?.();
  }
  async function revoke(grant: ProfessionalGrant) {
    if (
      !window.confirm(
        "Revoke this delegated professional’s future access? Existing care records remain saved.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await careApi(`/professional-access/${grant.id}/revoke`, "POST", {});
      await changed();
      setNotice("Delegated access revoked.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const roots = data.grants.filter(
    (g) =>
      !g.parent_id &&
      g.recipient_user_id === me.user.id &&
      g.status === "active" &&
      g.allow_delegation &&
      g.can_delegate === true,
  );
  return (
    <section className="hp-panel hp-padded">
      <h2>Professional sharing</h2>
      <button
        className="hp-button secondary"
        disabled={busy || loading}
        onClick={() => {
          setBusy(true);
          void changed()
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        Refresh access
      </button>
      <p className="hp-muted">
        Patient-approved sharing does not transfer a colleague’s draft, note authorship or visit
        assignment.
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
        <p role="status">Loading access…</p>
      ) : !ready ? (
        <button
          className="hp-button secondary"
          onClick={() => {
            void reload().catch((e) => setError(e.message));
          }}
        >
          Retry access settings
        </button>
      ) : (
        <>
          <p className="hp-fine">
            {data.restricted
              ? "This patient permits clinical access only through selected professional grants."
              : "This patient currently uses facility-based access. The patient decides whether to enable named-professional access."}
          </p>
          <GrantList grants={data.grants} busy={busy} onRevoke={revoke} />
          {roots.map((g) => (
            <button
              key={g.id}
              className="hp-button secondary"
              disabled={busy}
              onClick={() => setSelected(g)}
            >
              Share permitted access · {g.scopes.map((s) => scopeNames[s]).join(", ")}
            </button>
          ))}
        </>
      )}
      {selected && (
        <Modal title="Share patient-approved access" onClose={() => setSelected(null)}>
          <GrantForm
            parent={selected}
            patientId={patientId}
            initialCode={me.organization?.workspace_code}
            restricted
            onSaved={async () => {
              setSelected(null);
              setNotice("Delegated access saved within the patient’s limits.");
              try {
                await changed();
              } catch {
                setError(
                  "Access was saved, but history could not be refreshed. Use Refresh access to check it.",
                );
              }
            }}
          />
        </Modal>
      )}
    </section>
  );
}
function GrantList({
  grants,
  busy,
  onRevoke,
  patient = false,
}: {
  grants: ProfessionalGrant[];
  busy: boolean;
  onRevoke: (grant: ProfessionalGrant) => void;
  patient?: boolean;
}) {
  return !grants.length ? (
    <Empty
      title="No named-professional grants"
      text={
        patient
          ? "Check a facility’s code to choose a reviewed professional."
          : "The patient has not given you named access to share."
      }
    />
  ) : (
    <div>
      {grants.map((g) => (
        <div key={g.id} className="hp-grant" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 240px", minWidth: 0, overflowWrap: "anywhere" }}>
            <strong>{g.recipient_name}</strong>
            <p>
              {g.facility_name}
              {g.branch_name ? ` · ${g.branch_name}` : " · Workspace-wide professional"}
            </p>
            <p>
              {g.scopes.map((s) => scopeNames[s]).join(", ")}
              {g.include_profile ? " · Clinical profile included" : " · Clinical profile excluded"}
            </p>
            <small>
              {g.can_contribute ? "Read and contribute within reviewed scope" : "Read only"}
              {g.allow_delegation
                ? g.allow_external_delegation
                  ? " · Delegation within or outside the facility allowed"
                  : " · Delegation within this facility allowed"
                : " · No further delegation"}
            </small>
            <p>{g.purpose}</p>
            {g.parent_id && (
              <small>Delegated by {g.grantor_name || "the patient’s selected professional"}</small>
            )}
            <p className="hp-fine">Expires {date(g.expires_at)}</p>
          </div>
          <span className={`hp-chip ${g.status === "active" ? "teal" : "neutral"}`}>
            {g.status}
          </span>
          {!g.revoked_at && (patient || (g.parent_id && g.can_revoke)) && (
            <button className="hp-text-button" disabled={busy} onClick={() => onRevoke(g)}>
              Revoke access
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
function GrantForm({
  parent,
  patientId,
  initialCode,
  restricted,
  onSaved,
}: {
  parent?: ProfessionalGrant;
  patientId?: string;
  initialCode?: string;
  restricted: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const [workspaceCode, setWorkspaceCode] = useState(initialCode ?? "");
  const [professionalName, setProfessionalName] = useState("");
  const [options, setOptions] = useState<ProfessionalOptions | null>(null);
  const [recipient, setRecipient] = useState("");
  const [scopes, setScopes] = useState<AccessScope[]>([]);
  const [profile, setProfile] = useState(false);
  const [contribute, setContribute] = useState(false);
  const [delegation, setDelegation] = useState(false);
  const [external, setExternal] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [days, setDays] = useState("7");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ id: string; payload: string; expires: string } | null>(null);
  const permittedScopes = parent?.scopes ?? allScopes;
  const maxExpiry = parent ? Date.parse(parent.expires_at) : Date.now() + 90 * 86400000;
  async function checkFacility() {
    setBusy(true);
    setError("");
    setOptions(null);
    setRecipient("");
    try {
      const query = new URLSearchParams({ workspace_code: workspaceCode.trim() });
      if (professionalName.trim()) {
        query.set("search", professionalName.trim());
      }
      if (patientId) {
        query.set("patient_id", patientId);
      }
      setOptions(await careApi(`/professional-access/options?${query}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!options) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const fields = {
        recipient_user_id: recipient,
        recipient_organization_id: options.facility.id,
        scopes: [...scopes].sort(),
        include_profile: profile,
        can_contribute: contribute,
        ...(!parent
          ? {
              allow_delegation: delegation,
              allow_external_delegation: delegation && external,
              acknowledge_restriction: true,
            }
          : {}),
        purpose: purpose.trim(),
        days,
      };
      const payload = JSON.stringify(fields);
      if (!attempt.current || attempt.current.payload !== payload) {
        attempt.current = {
          id: crypto.randomUUID(),
          payload,
          expires: new Date(
            Math.min(Date.now() + Number(days) * 86400000, maxExpiry),
          ).toISOString(),
        };
      }
      const { days: unused, ...body } = fields;
      void unused;
      await careApi(
        parent ? `/professional-access/${parent.id}/delegate` : "/professional-access",
        "POST",
        { ...body, expires_at: attempt.current.expires, client_request_id: attempt.current.id },
      );
      setRecipient("");
      setScopes([]);
      setProfile(false);
      setContribute(false);
      setDelegation(false);
      setExternal(false);
      setPurpose("");
      setAcknowledged(false);
      attempt.current = null;
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {parent && (
        <div className="hp-notice">
          <strong>The patient’s delegation limits</strong>
          <p>
            Expires no later than {date(parent.expires_at)}.{" "}
            {parent.allow_external_delegation
              ? "Another participating facility may be selected."
              : "Choose a professional in your current facility only."}
          </p>
          <p>Delegated access cannot be delegated again.</p>
        </div>
      )}
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void checkFacility();
        }}
      >
        <label>
          Facility workspace code
          <input
            required
            disabled={busy}
            maxLength={80}
            value={workspaceCode}
            placeholder="HP-…"
            onChange={(e) => {
              setWorkspaceCode(e.target.value);
              setOptions(null);
              setRecipient("");
            }}
          />
        </label>
        <label>
          Professional name (optional)
          <input
            disabled={busy}
            maxLength={160}
            value={professionalName}
            placeholder="Refine the list by name"
            onChange={(event) => {
              setProfessionalName(event.target.value);
              setOptions(null);
              setRecipient("");
            }}
          />
        </label>
        <button className="hp-button secondary" disabled={busy || !workspaceCode.trim()}>
          Check professionals
        </button>
      </form>
      {options && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="hp-notice">
            <strong>{options.facility.name}</strong>
          </p>
          <label>
            {parent ? "Share with professional" : "Selected professional"}
            <select
              disabled={busy}
              required
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            >
              <option value="">Choose a reviewed professional</option>
              {options.professionals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.branch_name || "Workspace-wide"}
                </option>
              ))}
            </select>
          </label>
          {!options.professionals.length && (
            <p className="hp-notice">
              No eligible reviewed professionals are available in this facility.
            </p>
          )}
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>Signed care records to share</legend>
            {permittedScopes.map((scope) => (
              <Choice
                key={scope}
                disabled={busy}
                checked={scopes.includes(scope)}
                onChange={(value) =>
                  setScopes((previous) =>
                    value ? [...previous, scope] : previous.filter((s) => s !== scope),
                  )
                }
              >
                {scopeNames[scope]}
              </Choice>
            ))}
          </fieldset>
          <Choice
            checked={profile}
            disabled={busy || (!!parent && !parent.include_profile)}
            onChange={setProfile}
          >
            Include clinical profile (allergies and emergency contact)
          </Choice>
          <Choice
            checked={contribute}
            disabled={busy || (!!parent && !parent.can_contribute)}
            onChange={setContribute}
          >
            Allow new care contributions within this professional’s reviewed scope
          </Choice>
          {!parent && (
            <>
              <Choice
                checked={delegation}
                disabled={busy}
                onChange={(value) => {
                  setDelegation(value);
                  if (!value) {
                    setExternal(false);
                  }
                }}
              >
                Allow this professional to share the same or narrower access with another reviewed
                professional
              </Choice>
              <Choice checked={external} disabled={busy || !delegation} onChange={setExternal}>
                Allow that sharing with professionals at other participating facilities
              </Choice>
            </>
          )}
          <p className="hp-fine">
            Access includes whole signed notes and their versions in the selected categories.
            Sensitive lines within a shared note are not redacted. Drafts remain author-private.
            Contribution does not permit rewriting another professional’s signed record.
          </p>
          <label>
            Purpose
            <input
              required
              disabled={busy}
              maxLength={500}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="For example: follow-up consultation"
            />
          </label>
          <label>
            Access duration
            <select disabled={busy} value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              {!parent && <option value="90">90 days</option>}
            </select>
          </label>
          {parent && (
            <p className="hp-fine">
              The selected duration is capped at the patient’s original expiry:{" "}
              {date(parent.expires_at)}.
            </p>
          )}
          {!parent && !restricted && (
            <Choice checked={acknowledged} disabled={busy} onChange={setAcknowledged} required>
              I understand this enables Only selected professionals. Existing facility registration
              and broad sharing will no longer permit clinical access unless I select that
              professional. This protection stays on after revocation.
            </Choice>
          )}
          <button
            className="hp-button primary"
            disabled={
              busy || !recipient || !scopes.length || (!parent && !restricted && !acknowledged)
            }
          >
            {busy
              ? "Saving access…"
              : parent
                ? "Share permitted access"
                : restricted
                  ? "Grant professional access"
                  : "Enable selected access and grant"}
          </button>
        </form>
      )}
    </div>
  );
}
