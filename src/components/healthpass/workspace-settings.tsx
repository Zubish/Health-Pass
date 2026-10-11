import {
  RoleManagement,
  type JobRole,
  type Permission,
  type RoleTemplate,
} from "./role-management";
import { StaffAccess, type StaffMember } from "./staff-access";
import { useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
type Settings = {
  organization: { name: string; workspace_code: string };
  branches: { id: string; name: string; address: string }[];
  members: StaffMember[];
  roles: JobRole[];
  permissionCatalog: Permission[];
  templates: RoleTemplate[];
  assignments: { membership_id: string; role_id: string }[];
};
export function WorkspaceSettings({
  permissions,
  userId,
}: {
  permissions: string[];
  userId: string;
}) {
  const can = (permission: string) => permissions.includes(permission);
  const [data, setData] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function load() {
    const settings = await careApi("/workspace/settings");
    settings.roles = settings.roles.map((role: any) => ({
      ...role,
      permissions: JSON.parse(role.permissions),
    }));
    setData(settings);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function change(path: string, method: "POST" | "PATCH", values: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await careApi(path, method, values);
      await load();
      setNotice("Workspace updated.");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="hp-heading">
        <div>
          <span className="hp-eyebrow">YOUR FACILITY</span>
          <h1>Workspace & branches</h1>
          <p>Manage your facility’s code, branches and approved care team.</p>
        </div>
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
      {!data ? (
        <p role="status">Loading workspace…</p>
      ) : (
        <>
          <section className="hp-panel hp-padded">
            <h2>{data.organization.name}</h2>
            <p>Workspace code</p>
            <code className="hp-workspace-code">{data.organization.workspace_code}</code>
            <p className="hp-fine">
              Share this code with your team. New staff choose Create account → Professional;
              existing staff select Professional under Sign in. A code identifies the workspace; it
              never grants access by itself.
            </p>
          </section>
          <div className="hp-sharing-grid">
            <section className="hp-panel hp-padded">
              <h2>Branches</h2>
              {data.branches.map((b) => (
                <div className="hp-grant" key={b.id}>
                  <div>
                    <strong>{b.name}</strong>
                    <p>{b.address || "Address not recorded"}</p>
                  </div>
                </div>
              ))}
              {can("branches.manage") && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const values = Object.fromEntries(new FormData(form));
                    void change("/workspace/branches", "POST", values).then((success) => {
                      if (success) form.reset();
                    });
                  }}
                >
                  <label>
                    New branch name
                    <input name="name" required maxLength={160} />
                  </label>
                  <label>
                    Address
                    <input name="address" maxLength={500} />
                  </label>
                  <button className="hp-button primary" disabled={busy}>
                    Add branch
                  </button>
                </form>
              )}
            </section>
            {can("staff.manage") && (
              <section className="hp-panel hp-padded">
                <h2>Care team</h2>
                <p className="hp-fine">
                  Review identity and applicable professional credentials before approval. Clinical
                  membership is separate from workspace administration.
                </p>
                {data.members.map((m) => (
                  <div className="hp-member-card" key={m.id}>
                    <strong>{m.name}</strong>
                    <p>{m.email}</p>
                    <small>
                      {m.profession || m.role}
                      {m.registration_number ? ` · ${m.registration_number}` : ""}
                    </small>
                    <p>
                      <span
                        className={`hp-chip ${m.active && m.verified && !(m.access_expires_at && Date.parse(m.access_expires_at) <= Date.now()) ? "teal" : "amber"}`}
                      >
                        {m.access_expires_at && Date.parse(m.access_expires_at) <= Date.now()
                          ? "Access expired"
                          : m.active && m.verified
                            ? "Active"
                            : m.verified
                              ? "Suspended"
                              : "Awaiting approval"}
                      </span>
                    </p>
                    {m.access_expires_at && (
                      <p className="hp-fine">
                        Access expiry: {new Date(m.access_expires_at).toLocaleString()}
                      </p>
                    )}
                    <p className="hp-fine">
                      {data.assignments
                        .filter((a) => a.membership_id === m.id)
                        .map((a) => data.roles.find((r) => r.id === a.role_id)?.name)
                        .filter(Boolean)
                        .join(" · ") || "No job roles assigned"}
                    </p>
                    {m.is_owner === 1 && (
                      <p className="hp-fine">Workspace creator · administration access retained.</p>
                    )}
                    {m.user_id === userId ? (
                      <p className="hp-fine">
                        Another authorised administrator must review changes to your own job roles
                        and clinical authority.
                      </p>
                    ) : (
                      <StaffAccess
                        key={
                          JSON.stringify([
                            m.id,
                            m.active,
                            m.verified,
                            m.branch_id,
                            m.review_reference,
                            m.clinical_review_reference,
                            m.access_expires_at,
                          ]) +
                          data.assignments
                            .filter((a) => a.membership_id === m.id)
                            .map((a) => a.role_id)
                            .join("")
                        }
                        member={m}
                        roles={data.roles}
                        catalog={data.permissionCatalog}
                        assignments={data.assignments
                          .filter((a) => a.membership_id === m.id)
                          .map((a) => a.role_id)}
                        branches={data.branches}
                        busy={busy}
                        save={change}
                      />
                    )}
                  </div>
                ))}
              </section>
            )}
          </div>
          {can("roles.manage") && (
            <RoleManagement
              roles={data.roles}
              catalog={data.permissionCatalog}
              templates={data.templates}
              busy={busy}
              save={change}
            />
          )}
        </>
      )}
    </>
  );
}
