import { useEffect, useState } from "react";
import { careApi } from "@/lib/healthpass-client";
type Settings = {
  organization: { name: string; workspace_code: string };
  branches: { id: string; name: string; address: string }[];
  members: {
    id: string;
    name: string;
    email: string;
    role: string;
    active: number;
    verified: number;
    branch_id: string | null;
    profession: string;
    registration_number: string;
  }[];
};
export function WorkspaceSettings() {
  const [data, setData] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function load() {
    setData(await careApi("/workspace/settings"));
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
              Share this code with your team. They select Professional under Sign in. A code
              identifies the workspace; it never grants access by itself.
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
            </section>
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
                    <span className={`hp-chip ${m.active && m.verified ? "teal" : "amber"}`}>
                      {m.active && m.verified ? "Active" : "Awaiting approval"}
                    </span>
                  </p>
                  {m.role !== "administrator" && (
                    <>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void change(
                            "/workspace/members/" + m.id,
                            "PATCH",
                            Object.fromEntries(new FormData(e.currentTarget)),
                          );
                        }}
                      >
                        <label>
                          Role
                          <select name="role" defaultValue={m.role}>
                            <option value="reception">Reception / registration</option>
                            <option value="clinician">Clinical care professional</option>
                          </select>
                        </label>
                        <label>
                          Branch
                          <select name="branch_id" defaultValue={m.branch_id ?? ""} required>
                            <option value="">Choose branch</option>
                            {data.branches.map((b) => (
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
                            placeholder="Internal credential review reference"
                          />
                        </label>
                        <label className="hp-checkbox">
                          <input type="checkbox" name="verified" value="confirmed" required /> I
                          have reviewed identity and applicable professional credentials.
                        </label>
                        <button className="hp-button primary" disabled={busy}>
                          {m.active ? "Update access" : "Approve access"}
                        </button>
                      </form>
                      {m.active === 1 && (
                        <button
                          className="hp-text-button"
                          disabled={busy}
                          onClick={() =>
                            void change("/workspace/members/" + m.id, "PATCH", {
                              action: "suspend",
                            })
                          }
                        >
                          Suspend access
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </section>
          </div>
        </>
      )}
    </>
  );
}
