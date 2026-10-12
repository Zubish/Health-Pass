import { useState } from "react";
import type { CareArea } from "./individual-access";
export function CareAreaSettings({
  areas,
  branches,
  busy,
  save,
}: {
  areas: CareArea[];
  branches: { id: string; name: string }[];
  busy: boolean;
  save: (path: string, method: "POST" | "PATCH", values: unknown) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<CareArea | null>(null);
  return (
    <section className="hp-panel hp-padded">
      <h2>Departments & wards</h2>
      <p className="hp-fine">
        Create actual outpatient departments, inpatient wards and observation areas. These define
        staff location scope; they do not grant clinical permissions. An area’s type stays fixed;
        create another area when its purpose changes.
      </p>
      {areas.map((a) => (
        <div className="hp-grant" key={a.id}>
          <div>
            <strong>{a.name}</strong>
            <p>
              {a.kind} · {a.branch_name}
              {!a.active ? " · Archived" : ""}
            </p>
          </div>
          <button
            type="button"
            className="hp-button secondary"
            disabled={busy}
            onClick={() => setEditing(a)}
          >
            Edit {a.name}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="hp-text-button"
        disabled={busy}
        onClick={() => setEditing(null)}
      >
        Add a care area
      </button>
      <form
        key={editing?.id ?? "new"}
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const fields = Object.fromEntries(new FormData(form));
          void save(
            editing ? `/care-areas/${editing.id}` : "/care-areas",
            editing ? "PATCH" : "POST",
            { ...fields, ...(editing ? { active: fields.active === "confirmed" } : {}) },
          ).then((ok) => {
            if (ok) {
              setEditing(null);
              form.reset();
            }
          });
        }}
      >
        <h3>{editing ? `Edit ${editing.name}` : "Add care area"}</h3>
        <label>
          Area name
          <input name="name" required maxLength={100} defaultValue={editing?.name ?? ""} />
        </label>
        {!editing && (
          <>
            <label>
              Branch
              <select aria-label="Branch" name="branch_id" required>
                <option value="">Choose branch</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Care area type
              <select aria-label="Care area type" name="kind" required>
                <option value="outpatient">Outpatient department (OPD)</option>
                <option value="ward">Inpatient ward</option>
                <option value="observation">Observation area</option>
              </select>
            </label>
          </>
        )}
        {editing && (
          <>
            <label className="hp-permission-option">
              <input
                type="checkbox"
                name="active"
                value="confirmed"
                defaultChecked={!!editing.active}
              />
              <span>Care area is active</span>
            </label>
            <p className="hp-fine">
              Resolve active visits and admission episodes before archiving. Staff restricted to an
              archived area receive no access through that area until their scope is reviewed.
            </p>
          </>
        )}
        <button className="hp-button primary" disabled={busy}>
          {editing ? "Save care area" : "Add care area"}
        </button>
      </form>
    </section>
  );
}
