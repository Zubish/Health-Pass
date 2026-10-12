import { useState } from "react";
export type JobRole = {
  id: string;
  name: string;
  description: string;
  template_key: string | null;
  clinical_scope: string | null;
  permissions: string[];
  active: number;
};
export type Permission = { key: string; label: string; category: string };
export type RoleTemplate = {
  key: string;
  name: string;
  description: string;
  clinical_scope: string | null;
  permissions: string[];
};
export const scopeNames: Record<string, string> = {
  general: "General practice",
  nursing: "Nursing / midwifery",
  medication: "Medication review",
};
export function RoleManagement({
  roles,
  catalog,
  templates,
  busy,
  save,
}: {
  roles: JobRole[];
  catalog: Permission[];
  templates: RoleTemplate[];
  busy: boolean;
  save: (path: string, method: "POST" | "PATCH", values: unknown) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<JobRole | null>(null),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [template, setTemplate] = useState(""),
    [scope, setScope] = useState("general"),
    [permissions, setPermissions] = useState<string[]>([]),
    [active, setActive] = useState(true);
  const clinical = permissions.some((key) =>
    catalog.some((p) => p.key === key && p.category === "clinical"),
  );
  const support = template === "zed-support";
  function choose(role?: JobRole) {
    setEditing(role ?? null);
    setName(role?.name ?? "");
    setDescription(role?.description ?? "");
    setTemplate(role?.template_key ?? "");
    setScope(role?.clinical_scope ?? "general");
    setPermissions(role?.permissions ?? []);
    setActive(role?.active !== 0);
  }
  function toggle(key: string, checked: boolean) {
    const dependencies: Record<string, string> = {
      "careteam.view": "registry.view",
      "areas.manage": "workspace.view",
      "referrals.create": "records.view",
      "referrals.respond": "records.view",
      "registry.create": "registry.view",
      "visits.view": "registry.view",
      "visits.manage": "visits.view",
      "visits.document": "records.view",
      "observations.create": "records.view",
      "followups.manage": "records.view",
      "records.view": "registry.view",
      "profile.edit": "records.view",
      "notes.create": "records.view",
      "notes.edit": "records.view",
      "notes.sign": "records.view",
      "notes.amend": "records.view",
      "audit.manage": "audit.view",
      "roles.manage": "workspace.view",
      "staff.manage": "workspace.view",
      "branches.manage": "workspace.view",
    };
    setPermissions((previous) => {
      if (!checked) {
        const removed = new Set([key]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const value of previous)
            if (removed.has(dependencies[value]) && !removed.has(value)) {
              removed.add(value);
              changed = true;
            }
        }
        return previous.filter((value) => !removed.has(value));
      }
      const next = new Set(previous);
      let value: string | undefined = key;
      while (value) {
        next.add(value);
        value = dependencies[value];
      }
      return [...next];
    });
  }
  return (
    <section className="hp-panel hp-padded hp-role-panel">
      <h2>Job roles & permissions</h2>
      <p className="hp-fine">
        Start with a common role or create your own. Permissions apply only to tools available in
        HealthPass. Clinical authority requires a separate professional credential review. New
        permissions are available here for administrator review; existing role choices and
        individual restrictions are preserved.
      </p>
      <div className="hp-role-list">
        {roles.map((role) => (
          <div className="hp-grant" key={role.id}>
            <div>
              <strong>{role.name}</strong>
              <p>{role.description}</p>
              <small>
                {!role.active
                  ? "Inactive"
                  : role.permissions.length
                    ? `${role.permissions.length} permissions`
                    : "Job title only · no app access"}
                {role.clinical_scope ? ` · ${scopeNames[role.clinical_scope]}` : ""}
              </small>
            </div>
            <button
              type="button"
              className="hp-button secondary"
              disabled={busy}
              onClick={() => choose(role)}
            >
              Edit {role.name}
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="hp-text-button" disabled={busy} onClick={() => choose()}>
        Add a new role
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(
            editing ? "/workspace/roles/" + editing.id : "/workspace/roles",
            editing ? "PATCH" : "POST",
            {
              name,
              description,
              template_key: template || undefined,
              clinical_scope: clinical ? scope : null,
              permissions,
              active,
            },
          ).then((success) => {
            if (success) choose();
          });
        }}
      >
        <h3>{editing ? `Edit ${editing.name}` : "Add job role"}</h3>
        {!editing && (
          <label>
            Start from a template
            <select
              aria-label="Start from a template"
              value={template}
              onChange={(e) => {
                const value = templates.find((t) => t.key === e.target.value);
                setTemplate(e.target.value);
                setName(value?.name ?? "");
                setDescription(value?.description ?? "");
                setScope(value?.clinical_scope ?? "general");
                setPermissions(value?.permissions ?? []);
              }}
            >
              <option value="">Custom role</option>
              {templates.map((t) => (
                <option value={t.key} key={t.key}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Role name
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Role description
          <textarea
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {["operational", "clinical"].map((category) => (
          <fieldset className="hp-permission-group" key={category}>
            <legend>
              {category === "clinical" ? "Clinical permissions" : "Operational permissions"}
            </legend>
            <div className="hp-permission-grid">
              {catalog
                .filter((p) => p.category === category)
                .map((p) => (
                  <label className="hp-permission-option" key={p.key}>
                    <input
                      type="checkbox"
                      checked={permissions.includes(p.key)}
                      disabled={busy || (support && p.key !== "workspace.view")}
                      onChange={(e) => toggle(p.key, e.target.checked)}
                    />
                    <span>{p.label}</span>
                  </label>
                ))}
            </div>
          </fieldset>
        ))}
        {clinical && (
          <label>
            Clinical scope
            <select
              aria-label="Clinical scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              {Object.entries(scopeNames).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
            <small>
              Members must have reviewed credentials for this scope. Role edits alone cannot
              establish that authority.
            </small>
          </label>
        )}
        {support && (
          <p className="hp-fine">
            Zed Tech support is limited to workspace information. Staff identity must be verified by
            Zed Tech, and facility approval must expire within 24 hours. Patient records are not
            included.
          </p>
        )}
        {editing && (
          <label className="hp-permission-option">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span>Role is active</span>
          </label>
        )}
        <p className="hp-fine">
          The workspace creator retains administration access. Prescribing, dispensing, payments and
          financial reports are not available permissions yet.
        </p>
        <button className="hp-button primary" disabled={busy}>
          {editing ? "Save role changes" : "Add role"}
        </button>
      </form>
    </section>
  );
}
