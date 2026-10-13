import { useEffect, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, X, type LucideIcon } from "lucide-react";
import type { Me } from "@/lib/healthpass-types";

export type NavigationItem = readonly [id: string, label: string, icon: LucideIcon];
type PanelProps = {
  me: Me;
  items: readonly NavigationItem[];
  active: string;
  collapsed: boolean;
  mobile?: boolean;
  busy: boolean;
  onNavigate: (id: string) => void;
  onToggle: () => void;
  onLogout: () => void;
};
function NavigationPanel({
  me,
  items,
  active,
  collapsed,
  mobile,
  busy,
  onNavigate,
  onToggle,
  onLogout,
}: PanelProps) {
  const patient = me.role === "patient";
  const accountRoles = patient
    ? "Patient account"
    : me.jobRoles?.map((role) => role.name).join(" · ") || "Professional account";
  const care = items.filter(([id]) => !["workspace", "audit", "security"].includes(id));
  const administration = items.filter(([id]) => ["workspace", "audit", "security"].includes(id));
  const groups = [
    { label: patient ? "MY CARE" : "CARE & DAILY WORK", items: care },
    { label: patient ? "MY ACTIVITY" : "WORKSPACE", items: administration },
  ];
  return (
    <>
      <div className="hp-navigation-header">
        <a
          href="/"
          className="hp-navigation-brand"
          aria-label="HealthPass home"
          title="HealthPass home"
        >
          <img
            className="hp-navigation-wordmark"
            src="/healthpass-wordmark.png"
            alt="HealthPass"
            width={150}
            height={50}
          />
          <img
            className="hp-navigation-mark"
            src="/healthpass-icon.png"
            alt=""
            width={36}
            height={36}
          />
        </a>
        <button
          className="hp-navigation-toggle"
          type="button"
          onClick={onToggle}
          aria-label={
            mobile ? "Close navigation" : collapsed ? "Expand side panel" : "Collapse side panel"
          }
          title={
            mobile ? "Close navigation" : collapsed ? "Expand side panel" : "Collapse side panel"
          }
          aria-expanded={mobile ? undefined : !collapsed}
        >
          {mobile ? (
            <X size={20} />
          ) : collapsed ? (
            <PanelLeftOpen size={20} />
          ) : (
            <PanelLeftClose size={20} />
          )}
        </button>
      </div>
      <div className="hp-navigation-scroll">
        <div
          className="hp-navigation-context"
          title={
            patient
              ? "Patient workspace"
              : `${me.organization?.name} · ${me.branch?.name ?? "Facility workspace"}`
          }
        >
          <span className="hp-navigation-context-icon" aria-hidden="true">
            {patient ? "HP" : "WS"}
          </span>
          <div className="hp-navigation-context-text">
            <strong>{patient ? "Patient workspace" : me.organization?.name}</strong>
            <span>
              {patient ? "Your care, connected" : (me.branch?.name ?? "Facility workspace")}
            </span>
            {!patient && me.organization?.workspace_code && (
              <small>{me.organization.workspace_code}</small>
            )}
          </div>
        </div>
        <nav aria-label={patient ? "Patient navigation" : "Professional navigation"}>
          {groups
            .filter((group) => group.items.length)
            .map((group) => (
              <div className="hp-navigation-group" key={group.label}>
                <p className="hp-navigation-group-label">{group.label}</p>
                {group.items.map(([id, label, Icon]) => (
                  <button
                    type="button"
                    className={`hp-navigation-item${active === id ? " active" : ""}`}
                    key={id}
                    aria-label={label}
                    aria-current={active === id ? "page" : undefined}
                    title={label}
                    onClick={() => onNavigate(id)}
                  >
                    <Icon size={20} aria-hidden="true" />
                    <span className="hp-navigation-item-label">{label}</span>
                  </button>
                ))}
              </div>
            ))}
        </nav>
      </div>
      <div className="hp-navigation-footer">
        <div className="hp-navigation-account" title={`${me.user.name} · ${accountRoles}`}>
          <span className="hp-avatar" aria-hidden="true">
            {me.user.name
              .split(" ")
              .slice(0, 2)
              .map((name) => name[0])
              .join("")}
          </span>
          <div className="hp-navigation-account-text">
            <strong>{me.user.name}</strong>
            <small>
              {patient
                ? "Patient account"
                : `${me.jobRoles?.find((r) => r.name === "General practitioner")?.name ?? me.jobRoles?.[0]?.name ?? "Professional account"}${(me.jobRoles?.length ?? 0) > 1 ? ` +${me.jobRoles!.length - 1} roles` : ""}`}
            </small>
          </div>
        </div>
        <button
          className="hp-navigation-signout"
          type="button"
          disabled={busy}
          onClick={onLogout}
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut size={18} aria-hidden="true" />
          <span>Sign out</span>
        </button>
      </div>
    </>
  );
}

/** Responsive shell only. The caller derives available destinations from current server permissions. */
export function WorkspaceShell({
  me,
  items,
  active,
  busy,
  onNavigate,
  onLogout,
  children,
}: Omit<PanelProps, "collapsed" | "mobile" | "onToggle"> & { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false),
    [open, setOpen] = useState(false);
  const preferenceKey = `healthpass-side-panel:v1:${me.user.id}`;
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(preferenceKey) === "collapsed");
    } catch {
      /* Navigation still works when device storage is unavailable. */
    }
  }, [preferenceKey]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (media.matches) setOpen(false);
    };
    closeOnDesktop();
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(preferenceKey, next ? "collapsed" : "expanded");
    } catch {
      /* Keep the current layout usable without storing a preference. */
    }
  };
  const panelProps = {
    me,
    items,
    active: active === "visits" ? "today" : active,
    busy,
    onNavigate,
    onLogout,
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <div className={`hp-shell hp-app-shell${collapsed ? " hp-navigation-collapsed" : ""}`}>
        <aside className="hp-navigation hp-navigation-desktop" aria-label="Workspace side panel">
          <NavigationPanel {...panelProps} collapsed={collapsed} onToggle={toggle} />
        </aside>
        <div className="hp-main">
          <header className="hp-topbar hp-navigation-topbar">
            <Dialog.Trigger asChild>
              <button
                type="button"
                className="hp-navigation-menu"
                aria-label="Open navigation"
                title="Open navigation"
              >
                <Menu size={22} aria-hidden="true" />
              </button>
            </Dialog.Trigger>
            <div className="hp-navigation-topbar-context">
              <strong>{me.role === "patient" ? "Patient workspace" : me.organization?.name}</strong>
              <small>
                {me.role === "patient"
                  ? "Your care, connected"
                  : (me.branch?.name ?? "Facility workspace")}
              </small>
            </div>
          </header>
          {children}
        </div>
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="hp-navigation-overlay" />
        <Dialog.Content
          className="hp-shell hp-navigation hp-navigation-drawer"
          aria-describedby={undefined}
        >
          <Dialog.Title className="hp-navigation-sr">Workspace navigation</Dialog.Title>
          <NavigationPanel
            {...panelProps}
            collapsed={false}
            mobile
            onToggle={() => setOpen(false)}
            onNavigate={(id) => {
              onNavigate(id);
              setOpen(false);
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
