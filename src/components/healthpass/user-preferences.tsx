import { useState } from "react";
import { careApi } from "@/lib/healthpass-client";
import { usePreferences, useSuccessFeedback, type Preferences } from "@/lib/healthpass-preferences";

export function UserPreferences() {
  const preferences = usePreferences();
  const success = useSuccessFeedback();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(next: Preferences) {
    setBusy(true);
    setError("");
    try {
      await careApi("/account/preferences", "PATCH", next);
      success("Preferences saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="hp-panel hp-security-panel">
      <h2>Appearance & sound</h2>
      {error && (
        <p className="hp-error" role="alert">
          {error}
        </p>
      )}
      <label htmlFor="hp-appearance">
        Appearance
        <select
          id="hp-appearance"
          aria-label="Appearance"
          value={preferences.theme}
          disabled={busy}
          onChange={(e) =>
            void save({ ...preferences, theme: e.target.value as Preferences["theme"] })
          }
        >
          <option value="system">Use device setting</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label className="hp-choice">
        <input
          type="checkbox"
          checked={preferences.soundEnabled}
          disabled={busy}
          onChange={(e) => void save({ ...preferences, soundEnabled: e.target.checked })}
        />
        <span>Play completion sounds</span>
      </label>
      <p className="hp-fine">
        A brief, gentle sound confirms completed actions. Visual confirmations always appear for
        three seconds.
      </p>
    </section>
  );
}
