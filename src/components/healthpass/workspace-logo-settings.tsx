import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Me } from "@/lib/healthpass-types";
import { careApi } from "@/lib/healthpass-client";
import { useSuccessFeedback } from "@/lib/healthpass-preferences";
import {
  prepareWorkspaceLogo,
  useWorkspaceLogo,
  workspaceInitials,
  workspaceLogoKey,
} from "@/lib/healthpass-workspace-logo";

export function WorkspaceLogoSettings({ me }: { me: Me }) {
  const { data, isLoading, error: loadError } = useWorkspaceLogo(me);
  const queries = useQueryClient();
  const success = useSuccessFeedback();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(remove = false) {
    if (!remove && !preview) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await careApi("/workspace/logo", "POST", { logo: remove ? null : preview });
      queries.setQueryData(workspaceLogoKey(me), { logo: remove ? null : preview });
      setPreview(null);
      if (input.current) {
        input.current.value = "";
      }
      success(remove ? "Facility logo removed." : "Facility logo updated.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="hp-panel hp-security-panel" id="facility-logo">
      <h2>Facility logo</h2>
      <p>Shown beside {me.organization?.name} for everyone in this workspace.</p>
      <div className="hp-workspace-logo-preview">
        {preview || data?.logo ? (
          <img src={preview || data!.logo!} alt="Facility logo preview" />
        ) : (
          <span>{workspaceInitials(me.organization?.name || "Workspace")}</span>
        )}
      </div>
      {isLoading && <p role="status">Loading facility logo…</p>}
      {(error || loadError) && (
        <p className="hp-error" role="alert">
          {error || "The current logo could not be loaded. Refresh to try again."}
        </p>
      )}
      <label htmlFor="facility-logo-file">
        {data?.logo ? "Choose a replacement image" : "Choose a facility image"}
      </label>
      <input
        id="facility-logo-file"
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-describedby="facility-logo-help"
        disabled={busy || isLoading || !!loadError}
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          setError("");
          setPreview(null);
          if (!file) {
            return;
          }
          setBusy(true);
          try {
            setPreview(await prepareWorkspaceLogo(file));
          } catch (e) {
            setError((e as Error).message);
            if (input.current) {
              input.current.value = "";
            }
          } finally {
            setBusy(false);
          }
        }}
      />
      <p id="facility-logo-help" className="hp-fine">
        PNG, JPEG or WebP. Maximum 5 MB. Your image is resized to fit without cropping.
      </p>
      <div className="hp-logo-actions">
        {preview && (
          <>
            <button className="hp-button" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : data?.logo ? "Replace logo" : "Upload logo"}
            </button>
            <button
              className="hp-button secondary"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                if (input.current) {
                  input.current.value = "";
                }
              }}
            >
              Cancel
            </button>
          </>
        )}
        {data?.logo && !preview && (
          <button className="hp-button secondary" disabled={busy} onClick={() => void save(true)}>
            Remove logo
          </button>
        )}
      </div>
      <p className="hp-fine">Removing the logo restores your facility’s initials.</p>
    </section>
  );
}
