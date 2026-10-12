import { useState } from "react";
import type { Permission } from "./role-management";
export type CareArea = {
  id: string;
  name: string;
  branch_id: string;
  branch_name?: string;
  kind: string;
  active: number;
};
export function IndividualAccess({
  member,
  areas,
  catalog,
  busy,
  save,
}: {
  member: {
    id: string;
    name: string;
    branch_id: string | null;
    denied_permissions?: string;
    care_area_restricted?: number;
    care_area_ids?: string;
    access_policy_version?: number;
  };
  areas: CareArea[];
  catalog: Permission[];
  busy: boolean;
  save: (path: string, method: "POST" | "PATCH", values: unknown) => Promise<boolean>;
}) {
  const [denied, setDenied] = useState<string[]>(JSON.parse(member.denied_permissions || "[]"));
  const [restricted, setRestricted] = useState(!!member.care_area_restricted);
  const [selected, setSelected] = useState<string[]>(JSON.parse(member.care_area_ids || "[]"));
  const [reason, setReason] = useState("");
  const choices = areas.filter(
    (a) => a.active && (!member.branch_id || a.branch_id === member.branch_id),
  );
  const toggle = (values: string[], key: string, checked: boolean) =>
    checked ? [...new Set([...values, key])] : values.filter((v) => v !== key);
  return (
    <details className="hp-individual-access">
      <summary>Individual restrictions for {member.name}</summary>
      <p className="hp-fine">
        Role permissions are the starting point. Checked restrictions override every assigned role
        and stay in place when roles change. This screen cannot grant additional permissions.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(`/workspace/members/${member.id}/restrictions`, "PATCH", {
            denied_permissions: denied,
            care_area_restricted: restricted,
            care_area_ids: selected,
            reason,
            version: member.access_policy_version ?? 1,
          }).then((ok) => {
            if (ok) setReason("");
          });
        }}
      >
        <div className="hp-inline-actions">
          <button
            type="button"
            className="hp-button secondary"
            disabled={busy}
            onClick={() =>
              setDenied([
                ...new Set([
                  ...denied,
                  "notes.create",
                  "notes.edit",
                  "notes.sign",
                  "notes.amend",
                  "visits.document",
                  "observations.create",
                  "followups.manage",
                ]),
              ])
            }
          >
            Disable charting
          </button>
          <button
            type="button"
            className="hp-text-button"
            disabled={busy}
            onClick={() => setDenied([])}
          >
            Use role defaults
          </button>
        </div>
        <fieldset className="hp-permission-group">
          <legend>Disable these permissions for this professional</legend>
          <div className="hp-permission-grid">
            {catalog.map((p) => (
              <label className="hp-permission-option" key={p.key}>
                <input
                  type="checkbox"
                  checked={denied.includes(p.key)}
                  disabled={busy}
                  onChange={(e) => setDenied(toggle(denied, p.key, e.target.checked))}
                />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="hp-permission-option">
          <input
            type="checkbox"
            checked={restricted}
            disabled={busy}
            onChange={(e) => setRestricted(e.target.checked)}
          />
          <span>Limit this professional to selected departments or wards</span>
        </label>
        {restricted && (
          <fieldset className="hp-permission-group">
            <legend>Assigned care areas</legend>
            {choices.length ? (
              choices.map((a) => (
                <label className="hp-permission-option" key={a.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(a.id)}
                    disabled={busy}
                    onChange={(e) => setSelected(toggle(selected, a.id, e.target.checked))}
                  />
                  <span>
                    {a.name} · {a.kind}
                    {a.branch_name ? ` · ${a.branch_name}` : ""}
                  </span>
                </label>
              ))
            ) : (
              <p>Create departments or wards in this branch first.</p>
            )}
            <p className="hp-fine">
              Patient access requires a recorded active visit or admission in an assigned area. An
              active ward admission takes precedence over an earlier OPD visit. Unknown areas grant
              no access.
            </p>
          </fieldset>
        )}
        <label>
          Reason for this change
          <input
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Work duties or approved assignment; no clinical details"
          />
        </label>
        <button className="hp-button primary" disabled={busy || (restricted && !selected.length)}>
          Save individual restrictions
        </button>
      </form>
    </details>
  );
}
