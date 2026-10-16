import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { defaults, FeedbackContext, type Preferences } from "./healthpass-preferences";

/** One announcement and one short tone per completed action, including repeated messages. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [preferences, setPreferences] = useState(defaults);
  const [message, setMessage] = useState<{ text: string; id: number } | null>(null);
  const saved = useRef<Preferences | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  const success = useCallback((text: string) => {
    if (!text) {
      return;
    }
    if (timer.current) {
      clearTimeout(timer.current);
    }
    setMessage({ text, id: ++sequence.current });
    timer.current = setTimeout(() => setMessage(null), 3000);
    const context = audio.current;
    if (!saved.current?.soundEnabled || document.hidden || context?.state !== "running") {
      return;
    }
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      const start = context.currentTime;
      oscillator.frequency.setValueAtTime(660, start);
      oscillator.frequency.setValueAtTime(880, start + 0.12);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.035, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.32);
      oscillator.start(start);
      oscillator.stop(start + 0.35);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    } catch {
      /* Audio failure must never turn a completed action into an error. */
    }
  }, []);
  useEffect(() => {
    setMounted(true);
    const receive = (event: Event) => {
      const next = (event as CustomEvent<Preferences>).detail;
      if (
        !["system", "light", "dark"].includes(next?.theme) ||
        typeof next.soundEnabled !== "boolean"
      ) {
        return;
      }
      saved.current = next;
      setPreferences(next);
      try {
        localStorage.setItem("healthpass-theme", next.theme);
      } catch {
        /* Storage is optional. */
      }
    };
    const reset = () => {
      saved.current = null;
      setPreferences(defaults);
      setMessage(null);
    };
    const unlock = () => {
      if (!saved.current?.soundEnabled) {
        return;
      }
      try {
        audio.current ??= new AudioContext();
        void audio.current.resume().catch(() => {});
      } catch {
        /* Browsers without audio still receive visual feedback. */
      }
    };
    try {
      const theme = localStorage.getItem("healthpass-theme");
      if (theme === "light" || theme === "dark" || theme === "system") {
        setPreferences({ ...defaults, theme });
      }
    } catch {
      /* Storage is optional. */
    }
    window.addEventListener("healthpass-preferences", receive);
    window.addEventListener("healthpass-session-expired", reset);
    window.addEventListener("healthpass-signed-out", reset);
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("healthpass-preferences", receive);
      window.removeEventListener("healthpass-session-expired", reset);
      window.removeEventListener("healthpass-signed-out", reset);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      if (timer.current) {
        clearTimeout(timer.current);
      }
      void audio.current?.close().catch(() => {});
      audio.current = null;
    };
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        preferences.theme === "dark" || (preferences.theme === "system" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences.theme]);
  return (
    <FeedbackContext.Provider value={{ preferences, success }}>
      {children}
      {mounted &&
        createPortal(
          <div className="hp-feedback-layer" role="status" aria-live="polite" aria-atomic="true">
            {message && (
              <div key={message.id} className="hp-feedback">
                <span aria-hidden="true">✓</span>
                {message.text}
              </div>
            )}
          </div>,
          document.body,
        )}
    </FeedbackContext.Provider>
  );
}
