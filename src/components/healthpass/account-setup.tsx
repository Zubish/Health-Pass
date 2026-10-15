import { useSuccessFeedback } from "@/lib/healthpass-preferences";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { careApi } from "@/lib/healthpass-client";
import type { Me } from "@/lib/healthpass-types";

type Step = {
  id: string;
  title: string;
  description: string;
  tab: string | null;
  reviewable: boolean;
  status: "todo" | "done" | "pending";
};
type Setup = {
  steps: Step[];
  access: string[];
  pending: boolean;
  patient: boolean;
  dismissed: boolean;
  showAutomatically: boolean;
};
export function OpenAccountSetup() {
  return (
    <section className="hp-panel hp-security-panel">
      <h2>Account setup</h2>
      <p>Review the steps relevant to your account. You can return here at any time.</p>
      <button
        className="hp-button secondary"
        onClick={() => window.dispatchEvent(new Event("healthpass-open-setup"))}
      >
        Open account setup
      </button>
    </section>
  );
}
export function AccountSetup({ me, onNavigate }: { me: Me; onNavigate: (tab: string) => void }) {
  const { data, refetch, isError } = useQuery<Setup>({
    queryKey: [
      "account-setup",
      me.user.id,
      me.organization?.id,
      !!me.pendingMembership,
      me.permissions?.join(","),
    ],
    queryFn: () => careApi("/account/setup"),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [open, setOpen] = useState(false);
  const [intro, setIntro] = useState(false);
  const [hide, setHide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const offered = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const success = useSuccessFeedback();
  const manual = useCallback(() => {
    offered.current = true;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIntro(false);
    setOpen(true);
    setError("");
    void refetch();
  }, [refetch]);
  useEffect(() => {
    window.addEventListener("healthpass-open-setup", manual);
    return () => window.removeEventListener("healthpass-open-setup", manual);
  }, [manual]);
  useEffect(() => {
    if (!data?.showAutomatically || offered.current) {
      return;
    }
    offered.current = true;
    setIntro(true);
    setOpen(true);
    void careApi("/account/setup", "POST", { action: "presented" }).catch(() =>
      setError(
        "We could not save your setup reminder preference. Please try Later again before leaving.",
      ),
    );
  }, [data]);
  async function save(action: string, step?: string) {
    setBusy(true);
    setError("");
    try {
      await careApi("/account/setup", "POST", { action, step });
      await refetch();
      if (action === "review") {
        success("Setup step reviewed.");
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (await save(hide ? "dismiss" : "later")) {
      setOpen(false);
    }
  }
  async function visit(step: Step) {
    if (hide && !(await save("dismiss"))) {
      return;
    }
    setOpen(false);
    if (step.tab) {
      onNavigate(step.tab);
    }
  }
  const unfinished = data?.steps.filter((step) => step.status !== "done") || [];
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) {
          void close();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="hp-setup-overlay" />
        <Dialog.Content
          className="hp-shell hp-setup-dialog"
          aria-describedby="hp-setup-description"
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus();
            }
          }}
        >
          <button
            className="hp-setup-close hp-text-button"
            aria-label="Close account setup"
            disabled={busy}
            onClick={() => void close()}
          >
            <X size={22} />
          </button>
          <Dialog.Title>{intro ? "Welcome to HealthPass" : "Your account setup"}</Dialog.Title>
          <Dialog.Description id="hp-setup-description">
            {intro
              ? "A few optional steps to help you get started. You can continue using your account at any time."
              : "Complete actions in their own screens, then return here. Mark a review step only after you have checked it."}
          </Dialog.Description>
          {error && (
            <p className="hp-error" role="alert">
              {error}
              <button className="hp-text-button" onClick={() => setOpen(false)}>
                Continue without saving
              </button>
            </p>
          )}
          {isError && (
            <p className="hp-error" role="alert">
              Setup could not be loaded. <button onClick={() => void refetch()}>Retry</button>
            </p>
          )}
          {!data && !isError && <p role="status">Loading your setup…</p>}
          {data && (
            <>
              {!data.patient && (
                <div className="hp-notice">
                  <strong>{me.organization?.name}</strong>
                  <p>
                    {me.branch?.name ||
                      (data.pending ? "Branch awaiting assignment" : "Facility-wide workspace")}
                  </p>
                  <p>
                    {me.jobRoles?.map((role) => role.name).join(" · ") ||
                      "Job roles awaiting approval"}
                  </p>
                  {!data.pending && (
                    <details className="hp-setup-access">
                      <summary>Your workspace access</summary>
                      {data.access.length ? (
                        <ul>
                          {data.access.map((label) => (
                            <li key={label}>{label}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>No app permissions have been assigned yet.</p>
                      )}
                      <p>
                        Patient sharing and care-area assignments still apply. Contact your
                        administrator if your access needs changing.
                      </p>
                    </details>
                  )}
                  {data.pending && (
                    <p>
                      Your administrator must approve your workspace access. You can set your
                      personal preferences now; clinical tools remain unavailable.
                    </p>
                  )}
                </div>
              )}
              <p className="hp-fine">
                {data.steps.filter((step) => step.status === "done").length} of {data.steps.length}{" "}
                steps completed
              </p>
              {intro ? (
                <p>
                  {data.patient
                    ? "Review your details, primary care, sharing and security."
                    : data.pending
                      ? "Start with your appearance and sound preferences while your facility reviews your request."
                      : "Review your workspace, available tools and personal settings."}
                </p>
              ) : (
                <div className="hp-setup-steps">
                  {!unfinished.length && (
                    <p role="status">
                      You’re all set. Your settings remain available whenever you need them.
                    </p>
                  )}
                  {unfinished.map((step) => (
                    <section className="hp-setup-step" key={step.id}>
                      <h3>{step.title}</h3>
                      <p>{step.description}</p>
                      {step.status === "pending" ? (
                        <p className="hp-chip neutral">Awaiting facility acceptance</p>
                      ) : (
                        <div className="hp-logo-actions">
                          {step.tab && (
                            <button
                              className="hp-button secondary"
                              disabled={busy}
                              onClick={() => void visit(step)}
                            >
                              {(
                                {
                                  patients: "View my record",
                                  relationships: "Choose facility",
                                  sharing: "Review sharing",
                                  workspace: "Open workspace settings",
                                  departments: "Open department work",
                                  today: "Open daily work",
                                  security: "Open settings",
                                } as Record<string, string>
                              )[step.tab] || "Open step"}
                            </button>
                          )}
                          {step.reviewable && (
                            <button
                              className="hp-text-button"
                              disabled={busy}
                              onClick={() => void save("review", step.id)}
                            >
                              I’ve reviewed this
                              <span className="hp-navigation-sr">: {step.title}</span>
                            </button>
                          )}
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              )}
              {data.patient && (
                <p className="hp-fine">
                  Proxy management is planned. No proxy access is enabled by this guide.
                </p>
              )}
              <label className="hp-choice">
                <input
                  type="checkbox"
                  checked={hide || data.dismissed}
                  disabled={busy || data.dismissed}
                  onChange={(e) => setHide(e.target.checked)}
                />
                <span>Don’t show this again</span>
              </label>
              <p className="hp-fine">
                Find this guide in Settings & security → Account setup. Later pauses reminders for
                seven days.
              </p>
              <div className="hp-logo-actions">
                <button
                  className="hp-button secondary"
                  disabled={busy}
                  onClick={() => void close()}
                >
                  {intro ? "Later" : "Close guide"}
                </button>
                {intro && (
                  <button
                    className="hp-button"
                    disabled={busy}
                    onClick={async () => {
                      if (!hide || (await save("dismiss"))) {
                        setIntro(false);
                      }
                    }}
                  >
                    Continue setup
                  </button>
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
