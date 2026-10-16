import { useCallback, useEffect, useState } from "react";
import { careApi } from "./healthpass-client";

export type TaskSummary = {
  counts: Record<string, number>;
  items: { id: string; tab: string; label: string; count: number }[];
  total: number;
  updatedAt: string;
};

/** Counts are derived from current server permissions; never persist them on a shared device. */
export function useTaskNotifications(accountKey: string) {
  const [data, setData] = useState<TaskSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    let pending = false;
    let queued = false;
    async function load() {
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      setLoading(true);
      try {
        const summary = await careApi<TaskSummary>("/notifications");
        if (current) {
          setData(summary);
          setError("");
        }
      } catch {
        if (current) {
          setData(null);
          setError("Task alerts could not be refreshed. You can still open your workspace pages.");
        }
      } finally {
        pending = false;
        if (current) {
          setLoading(false);
          if (queued) {
            queued = false;
            void load();
          }
        }
      }
    }
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") {
        void load();
      }
    };
    setData(null);
    void load();
    const timer = window.setInterval(visibleRefresh, 60_000);
    window.addEventListener("healthpass-work-updated", visibleRefresh);
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      current = false;
      window.clearInterval(timer);
      window.removeEventListener("healthpass-work-updated", visibleRefresh);
      window.removeEventListener("focus", visibleRefresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [accountKey, revision]);
  return { data, error, loading, refresh };
}
