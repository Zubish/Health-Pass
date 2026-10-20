import { useWorkspaceLogo, workspaceInitials } from "@/lib/healthpass-workspace-logo";
import { useTaskNotifications } from "@/lib/healthpass-notifications";
import { TaskNotifications } from "./task-notifications";
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LogOut, Menu, X, type LucideIcon } from "lucide-react";
import type { Me } from "@/lib/healthpass-types";

export type NavigationItem = readonly [id: string, label: string, icon: LucideIcon];
type PanelProps = {
  me: Me;
  items: readonly NavigationItem[];
  active: string;
  collapsed: boolean;
  counts: Record<string, number> | null;
  mobile?: boolean;
  busy: boolean;
  onNavigate: (id: string) => void;
  onToggle?: () => void;
  onLogout: () => void;
};
function NavigationPanel({
  me,
  items,
  active,
  collapsed,
  counts,
  mobile,
  busy,
  onNavigate,
  onToggle,
  onLogout,
}: PanelProps) {
  const logo = useWorkspaceLogo(me);
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
        {(!collapsed || mobile) && (
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
          </a>
        )}
        {mobile && (
          <button
            className="hp-navigation-toggle"
            type="button"
            onClick={onToggle}
            aria-label="Close navigation"
            title="Close navigation"
          >
            <X size={20} />
          </button>
        )}
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
          {me.canManageWorkspaceLogo ? (
            <button
              className="hp-navigation-context-icon hp-workspace-logo-button"
              type="button"
              aria-label={logo.data?.logo ? "Change facility logo" : "Upload facility logo"}
              title="Manage facility logo"
              onClick={() => onNavigate("security")}
            >
              {logo.data?.logo ? (
                <img src={logo.data.logo} alt="" />
              ) : (
                workspaceInitials(me.organization?.name || "Workspace")
              )}
            </button>
          ) : (
            <span className="hp-navigation-context-icon" aria-hidden="true">
              {!patient && logo.data?.logo ? (
                <img src={logo.data.logo} alt="" />
              ) : patient ? (
                "HP"
              ) : (
                workspaceInitials(me.organization?.name || "Workspace")
              )}
            </span>
          )}
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
                    aria-label={
                      (counts?.[id] ?? 0) > 0 ? `${label}, ${counts![id]} pending tasks` : label
                    }
                    aria-current={active === id ? "page" : undefined}
                    title={
                      (counts?.[id] ?? 0) > 0 ? `${label} · ${counts![id]} pending tasks` : label
                    }
                    onClick={() => onNavigate(id)}
                  >
                    <Icon size={20} aria-hidden="true" />
                    <span className="hp-navigation-item-label">{label}</span>
                    {(counts?.[id] ?? 0) > 0 && (
                      <span className="hp-task-count" aria-hidden="true">
                        {counts![id] > 99 ? "99+" : counts![id]}
                      </span>
                    )}
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
}: Omit<PanelProps, "collapsed" | "mobile" | "onToggle" | "counts"> & { children: ReactNode }) {
  const notifications = useTaskNotifications(
    `${me.user.id}:${me.organization?.id ?? "patient"}:${me.branch?.id ?? "all"}:${me.permissions?.join(",") ?? ""}`,
  );
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapsed = !hovered && !focused;
  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
    }
    hoverTimer.current = null;
  };
  const scheduleHover = (expanded: boolean) => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setHovered(expanded), expanded ? 120 : 220);
  };
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px) and (hover: hover) and (pointer: fine)");
    const updateNavigation = () => {
      clearHoverTimer();
      setHovered(false);
      setFocused(false);
      if (media.matches) {
        setOpen(false);
      }
    };
    media.addEventListener("change", updateNavigation);
    return () => {
      clearHoverTimer();
      media.removeEventListener("change", updateNavigation);
    };
  }, []);
  const panelProps = {
    me,
    items,
    active: active === "visits" ? "today" : active,
    busy,
    counts: notifications.data?.counts ?? null,
    onNavigate,
    onLogout,
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <div className={`hp-shell hp-app-shell${collapsed ? " hp-navigation-collapsed" : ""}`}>
        <aside
          className="hp-navigation hp-navigation-desktop"
          aria-label="Workspace side panel"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") {
              scheduleHover(true);
            }
          }}
          onPointerLeave={() => scheduleHover(false)}
          onFocusCapture={(event) => {
            // Mouse clicks should not pin the panel open after the pointer leaves.
            setFocused(event.target.matches(":focus-visible"));
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setFocused(false);
            }
          }}
        >
          <NavigationPanel {...panelProps} collapsed={collapsed} />
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
            <TaskNotifications {...notifications} onNavigate={onNavigate} />
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
