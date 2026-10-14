import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Bell, ChevronRight, RefreshCw, X } from "lucide-react";
import { date } from "@/lib/healthpass-types";
import type { TaskSummary } from "@/lib/healthpass-notifications";

export function TaskNotifications({
  data,
  error,
  loading,
  refresh,
  onNavigate,
}: {
  data: TaskSummary | null;
  error: string;
  loading: boolean;
  refresh: () => void;
  onNavigate: (tab: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          className="hp-notification-bell"
          type="button"
          aria-label={data ? `Notifications: ${data.total} pending tasks` : "Notifications"}
          title="Notifications"
        >
          <Bell size={22} aria-hidden="true" />
          {data && data.total > 0 && (
            <span className="hp-task-count" aria-hidden="true">
              {data.total > 99 ? "99+" : data.total}
            </span>
          )}
          {error && (
            <span className="hp-notification-unavailable" aria-hidden="true">
              !
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="hp-modal-overlay" />
        <Dialog.Content
          className="hp-modal hp-dialog-content hp-shell hp-notification-dialog"
          aria-describedby="notification-description"
        >
          <div className="hp-panel-heading">
            <Dialog.Title asChild>
              <h2>Notifications</h2>
            </Dialog.Title>
            <Dialog.Close className="hp-close" aria-label="Close notifications">
              <X />
            </Dialog.Close>
          </div>
          <div className="hp-padded">
            <Dialog.Description id="notification-description">
              Pending tasks and active work in your account. Counts update when work is completed,
              not when you open this panel.
            </Dialog.Description>
            <button
              className="hp-button secondary"
              type="button"
              onClick={refresh}
              disabled={loading}
            >
              <RefreshCw size={16} aria-hidden="true" />{" "}
              {loading ? "Refreshing…" : "Refresh alerts"}
            </button>
            {error && (
              <p role="alert" className="hp-error">
                {error}
              </p>
            )}
            {data && data.total === 0 && (
              <p className="hp-notification-empty">No pending tasks right now.</p>
            )}
            {data && data.items.length > 0 && (
              <ul className="hp-notification-list">
                {data.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onNavigate(item.tab);
                      }}
                    >
                      <span>{item.label}</span>
                      <span className="hp-task-count">{item.count}</span>
                      <ChevronRight size={18} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {data && <p className="hp-fine">Updated {date(data.updatedAt)}</p>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
