import { useNavigate, useSearch } from "@tanstack/react-router";
import { WorkspaceSettings } from "./workspace-settings";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardList,
  FileHeart,
  History,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Stethoscope,
  Users,
  X,
} from "lucide-react";
import { careApi } from "@/lib/healthpass-client";
import { date } from "@/lib/healthpass-types";
import type { Me, Patient, Encounter, AccessScope } from "@/lib/healthpass-types";
import { Mark, Stat, PatientRow, Empty, Modal } from "./primitives";
import { NoteEditor, EncounterCard } from "./encounters";
import { PatientLinking, FacilityLinking } from "./patient-linking";
import { Visits } from "./visits";
import { PatientProfessionalAccess, ProfessionalAccess } from "./professional-access";
export function CareWorkspace({ me, onLogout }: { me: Me; onLogout: () => Promise<void> }) {
  const search = useSearch({ from: "/workspace" });
  const navigate = useNavigate({ from: "/workspace" });
  const can = (permission: string) => me.permissions?.includes(permission) ?? false;
  const tab =
    search.tab ?? (can("workspace.view") ? "workspace" : can("visits.view") ? "today" : "overview");
  const selected = search.patient ?? null;
  const setTab = (next: string) => {
    void navigate({ search: { tab: next } });
  };
  const setSelected = (id: string | null) => {
    void navigate({ search: { tab: "patients", patient: id ?? undefined } });
  };
  const [patients, setPatients] = useState<Patient[]>([]),
    [chart, setChart] = useState<{
      patient: Patient;
      encounters: Encounter[];
      accessScope: AccessScope;
    } | null>(null),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [register, setRegister] = useState(false),
    [linkExisting, setLinkExisting] = useState(false),
    [noteVisit, setNoteVisit] = useState<{ id: string; patient_id: string } | null>(null),
    [noteRequestKey, setNoteRequestKey] = useState(""),
    [editing, setEditing] = useState<Encounter | "new" | null>(null),
    [profile, setProfile] = useState(false),
    [audit, setAudit] = useState<any[]>([]),
    [consents, setConsents] = useState<any[]>([]),
    [accessRestricted, setAccessRestricted] = useState<boolean | null>(null),
    [organizations, setOrganizations] = useState<any[]>([]),
    [health, setHealth] = useState("");
  const isPatient = me.role === "patient",
    canRegister = can("registry.create"),
    canRegistry = can("registry.view") || isPatient,
    canChart = can("records.view") || isPatient;
  const nav = isPatient
    ? ([
        ["overview", "My health", LayoutDashboard],
        ["patients", "My record", FileHeart],
        ["sharing", "Sharing", ShieldCheck],
        ["audit", "Access history", History],
      ] as const)
    : ([
        ...(can("visits.view") ? [["today", "Today's work", ClipboardList] as const] : []),
        ["overview", "Overview", LayoutDashboard],
        ...(can("workspace.view") ? [["workspace", "Workspace & branches", Users] as const] : []),
        ...(canRegistry ? [["patients", "Patient registry", Users] as const] : []),
        ...(can("audit.view") ? [["audit", "Activity & audit", History] as const] : []),
      ] as const);
  async function loadRegistry() {
    if (canRegistry) {
      const data = await careApi("/patients");
      setPatients(data.patients);
    }
  }
  async function loadChart(id: string) {
    setBusy(true);
    setError("");
    try {
      setChart(await careApi(`/patients/${id}`));
      if (selected !== id) setSelected(id);
    } catch (e) {
      setChart(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadTab(next: string) {
    setError("");
    if (tab !== next) setTab(next);
    try {
      if (next === "audit") setAudit((await careApi("/audit")).audits);
      if (next === "sharing") {
        const [sharing, facilities] = await Promise.all([
          careApi("/consents"),
          careApi("/organizations"),
        ]);
        setConsents(sharing.consents);
        setAccessRestricted((current) => current === true || sharing.restricted);
        setOrganizations(facilities.organizations);
      }
      if (next === "patients" && isPatient && me.user.patient_id)
        await loadChart(me.user.patient_id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void careApi("/health")
      .then((data) => setHealth(data.mode))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (tab === "patients" || tab === "overview")
      void loadRegistry().catch((e) => setError(e.message));
  }, [tab]);
  useEffect(() => {
    setChart(null);
    setEditing(null);
    if (selected && canChart) void loadChart(selected);
    else void loadTab(tab);
  }, [tab, selected]);
  useEffect(() => {
    if (noteVisit && chart?.patient.id === noteVisit.patient_id) setEditing("new");
  }, [noteVisit, chart?.patient.id]);
  useEffect(() => {
    if (editing === "new") setNoteRequestKey(crypto.randomUUID());
  }, [editing]);
  useEffect(() => {
    if (
      (!nav.some(([id]) => id === tab) && !(tab === "visits" && can("visits.view"))) ||
      (selected && !canChart)
    )
      void navigate({ search: { tab: "overview" }, replace: true });
  }, [me.permissions?.join(","), tab, selected]);
  async function act(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = patients.filter((p) =>
    `${p.name} ${p.healthpass_id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="hp-shell">
      <aside className="hp-sidebar">
        <a className="hp-brand" href="/">
          <Mark />
          HealthPass
        </a>
        <div className="hp-facility">
          <span className="hp-avatar">{isPatient ? "HP" : "LC"}</span>
          <div>
            <strong>{isPatient ? "Patient portal" : me.organization?.name.split(" · ")[0]}</strong>
            <small>
              {isPatient ? "Your care, connected" : (me.branch?.name ?? "Facility workspace")}
            </small>
          </div>
        </div>
        <span className="hp-nav-label">WORKSPACE</span>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
              }}
            >
              <Icon size={19} />
              {label}
              {tab === id && <span className="hp-nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="hp-sidebar-bottom">
          <div className="hp-ecosystem-note">
            <Activity size={18} />
            <strong>Connected by care</strong>
            <p>Part of the RxLedger & Rai ecosystem.</p>
          </div>
          <button
            className="hp-user"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => void act(onLogout, "")}
          >
            <span className="hp-avatar">
              {me.user.name
                .split(" ")
                .slice(0, 2)
                .map((n) => n[0])
                .join("")}
            </span>
            <span>
              <strong>{me.user.name}</strong>
              <small>{me.jobRoles?.map((r) => r.name).join(" · ") || me.role}</small>
            </span>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="hp-main">
        <header className="hp-topbar">
          <span>
            <span className="hp-online-dot" />{" "}
            {me.organization ? (me.branch?.name ?? "Facility workspace") : "Patient workspace"}
          </span>
          <span className="hp-protected">
            <LockKeyhole size={14} /> Scoped, audited access
          </span>
        </header>
        <main className="hp-content">
          {health === "synthetic-development" && (
            <div className="hp-demo-banner">Development workspace · use synthetic records only</div>
          )}
          {error && (
            <div className="hp-error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="hp-success" role="status">
              <Check size={16} />
              {notice}
            </div>
          )}
          {tab === "workspace" && can("workspace.view") && (
            <WorkspaceSettings permissions={me.permissions ?? []} userId={me.user.id} />
          )}
          {(tab === "today" || tab === "visits") && can("visits.view") && (
            <Visits
              me={me}
              onOpenChart={(id) =>
                void navigate({
                  search: {
                    tab: "patients",
                    patient: id,
                    visit: search.visit,
                    branch: search.branch,
                  },
                })
              }
              onDocumentVisit={(visit) => {
                setNoteVisit({ id: visit.id, patient_id: visit.patient_id });
                void navigate({
                  search: {
                    tab: "patients",
                    patient: visit.patient_id,
                    visit: visit.id,
                    branch: visit.branch_id,
                  },
                });
              }}
            />
          )}
          {!isPatient && !me.permissions?.length && (
            <div className="hp-notice" role="status">
              Your job roles currently have no app permissions. Ask your administrator which
              HealthPass tools are applicable to your work.
            </div>
          )}
          {tab === "overview" && (
            <>
              <div className="hp-heading">
                <div>
                  <span className="hp-eyebrow">YOUR CARE WORKSPACE</span>
                  <h1>
                    {isPatient
                      ? "Your health, in view."
                      : `Good ${new Date().getHours() < 12 ? "morning" : "day"}, ${me.user.name.split(" ").slice(0, 2).join(" ")}.`}
                  </h1>
                  <p>
                    {isPatient
                      ? "Your record, sharing permissions and care history in one place."
                      : "A clearer picture of your patients. A thoughtful start to every encounter."}
                  </p>
                </div>
                {canRegister && (
                  <button className="hp-button primary" onClick={() => setRegister(true)}>
                    <Plus size={17} /> Register patient
                  </button>
                )}
              </div>
              <div className="hp-stats">
                <Stat
                  icon={<Users />}
                  tone="teal"
                  value={String(patients.length)}
                  label={isPatient ? "Your patient identity" : "Accessible patients"}
                  detail={isPatient ? "A persistent HealthPass ID" : "Within your permitted scope"}
                />
                <Stat
                  icon={<ShieldCheck />}
                  tone="blue"
                  value={isPatient ? "You decide" : "Verified"}
                  label={isPatient ? "Record sharing" : "Professional access"}
                  detail={
                    isPatient ? "Time-limited facility grants" : "Reviewed workspace permissions"
                  }
                />
                <Stat
                  icon={<ClipboardList />}
                  tone="burgundy"
                  value="Traceable"
                  label="Care documentation"
                  detail="Signed versions retain their source"
                />
              </div>
              <div className="hp-overview-grid">
                <section className="hp-panel">
                  <div className="hp-panel-heading">
                    <div>
                      <h2>{isPatient ? "Your HealthPass" : "Patient registry"}</h2>
                      <p>
                        {isPatient
                          ? "Begin with your care history."
                          : "Start an encounter from an authorized patient record."}
                      </p>
                    </div>
                    {canRegister && (
                      <button className="hp-text-button" onClick={() => void loadTab("patients")}>
                        View registry <ArrowRight size={15} />
                      </button>
                    )}
                  </div>
                  {patients.length ? (
                    patients.slice(0, 5).map((p) => (
                      <PatientRow
                        key={p.id}
                        patient={p}
                        onClick={
                          canChart
                            ? () => {
                                void loadTab("patients");
                                void loadChart(p.id);
                              }
                            : undefined
                        }
                      />
                    ))
                  ) : (
                    <Empty
                      title="A clean start"
                      text={
                        canRegister
                          ? "Register your first patient to start documenting care."
                          : "This role manages operations and has no clinical chart access."
                      }
                    />
                  )}
                </section>
                <section className="hp-care-card">
                  <span className="hp-icon-tile teal">
                    <FileHeart />
                  </span>
                  <span className="hp-eyebrow">CARE THAT TRAVELS</span>
                  <h2>
                    One identity.
                    <br />
                    Every chapter of care.
                  </h2>
                  <p>
                    Know where a record came from, who signed it, and what changed. Sharing stays
                    deliberate.
                  </p>
                  <div>
                    <ShieldCheck size={17} /> Consent-aware records
                  </div>
                  <div>
                    <History size={17} /> A clear access history
                  </div>
                  {(isPatient || can("audit.view")) && (
                    <button
                      className="hp-button secondary"
                      onClick={() => void loadTab(isPatient ? "sharing" : "audit")}
                    >
                      {isPatient ? "Manage sharing" : "Review activity"}
                      <ArrowRight size={16} />
                    </button>
                  )}
                </section>
              </div>
              <section className="hp-foundation-note">
                <span className="hp-icon-tile blue">
                  <Stethoscope size={20} />
                </span>
                <div>
                  <strong>Built for a careful first step</strong>
                  <p>
                    This workspace supports identity, charts, encounters and record governance.
                    Appointments, prescriptions and RxLedger exchange will follow in later slices.
                  </p>
                </div>
              </section>
            </>
          )}
          {tab === "patients" && canRegistry && !selected && (
            <>
              <div className="hp-heading">
                <div>
                  <span className="hp-eyebrow">PATIENT IDENTITY</span>
                  <h1>{isPatient ? "My record" : "Patient registry"}</h1>
                  <p>
                    Search only within your permitted care scope. Shared phones never merge
                    identities.
                  </p>
                </div>
                {canRegister && (
                  <button className="hp-button primary" onClick={() => setRegister(true)}>
                    <Plus size={17} /> Register patient
                  </button>
                )}
              </div>
              <section className="hp-panel">
                {canRegister && (
                  <div className="hp-panel-heading">
                    <p>Already has a HealthPass account?</p>
                    <button className="hp-button secondary" onClick={() => setLinkExisting(true)}>
                      Link existing account
                    </button>
                  </div>
                )}
                <div className="hp-search">
                  <Search size={18} />
                  <input
                    aria-label="Search patients"
                    placeholder="Search by name or HealthPass ID"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <span>{filtered.length} records</span>
                </div>
                {filtered.map((p) => (
                  <PatientRow
                    key={p.id}
                    patient={p}
                    onClick={canChart ? () => void loadChart(p.id) : undefined}
                  />
                ))}
                {!filtered.length && (
                  <Empty
                    title="No records found"
                    text="Try another name or register a new identity. Missing history stays unknown."
                  />
                )}
                {!canChart && (
                  <p className="hp-fine hp-padded">
                    Reception access covers registration and limited demographics. Clinical charts
                    remain restricted.
                  </p>
                )}
              </section>
            </>
          )}
          {tab === "patients" && canChart && selected && chart && (
            <>
              {search.visit && can("visits.view") && (
                <div className="hp-notice">
                  <strong>Care visit</strong>
                  <p>
                    Return to the visit to record observations, arrange follow-up or complete it
                    after signing your note.
                  </p>
                  <button
                    className="hp-button secondary"
                    onClick={() =>
                      void navigate({
                        search: { tab: "today", visit: search.visit, branch: search.branch },
                      })
                    }
                  >
                    Back to visit
                  </button>
                </div>
              )}
              <button
                className="hp-back"
                onClick={() => {
                  setSelected(null);
                  setChart(null);
                }}
              >
                <ArrowLeft size={16} /> Back to registry
              </button>
              <div className="hp-heading hp-chart-heading">
                <div>
                  <span className="hp-eyebrow">{chart.patient.healthpass_id}</span>
                  <h1>{chart.patient.name}</h1>
                  <p>
                    {chart.patient.dob ? `Born ${chart.patient.dob}` : "Date of birth unknown"}{" "}
                    {chart.accessScope.includeProfile && (
                      <>
                        <span>·</span>{" "}
                        {"phone" in chart.patient
                          ? chart.patient.phone || "Contact not recorded"
                          : "Contact details not shared"}
                      </>
                    )}
                  </p>
                </div>
                {can("notes.create") &&
                  chart.accessScope.canContribute &&
                  chart.accessScope.contributionScopes.length > 0 && (
                    <button
                      className="hp-button primary"
                      onClick={() => {
                        setNoteVisit(null);
                        setEditing("new");
                      }}
                    >
                      <Plus size={17} /> New encounter
                    </button>
                  )}
              </div>
              {!chart.accessScope.includeProfile ? (
                <p className="hp-notice">
                  Clinical profile is outside your sharing scope. Ask the patient before accessing
                  allergy or emergency-contact details.
                </p>
              ) : (
                <div
                  className={`hp-allergy ${chart.patient.allergy_status === "reviewed" ? "warning" : ""}`}
                >
                  <ShieldCheck size={21} />
                  <div>
                    <strong>
                      {chart.patient.allergy_status === "unknown"
                        ? "Allergy history unknown"
                        : chart.patient.allergy_status === "none-known"
                          ? "No known allergies after review"
                          : "Reviewed allergy information"}
                    </strong>
                    <p>
                      {chart.patient.allergies ||
                        "Review with the patient before making clinical decisions."}
                    </p>
                  </div>
                  {can("profile.edit") && chart.accessScope.canEditProfile && (
                    <button className="hp-button ghost" onClick={() => setProfile(true)}>
                      Review profile
                    </button>
                  )}
                </div>
              )}
              {!isPatient && chart.accessScope.restricted && (
                <ProfessionalAccess
                  patientId={chart.patient.id}
                  me={me}
                  onChanged={() => void loadChart(chart.patient.id)}
                />
              )}
              <div className="hp-chart-layout">
                <section className="hp-panel">
                  <div className="hp-panel-heading">
                    <div>
                      <h2>Care timeline</h2>
                      <p>Original source and signed versions stay visible.</p>
                    </div>
                    <span className="hp-chip blue">{chart.encounters.length} encounters</span>
                  </div>
                  {chart.encounters.map((encounter) => (
                    <EncounterCard
                      key={encounter.id}
                      encounter={encounter}
                      onEdit={encounter.editable ? () => setEditing(encounter) : undefined}
                    />
                  ))}
                  {!chart.encounters.length && (
                    <Empty
                      title="No records in this view"
                      text={
                        isPatient
                          ? "Signed notes from your care team will appear here."
                          : chart.accessScope.canContribute
                            ? "Create an encounter to document this patient’s care."
                            : "No released notes are available in your selected sharing categories."
                      }
                    />
                  )}
                </section>
                <aside className="hp-panel hp-profile-summary">
                  <h2>Patient context</h2>
                  <dl>
                    <dt>HealthPass ID</dt>
                    <dd>{chart.patient.healthpass_id}</dd>
                    <dt>Identity status</dt>
                    <dd>Registered · external verification not established</dd>
                    {chart.accessScope.includeProfile && (
                      <>
                        <dt>Emergency contact</dt>
                        <dd>{chart.patient.emergency_contact || "Not recorded"}</dd>
                      </>
                    )}
                    <dt>Record access</dt>
                    <dd>
                      {isPatient
                        ? "Your own released records"
                        : chart.accessScope.restricted
                          ? `Selected categories: ${chart.accessScope.scopes.join(", ")} · ${chart.accessScope.canContribute ? "Contribution permitted" : "Read only"}`
                          : "Facility scope and active sharing grants"}
                    </dd>
                  </dl>
                  <div className="hp-notice">
                    <LockKeyhole size={17} />
                    <p>
                      Signed notes preserve clinical history. Corrections create a new version with
                      a reason.
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}
          {tab === "sharing" && (
            <>
              <div className="hp-heading">
                <div>
                  <span className="hp-eyebrow">YOUR RECORD, YOUR TERMS</span>
                  <h1>Sharing & permissions</h1>
                  <p>Choose who can access your records, what they can see and when access ends.</p>
                </div>
              </div>
              {isPatient && <PatientLinking />}
              {isPatient && (
                <PatientProfessionalAccess
                  onChanged={(restricted) =>
                    setAccessRestricted((current) => current === true || restricted)
                  }
                />
              )}
              <div className="hp-sharing-grid">
                {accessRestricted === false && (
                  <section className="hp-panel hp-padded">
                    <h2>Share with a care team</h2>
                    <p className="hp-muted">
                      A grant permits verified clinicians to read signed records and create their
                      own encounters. It does not permit rewriting another facility’s notes.
                    </p>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const data = Object.fromEntries(new FormData(e.currentTarget));
                        void act(async () => {
                          await careApi("/consents", "POST", {
                            ...data,
                            expires_at: new Date(
                              Date.now() + Number(data.days) * 86400000,
                            ).toISOString(),
                          });
                          await loadTab("sharing");
                        }, "Sharing permission saved.");
                      }}
                    >
                      <label>
                        Recipient facility
                        <select name="recipient_id" required>
                          <option value="">Choose a participating facility</option>
                          {organizations.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Purpose
                        <input
                          name="purpose"
                          required
                          maxLength={500}
                          placeholder="For example: follow-up consultation"
                        />
                      </label>
                      <label>
                        Access duration
                        <select name="days">
                          <option value="1">1 day</option>
                          <option value="7">7 days</option>
                          <option value="30">30 days</option>
                        </select>
                      </label>
                      <button
                        className="hp-button primary"
                        disabled={busy || !organizations.length}
                      >
                        <ShieldCheck size={17} /> Grant access
                      </button>
                    </form>
                  </section>
                )}
                {accessRestricted === true && (
                  <p className="hp-notice">
                    Only selected professionals can access clinical information. Older facility
                    grants below no longer grant chart access.
                  </p>
                )}
                <section className="hp-panel">
                  <div className="hp-panel-heading">
                    <div>
                      <h2>Sharing history</h2>
                      <p>Revoke future shared access at any time.</p>
                    </div>
                  </div>
                  {consents.map((c) => (
                    <div className="hp-grant" key={c.id}>
                      <div>
                        <strong>{c.recipient_name}</strong>
                        <p>{c.purpose}</p>
                        <small>Expires {date(c.expires_at)}</small>
                      </div>
                      <span
                        className={`hp-chip ${c.revoked_at ? "neutral" : Date.parse(c.expires_at) < Date.now() ? "amber" : "teal"}`}
                      >
                        {c.revoked_at
                          ? "Revoked"
                          : Date.parse(c.expires_at) < Date.now()
                            ? "Expired"
                            : accessRestricted
                              ? "Inactive · named access"
                              : "Active"}
                      </span>
                      {!c.revoked_at && Date.parse(c.expires_at) > Date.now() && (
                        <button
                          className="hp-text-button"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await careApi(`/consents/${c.id}/revoke`, "POST", {});
                              await loadTab("sharing");
                            }, "Sharing revoked. Future requests are checked immediately.")
                          }
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                  {!consents.length && (
                    <Empty
                      title="No sharing grants yet"
                      text="Choose a facility and purpose when you need to share care history."
                    />
                  )}
                  <p className="hp-fine hp-padded">
                    Revoking sharing stops future partner access. It preserves signed care already
                    documented by that facility.
                  </p>
                </section>
              </div>
            </>
          )}
          {tab === "audit" && (isPatient || can("audit.view")) && (
            <>
              <div className="hp-heading">
                <div>
                  <span className="hp-eyebrow">A CLEAR RECORD OF ACCESS</span>
                  <h1>{isPatient ? "Access history" : "Activity & audit"}</h1>
                  <p>
                    {isPatient
                      ? "See access to your record and changes to your sharing permissions."
                      : "Recent actions and denied requests within this facility. Clinical text is excluded."}
                  </p>
                </div>
                <button className="hp-button secondary" onClick={() => void loadTab("audit")}>
                  <History size={16} /> Refresh
                </button>
              </div>
              <section className="hp-panel hp-audit-table">
                <table>
                  <thead>
                    <tr>
                      <th>Activity</th>
                      <th>By</th>
                      <th>Decision</th>
                      <th>Time · Lagos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <strong>{a.action.replaceAll(".", " · ").replaceAll("_", " ")}</strong>
                          <small>{a.correlation_id.slice(0, 8)}</small>
                        </td>
                        <td>
                          {a.actor_name || "Unknown actor"}
                          <small>{a.organization_name || ""}</small>
                        </td>
                        <td>
                          <span className={`hp-chip ${a.decision === "deny" ? "amber" : "teal"}`}>
                            {a.decision === "deny" ? "Denied" : "Allowed"}
                          </span>
                        </td>
                        <td>{date(a.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!audit.length && (
                  <Empty
                    title="No activity to show"
                    text="Audited care actions will appear here."
                  />
                )}
              </section>
            </>
          )}
          {busy && (
            <span className="hp-working" role="status">
              Working…
            </span>
          )}
          {register && (
            <Modal title="Register a patient" onClose={() => setRegister(false)}>
              {error && (
                <p className="hp-error" role="alert">
                  {error}
                </p>
              )}
              <p className="hp-muted">
                Create a separate identity. Do not guess a date of birth or merge records based on a
                shared phone.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = Object.fromEntries(new FormData(e.currentTarget));
                  void act(async () => {
                    const result = await careApi("/patients", "POST", data);
                    await loadRegistry();
                    setRegister(false);
                    setTab("patients");
                    if (canChart) await loadChart(result.id);
                  }, "Patient registered with a new HealthPass ID.");
                }}
              >
                <label>
                  Full name
                  <input name="name" required maxLength={160} />
                </label>
                <label>
                  Date of birth <small>Optional</small>
                  <input type="date" name="dob" max={new Date().toISOString().slice(0, 10)} />
                </label>
                <label>
                  Contact phone <small>Optional; may be shared</small>
                  <input name="phone" type="tel" maxLength={40} />
                </label>
                <button className="hp-button primary" disabled={busy}>
                  Register patient
                  <ArrowRight size={16} />
                </button>
              </form>
            </Modal>
          )}
          {linkExisting && (
            <FacilityLinking
              onClose={() => setLinkExisting(false)}
              onLinked={(id) => {
                setLinkExisting(false);
                void loadRegistry();
                setTab("patients");
                if (canChart) setSelected(id);
              }}
            />
          )}
          {editing && chart && canChart && (
            <NoteEditor
              encounter={editing}
              scopes={(me.clinicalScopes ?? []).filter((scope) =>
                chart.accessScope.contributionScopes.includes(scope),
              )}
              canEdit={editing === "new" ? can("notes.create") : can("notes.edit")}
              canSign={can("notes.sign")}
              canAmend={can("notes.amend")}
              error={error}
              busy={busy}
              onClose={() => {
                setEditing(null);
                setNoteVisit(null);
              }}
              onSave={(note, operation, reason, kind) =>
                void act(
                  async () => {
                    if (editing === "new") {
                      await careApi("/encounters", "POST", {
                        patient_id: chart.patient.id,
                        visit_id: noteVisit?.id,
                        client_request_id: noteRequestKey,
                        note_kind: kind,
                        ...note,
                      });
                    } else {
                      if (operation === "save")
                        await careApi(`/encounters/${editing.id}`, "PATCH", {
                          version: editing.version,
                          ...note,
                        });
                      else if (operation === "sign") {
                        await careApi(`/encounters/${editing.id}/sign`, "POST", {
                          version: editing.version,
                          ...note,
                        });
                      } else
                        await careApi(`/encounters/${editing.id}/amend`, "POST", {
                          version: editing.version,
                          ...note,
                          reason,
                        });
                    }
                    await loadChart(chart.patient.id);
                    setEditing(null);
                    setNoteVisit(null);
                  },
                  operation === "save"
                    ? "Draft saved to the care service."
                    : operation === "sign"
                      ? "Encounter signed. This version is retained."
                      : "Amendment signed; previous versions are preserved.",
                )
              }
            />
          )}
          {profile && chart && (
            <Modal title="Review patient context" onClose={() => setProfile(false)}>
              {error && (
                <p className="hp-error" role="alert">
                  {error}
                </p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = Object.fromEntries(new FormData(e.currentTarget));
                  void act(async () => {
                    await careApi(`/patients/${chart.patient.id}/profile`, "PATCH", data);
                    await loadChart(chart.patient.id);
                    setProfile(false);
                  }, "Patient context reviewed.");
                }}
              >
                <label>
                  Allergy history status
                  <select name="allergy_status" defaultValue={chart.patient.allergy_status}>
                    <option value="unknown">Unknown / not reviewed</option>
                    <option value="none-known">No known allergies after review</option>
                    <option value="reviewed">Reviewed allergy information</option>
                  </select>
                </label>
                <label>
                  Allergy details
                  <textarea
                    name="allergies"
                    defaultValue={chart.patient.allergies}
                    maxLength={6000}
                  />
                </label>
                <label>
                  Emergency contact
                  <input
                    name="emergency_contact"
                    defaultValue={chart.patient.emergency_contact}
                    maxLength={500}
                  />
                </label>
                <button className="hp-button primary" disabled={busy}>
                  Save reviewed context
                </button>
              </form>
            </Modal>
          )}
        </main>
        <footer className="hp-footer">
          HealthPass <span>·</span> Care with continuity <span>·</span> Nigeria
        </footer>
      </div>
    </div>
  );
}
