import { useState } from "react";
import { scopeNames, type JobRole, type Permission } from "./role-management";
export type StaffMember = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: string;
  active: number;
  verified: number;
  branch_id: string | null;
  profession: string;
  registration_number: string;
  is_owner: number;
  clinical_verified: number;
  clinical_review_reference: string;
  review_reference: string;
  access_expires_at: string | null;
  provider_support_verified: number;
};
export function StaffAccess({
  member,
  roles,
  catalog,
  assignments,
  branches,
  busy,
  save,
}: {
  member: StaffMember;
  roles: JobRole[];
  catalog: Permission[];
  assignments: string[];
  branches: { id: string; name: string }[];
  busy: boolean;
  save: (path: string, method: "POST" | "PATCH", values: unknown) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState(assignments);
  const selectedRoles = roles.filter((r) => selected.includes(r.id));
  const clinical = selectedRoles.some((r) =>
    r.permissions.some((key) => catalog.some((p) => p.key === key && p.category === "clinical")),
  );
  const support = selectedRoles.some((r) => r.template_key === "zed-support");
  const hasDisabledRole = selectedRoles.some((r) => !r.active);
  const expiry = member.access_expires_at
    ? new Date(
        Date.parse(member.access_expires_at) -
          new Date(member.access_expires_at).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  return (
    <details open={!member.active}>
      <summary>Manage access for {member.name}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget));
          void save("/workspace/members/" + member.id, "PATCH", {
            ...values,
            role_ids: selected,
            access_expires_at: values.access_expires_at
              ? new Date(String(values.access_expires_at)).toISOString()
              : null,
          });
        }}
      >
        <fieldset className="hp-permission-group">
          <legend>Job roles</legend>
          {roles
            .filter((r) => r.active || assignments.includes(r.id))
            .map((role) => (
              <label className="hp-permission-option" key={role.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(role.id)}
                  disabled={
                    busy ||
                    (!role.active && !selected.includes(role.id)) ||
                    (role.template_key === "zed-support" && !member.provider_support_verified)
                  }
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setSelected((previous) => {
                      if (!checked) return previous.filter((id) => id !== role.id);
                      if (role.template_key === "zed-support") return [role.id];
                      return [
                        ...previous.filter(
                          (id) => roles.find((r) => r.id === id)?.template_key !== "zed-support",
                        ),
                        role.id,
                      ];
                    });
                  }}
                />
                <span>
                  {role.name}
                  {!role.active ? " · Disabled" : ""}
                  {role.clinical_scope ? ` · ${scopeNames[role.clinical_scope]}` : ""}
                </span>
              </label>
            ))}
        </fieldset>
        {hasDisabledRole && (
          <p className="hp-notice" role="status">
            Remove disabled roles and choose an active role before updating access. Disabled roles
            grant no permissions.
          </p>
        )}
        <label>
          Branch
          <select
            aria-label="Branch"
            name="branch_id"
            required
            defaultValue={member.branch_id ?? ""}
          >
            <option value="">Choose branch</option>
            {branches.map((b) => (
              <option value={b.id} key={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Review reference
          <input
            name="review_reference"
            required
            maxLength={500}
            defaultValue={member.review_reference}
            placeholder="Staff identity review reference"
          />
        </label>
        <label className="hp-permission-option">
          <input type="checkbox" name="verified" value="confirmed" required />
          <span>I have reviewed this staff member’s identity.</span>
        </label>
        {clinical && (
          <>
            <label>
              Clinical credential review reference
              <input
                name="clinical_review_reference"
                required
                maxLength={500}
                defaultValue={member.clinical_review_reference}
                placeholder="Professional credentials and scope review"
              />
            </label>
            <label className="hp-permission-option">
              <input type="checkbox" name="clinical_verified" value="confirmed" required />
              <span>
                I have reviewed the professional credentials and confirmed they authorise the
                selected clinical scopes.
              </span>
            </label>
          </>
        )}
        <label>
          Access expires {support ? "(required within 24 hours)" : "(optional)"}
          <input
            name="access_expires_at"
            type="datetime-local"
            defaultValue={expiry}
            required={support}
          />
        </label>
        {support && (
          <p className="hp-fine">
            Zed Tech verifies support staff identity separately. This grant is time-limited and
            cannot include patient information or other roles.
          </p>
        )}
        {selected.length > 0 && selectedRoles.every((r) => !r.permissions.length) && (
          <p className="hp-notice">
            These are job titles only. This member will not have access to app tools until
            permissions are assigned.
          </p>
        )}
        <button
          className="hp-button primary"
          disabled={busy || !selected.length || hasDisabledRole}
        >
          {member.active ? "Update access" : "Approve access"}
        </button>
      </form>
      {member.active === 1 && !member.is_owner && (
        <button
          type="button"
          className="hp-text-button"
          disabled={busy}
          onClick={() =>
            void save("/workspace/members/" + member.id, "PATCH", { action: "suspend" })
          }
        >
          Suspend access
        </button>
      )}
    </details>
  );
}
