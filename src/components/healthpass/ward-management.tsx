import { useCallback, useEffect, useState, type FormEvent } from "react";
import { careApi } from "@/lib/healthpass-client";
import { useSuccessFeedback } from "@/lib/healthpass-preferences";
import { date } from "@/lib/healthpass-types";
import { Modal } from "./primitives";

type Named = { id: string; name: string };
type Area = Named & {
  branch_id: string;
  department_id: string | null;
  kind: string;
  capabilities: string[];
};
type Unit = Named & {
  care_area_id: string;
  parent_id: string | null;
  kind: string;
  active: number;
  version: number;
};
type Admission = {
  id: string;
  patient_name: string;
  healthpass_id: string;
  care_area_id: string;
  branch_id: string;
  unit_id: string | null;
  version: number;
  team: { user_id: string; name: string; duty: string }[];
};
type Summary = {
  canConfigure: boolean;
  branches: Named[];
  departments: (Named & { branch_id: string })[];
  areas: Area[];
  units: Unit[];
  staff: {
    id: string;
    user_id: string;
    name: string;
    branch_id: string | null;
    ward_assignment_required: number;
  }[];
  grants: {
    id: string;
    user_id: string;
    user_name?: string;
    branch_id: string;
    department_id: string | null;
    capabilities: string;
    version: number;
  }[];
  assignments: {
    id: string;
    user_id: string;
    user_name: string;
    care_area_id: string;
    unit_id: string | null;
    duty: string;
    version: number;
  }[];
  admissions: Admission[];
  history: {
    action: string;
    object_id: string;
    payload: string;
    created_at: string;
    actor_name: string;
  }[];
};
const controls = [
  { key: "areas", label: "Manage wards, rooms and beds" },
  { key: "staff", label: "Assign doctor and nurse coverage" },
  { key: "placement", label: "Place and transfer admitted patients" },
  { key: "teams", label: "Assign inpatient care-team members" },
];
export function WardManagement() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [branchId, setBranchId] = useState("");
  const [areaId, setAreaId] = useState("");
  const [dialog, setDialog] = useState<{ kind: string; id?: string } | null>(null);
  const [targetArea, setTargetArea] = useState("");
  const success = useSuccessFeedback();
  const load = useCallback(async () => {
    const next = await careApi<Summary>("/ward-management");
    setData(next);
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  async function save(path: string, method: "POST" | "PATCH", values: unknown) {
    setBusy(true);
    setError("");
    try {
      const result = await careApi<{ id?: string }>(path, method, values);
      if (path === "/ward-management/areas" && result.id) {
        setAreaId(result.id);
      }
      await load();
      setDialog(null);
      success("Changes saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const submit =
    (path: string, method: "POST" | "PATCH", extra: Record<string, unknown> = {}) =>
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const fields = new FormData(e.currentTarget);
      void save(path, method, {
        ...Object.fromEntries(fields),
        ...extra,
        ...(fields.has("capabilities") ? { capabilities: fields.getAll("capabilities") } : {}),
        ...(fields.has("active") ? { active: fields.get("active") === "true" } : {}),
      });
    };
  if (!data) {
    return (
      <section className="hp-panel hp-padded">
        <h1>Ward & department management</h1>
        <p role={error ? "alert" : "status"}>{error || "Loading your management scope…"}</p>
      </section>
    );
  }
  const branch = branchId || data.branches[0]?.id || "";
  const areas = data.areas.filter((a) => a.branch_id === branch);
  const selected = areas.find((a) => a.id === areaId) || areas[0];
  const units = data.units
    .filter((u) => u.care_area_id === selected?.id)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const staff = data.staff.filter((s) => !s.branch_id || s.branch_id === branch);
  const departments = data.departments.filter((d) => d.branch_id === branch);
  const unitName = (id: string | null) => data.units.find((u) => u.id === id)?.name || "Whole ward";
  const manage = (cap: string) => selected?.capabilities.includes(cap);
  const grant = data.grants.find((g) => g.id === dialog?.id);
  const unit = units.find((u) => u.id === dialog?.id);
  const admission = data.admissions.find((a) => a.id === dialog?.id);
  const target = targetArea || admission?.care_area_id || selected?.id || "";
  const activeUnits = data.units.filter((u) => u.care_area_id === target && u.active);
  const branchCanCreate =
    data.canConfigure ||
    data.grants.some(
      (g) =>
        g.branch_id === branch && !g.department_id && JSON.parse(g.capabilities).includes("areas"),
    );
  const open = (kind: string, id?: string) => {
    setError("");
    setTargetArea("");
    setDialog({ kind, id });
  };
  const reason = (
    <label>
      Reason
      <textarea name="reason" required maxLength={500} />
    </label>
  );
  const staffSelect = (
    <label>
      Professional
      <select aria-label="Professional" name="user_id" required>
        <option value="">Choose professional</option>
        {staff.map((s) => (
          <option key={s.user_id} value={s.user_id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
  const dutySelect = (
    <label>
      Duty
      <select aria-label="Duty" name="duty">
        <option value="doctor">Doctor</option>
        <option value="nurse">Nurse</option>
      </select>
    </label>
  );
  const unitSelect = (list: Unit[], empty: string) => (
    <label>
      Room or bed
      <select aria-label="Room or bed" name="unit_id">
        <option value="">{empty}</option>
        {list.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
            {u.kind === "bed" ? " · Bed" : " · Room"}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="hp-ward-management">
      <header className="hp-page-heading">
        <h1>Ward & department management</h1>
        <p>Manage your locations, coverage and inpatient placement.</p>
      </header>
      {error && !dialog && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      <div className="hp-panel hp-padded">
        <div className="hp-form-grid">
          <label>
            Branch
            <select
              value={branch}
              onChange={(e) => {
                setBranchId(e.target.value);
                setAreaId("");
              }}
            >
              {data.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ward or care area
            <select
              aria-label="Ward or care area"
              value={selected?.id || ""}
              onChange={(e) => setAreaId(e.target.value)}
            >
              <option value="" disabled>
                Choose area
              </option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="hp-inline-actions">
          {branchCanCreate && (
            <button className="hp-button secondary" onClick={() => open("department")}>
              Add department
            </button>
          )}
          {departments.length > 0 && (
            <button className="hp-button secondary" onClick={() => open("area")}>
              Add care area
            </button>
          )}
          {data.canConfigure && (
            <button className="hp-button secondary" onClick={() => open("manager")}>
              Assign manager or head
            </button>
          )}
          {selected && data.canConfigure && (
            <button className="hp-text-button" onClick={() => open("link")}>
              Set department for {selected.name}
            </button>
          )}
        </div>
        {selected && (
          <p className="hp-fine">
            {departments.find((d) => d.id === selected.department_id)?.name ||
              "Department not yet assigned"}{" "}
            · {selected.kind}
          </p>
        )}
      </div>
      {data.grants.length > 0 && (
        <section className="hp-panel hp-padded">
          <h2>Managers & department heads</h2>
          {data.grants
            .filter((g) => g.branch_id === branch)
            .map((g) => (
              <div className="hp-grant" key={g.id}>
                <div>
                  <strong>{g.user_name || "Your management assignment"}</strong>
                  <p>
                    {g.department_id
                      ? departments.find((d) => d.id === g.department_id)?.name
                      : "Branch manager"}
                  </p>
                  <p className="hp-fine">
                    {controls
                      .filter((c) => JSON.parse(g.capabilities).includes(c.key))
                      .map((c) => c.label)
                      .join(" · ")}
                  </p>
                </div>
                {data.canConfigure && (
                  <div className="hp-inline-actions">
                    <button className="hp-text-button" onClick={() => open("controls", g.id)}>
                      Edit controls
                    </button>
                    <button className="hp-text-button" onClick={() => open("revoke", g.id)}>
                      Remove assignment
                    </button>
                  </div>
                )}
              </div>
            ))}
        </section>
      )}
      {selected && (
        <>
          <section className="hp-panel hp-padded">
            <div className="hp-panel-heading">
              <h2>{selected.name}: rooms & beds</h2>
              {manage("areas") && selected.kind !== "outpatient" && (
                <button className="hp-button secondary" onClick={() => open("units")}>
                  Add rooms or beds
                </button>
              )}
            </div>
            {!units.length && <p>No rooms or beds yet. Add named units to track occupancy.</p>}
            <div className="hp-ward-unit-grid">
              {units.map((u) => {
                const occupant = data.admissions.find((a) => a.unit_id === u.id);
                return (
                  <article className="hp-panel hp-padded" key={u.id}>
                    <strong>{u.name}</strong>
                    <p>
                      {u.kind}
                      {u.parent_id ? ` · ${unitName(u.parent_id)}` : ""}
                    </p>
                    <span className="hp-chip neutral">
                      {!u.active
                        ? "Closed"
                        : occupant
                          ? "Occupied"
                          : data.units.some((b) => b.parent_id === u.id && b.active)
                            ? "Contains beds"
                            : "Available"}
                    </span>
                    {occupant && <p>{occupant.patient_name}</p>}
                    {manage("areas") && (
                      <button className="hp-text-button" onClick={() => open("unit", u.id)}>
                        Edit unit
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
          <section className="hp-panel hp-padded">
            <div className="hp-panel-heading">
              <h2>Doctor & nurse coverage</h2>
              {manage("staff") && (
                <button className="hp-button secondary" onClick={() => open("staff")}>
                  Assign coverage
                </button>
              )}
            </div>
            <p className="hp-fine">
              Assigned staff work only with inpatients in their allocated wards or units. Clinical
              permissions, individual restrictions and patient sharing still apply.
            </p>
            {data.assignments
              .filter((s) => s.care_area_id === selected.id)
              .map((s) => (
                <div className="hp-grant" key={s.id}>
                  <div>
                    <strong>{s.user_name}</strong>
                    <p>
                      {s.duty} · {unitName(s.unit_id)}
                    </p>
                  </div>
                  {manage("staff") && (
                    <button className="hp-text-button" onClick={() => open("remove", s.id)}>
                      Remove coverage
                    </button>
                  )}
                </div>
              ))}
            {data.canConfigure && staff.some((s) => s.ward_assignment_required) && (
              <details>
                <summary>Administrator: restore normal care-area scope</summary>
                <p className="hp-fine">
                  Removing coverage leaves the person restricted. Use this only when they should
                  return to their existing role and care-area permissions, including outpatient
                  work.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    void save(`/ward-management/staff/${f.get("user_id")}/unrestrict`, "POST", {
                      reason: f.get("reason"),
                    });
                  }}
                >
                  {staffSelect}
                  {reason}
                  <button className="hp-button secondary" disabled={busy}>
                    Restore normal scope
                  </button>
                </form>
              </details>
            )}
          </section>
          {(manage("placement") || manage("teams")) && (
            <section className="hp-panel hp-padded">
              <h2>Admitted patients</h2>
              <p className="hp-fine">
                Open the care episode under Admissions & care teams first. Placement does not
                replace a physician’s admission or discharge decision.
              </p>
              {data.admissions
                .filter((a) => a.care_area_id === selected.id)
                .map((a) => (
                  <div className="hp-grant" key={a.id}>
                    <div>
                      <strong>{a.patient_name}</strong>
                      <p>
                        {a.healthpass_id} ·{" "}
                        {a.unit_id ? unitName(a.unit_id) : "Awaiting room / bed"}
                      </p>
                      {a.team.map((t) => (
                        <p className="hp-fine" key={t.user_id}>
                          {t.name} · {t.duty}
                          {manage("teams") && (
                            <button
                              className="hp-text-button"
                              onClick={() => open("team-remove", `${a.id}:${t.user_id}`)}
                            >
                              Remove from team
                            </button>
                          )}
                        </p>
                      ))}
                    </div>
                    <div className="hp-inline-actions">
                      {manage("placement") && (
                        <button className="hp-button secondary" onClick={() => open("place", a.id)}>
                          Place / transfer
                        </button>
                      )}
                      {manage("teams") && (
                        <button className="hp-button secondary" onClick={() => open("team", a.id)}>
                          Assign care team
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </section>
          )}
        </>
      )}
      <section className="hp-panel hp-padded">
        <h2>Management history</h2>
        {data.history.slice(0, 30).map((h, i) => (
          <div className="hp-grant" key={`${h.created_at}:${i}`}>
            <div>
              <strong>{h.action.replace("ward.", "").replaceAll("_", " ")}</strong>
              <p>
                {h.actor_name} · {date(h.created_at)}
              </p>
              {JSON.parse(h.payload).reason && <p>{JSON.parse(h.payload).reason}</p>}
            </div>
          </div>
        ))}
      </section>
      {dialog && (
        <Modal
          title={
            {
              controls: "Edit delegated controls",
              department: "Add department",
              area: "Add care area",
              manager: "Assign manager or department head",
              link: "Set department",
              units: "Create rooms or beds",
              unit: "Edit unit",
              staff: "Assign ward coverage",
              place: "Place or transfer patient",
              team: "Assign care-team member",
              revoke: "Remove manager assignment",
              remove: "Remove coverage",
              "team-remove": "Remove care-team member",
            }[dialog.kind] || "Update"
          }
          onClose={() => {
            if (!busy) {
              setDialog(null);
            }
          }}
        >
          {error && (
            <p className="hp-error" role="alert">
              {error}
            </p>
          )}
          {dialog.kind === "controls" && grant && (
            <form
              onSubmit={submit(`/ward-management/grants/${grant.id}`, "PATCH", {
                version: grant.version,
              })}
            >
              <p>{grant.user_name}</p>
              <fieldset>
                <legend>Delegated controls</legend>
                {controls.map((c) => (
                  <label className="hp-permission-option" key={c.key}>
                    <input
                      type="checkbox"
                      name="capabilities"
                      value={c.key}
                      defaultChecked={JSON.parse(grant.capabilities).includes(c.key)}
                    />
                    <span>{c.label}</span>
                  </label>
                ))}
              </fieldset>
              {reason}
              <button className="hp-button primary" disabled={busy}>
                Save controls
              </button>
            </form>
          )}
          {dialog.kind === "department" && (
            <form onSubmit={submit("/ward-management/departments", "POST", { branch_id: branch })}>
              <label>
                Department name
                <input name="name" required maxLength={100} />
              </label>
              <button className="hp-button primary" disabled={busy}>
                Create department
              </button>
            </form>
          )}
          {dialog.kind === "area" && (
            <form onSubmit={submit("/ward-management/areas", "POST")}>
              <label>
                Department
                <select aria-label="Management scope" name="department_id" required>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Area name
                <input name="name" required maxLength={100} placeholder="Female ward" />
              </label>
              <label>
                Type
                <select aria-label="Type" name="kind">
                  <option value="ward">Inpatient ward</option>
                  <option value="observation">Observation</option>
                  <option value="outpatient">Outpatient</option>
                </select>
              </label>
              <label>
                Initial room or bed count
                <input name="quantity" type="number" min={0} max={100} defaultValue={0} />
              </label>
              <label>
                Initial unit type
                <select aria-label="Initial unit type" name="unit_kind">
                  <option value="room">Rooms</option>
                  <option value="bed">Beds</option>
                </select>
              </label>
              <p className="hp-fine">
                Enter 10 to create ten named units now. Leave zero for outpatient areas or add units
                later.
              </p>
              <button className="hp-button primary" disabled={busy}>
                Create care area
              </button>
            </form>
          )}
          {dialog.kind === "manager" && (
            <form onSubmit={submit("/ward-management/grants", "POST", { branch_id: branch })}>
              {staffSelect}
              <label>
                Management scope
                <select aria-label="Management scope" name="department_id">
                  <option value="">Whole branch — branch manager</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} — department head
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>Delegated controls</legend>
                {controls.map((c) => (
                  <label className="hp-permission-option" key={c.key}>
                    <input type="checkbox" name="capabilities" value={c.key} />
                    <span>{c.label}</span>
                  </label>
                ))}
              </fieldset>
              {reason}
              <button className="hp-button primary" disabled={busy}>
                Assign management access
              </button>
            </form>
          )}
          {dialog.kind === "link" && selected && (
            <form onSubmit={submit(`/ward-management/areas/${selected.id}/department`, "POST")}>
              <label>
                Department
                <select aria-label="Management scope" name="department_id" required>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              {reason}
              <button className="hp-button primary" disabled={busy}>
                Save department
              </button>
            </form>
          )}
          {dialog.kind === "units" && selected && (
            <form
              onSubmit={submit("/ward-management/units", "POST", { care_area_id: selected.id })}
            >
              <label>
                Unit type
                <select aria-label="Type" name="kind">
                  <option value="room">Rooms</option>
                  <option value="bed">Beds</option>
                </select>
              </label>
              <label>
                Inside room (beds only)
                <select aria-label="Inside room (beds only)" name="parent_id">
                  <option value="">Directly in ward</option>
                  {units
                    .filter((u) => u.kind === "room" && u.active)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Quantity
                <input name="quantity" type="number" min={1} max={100} defaultValue={10} required />
              </label>
              <label>
                Name prefix
                <input name="prefix" defaultValue="Room" required maxLength={80} />
              </label>
              <p className="hp-fine">
                For example: Room 1–Room 10. Names can be changed individually. Use a distinct
                prefix for beds in each room.
              </p>
              <button className="hp-button primary" disabled={busy}>
                Create units
              </button>
            </form>
          )}
          {dialog.kind === "unit" && unit && (
            <form
              onSubmit={submit(`/ward-management/units/${unit.id}`, "PATCH", {
                version: unit.version,
              })}
            >
              <label>
                Unit name
                <input name="name" required defaultValue={unit.name} />
              </label>
              <label>
                Status
                <select
                  aria-label="Status"
                  name="active"
                  defaultValue={unit.active ? "true" : "false"}
                >
                  <option value="true">Open</option>
                  <option value="false">Closed</option>
                </select>
              </label>
              {reason}
              <button className="hp-button primary" disabled={busy}>
                Save unit
              </button>
            </form>
          )}
          {dialog.kind === "staff" && selected && (
            <form
              onSubmit={submit("/ward-management/staff", "POST", { care_area_id: selected.id })}
            >
              {staffSelect}
              {dutySelect}
              {unitSelect(
                units.filter((u) => u.active),
                "Whole ward",
              )}
              <p className="hp-fine">
                This starts inpatient-only coverage restrictions for this person. Assign every ward
                or room they need. Removing the last assignment does not restore unrestricted
                access.
              </p>
              {reason}
              <button className="hp-button primary" disabled={busy}>
                Assign coverage
              </button>
            </form>
          )}
          {dialog.kind === "place" && admission && (
            <form
              onSubmit={submit(`/ward-management/admissions/${admission.id}/place`, "POST", {
                version: admission.version,
                care_area_id: target,
              })}
            >
              <label>
                Ward
                <select
                  aria-label="Ward"
                  value={target}
                  onChange={(e) => setTargetArea(e.target.value)}
                >
                  {areas
                    .filter((a) => a.kind !== "outpatient" && a.capabilities.includes("placement"))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <div key={target}>
                {unitSelect(
                  activeUnits.filter(
                    (u) =>
                      !activeUnits.some((b) => b.parent_id === u.id) &&
                      !data.admissions.some((a) => a.id !== admission.id && a.unit_id === u.id),
                  ),
                  "Awaiting room / bed",
                )}
              </div>
              {reason}
              <button className="hp-button primary" disabled={busy}>
                Confirm placement
              </button>
            </form>
          )}
          {dialog.kind === "team" && admission && (
            <form
              onSubmit={submit(`/ward-management/admissions/${admission.id}/team`, "POST", {
                version: admission.version,
              })}
            >
              {staffSelect}
              {dutySelect}
              {reason}
              <button className="hp-button primary" disabled={busy}>
                Assign care-team member
              </button>
            </form>
          )}
          {["revoke", "remove", "team-remove"].includes(dialog.kind) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const values = Object.fromEntries(new FormData(e.currentTarget));
                if (dialog.kind === "revoke") {
                  const g = data.grants.find((g) => g.id === dialog.id)!;
                  void save(`/ward-management/grants/${g.id}/revoke`, "POST", {
                    ...values,
                    version: g.version,
                  });
                } else if (dialog.kind === "remove") {
                  const s = data.assignments.find((s) => s.id === dialog.id)!;
                  void save(`/ward-management/staff/${s.id}/remove`, "POST", {
                    ...values,
                    version: s.version,
                  });
                } else {
                  const [aid, uid] = dialog.id!.split(":");
                  const a = data.admissions.find((a) => a.id === aid)!;
                  void save(`/ward-management/admissions/${aid}/team`, "POST", {
                    ...values,
                    version: a.version,
                    user_id: uid,
                    action: "remove",
                  });
                }
              }}
            >
              {reason}
              <button className="hp-button primary" disabled={busy}>
                Confirm removal
              </button>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
