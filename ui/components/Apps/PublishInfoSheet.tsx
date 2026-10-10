/**
 * First-publish confirmation: name, description and cover — how the app appears
 * to people (Share Bar Redesign v6 "App info"). Shown once before the first Publish.
 *
 * Cover: the user's private cover (latest validate / tab screenshot) is shown here
 * and only becomes the shared cover if they choose "Use as cover". Retake renders the
 * app again in the hidden preview window. "Use banner" shares no picture at all.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { appCoverUrl, setAppCoverShared } from "../../utils/appCover";
import { getGatewayHttpBase } from "../../utils/gatewayHttpBase";
import "./PublishInfoSheet.css";

type CoverChoice = "cover" | "banner";

interface PublishInfoSheetProps {
  appId: string;
  initialTitle: string;
  onCancel: () => void;
  /** Called after name/description/cover are saved (publish: continue publishing). */
  onConfirmed: () => void;
  /** "publish" = first Publish step; "edit" = More → App info on a live/draft app. */
  mode?: "publish" | "edit";
}

export function PublishInfoSheet({
  appId,
  initialTitle,
  onCancel,
  onConfirmed,
  mode = "publish",
}: PublishInfoSheetProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [coverVersion, setCoverVersion] = useState(() => String(Date.now()));
  const [hasCover, setHasCover] = useState(true);
  const [choice, setChoice] = useState<CoverChoice>("cover");
  const [retaking, setRetaking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void gateway.send("app:get", { appId }).then((resp) => {
      const data = resp.data as { title?: string; description?: string } | undefined;
      if (cancelled || !data) return;
      if (data.title) setTitle(data.title);
      setDescription(data.description ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  useEffect(() => {
    if (!hasCover) setChoice("banner");
  }, [hasCover]);

  // Editing: start from what is shared today (a shared cover, or the banner).
  useEffect(() => {
    if (mode !== "edit") return;
    void fetch(`${getGatewayHttpBase()}/api/apps/${encodeURIComponent(appId)}/cover/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { hasShared?: boolean } | null) => {
        if (s && !s.hasShared) setChoice("banner");
      })
      .catch(() => undefined);
  }, [appId, mode]);

  const retake = async () => {
    setRetaking(true);
    setError(null);
    try {
      const res = await fetch(
        `${getGatewayHttpBase()}/api/apps/${encodeURIComponent(appId)}/cover/retake`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as { saved?: boolean; reason?: string };
      if (body.saved) {
        setHasCover(true);
        setChoice("cover");
        setCoverVersion(String(Date.now()));
      } else {
        setError(
          body.reason === "blank"
            ? "The app looked empty, so the old picture was kept."
            : "Couldn't take a new picture right now.",
        );
      }
    } finally {
      setRetaking(false);
    }
  };

  const confirm = async () => {
    const name = title.trim();
    if (!name) {
      setError("Give the app a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await gateway.send("app:update", { appId, title: name, description: description.trim() });
      await setAppCoverShared(appId, choice === "cover" && hasCover);
      onConfirmed();
    } catch (err) {
      setError((err as Error).message || "Couldn't save app info.");
      setSaving(false);
    }
  };

  return (
    <div className="pis">
      <p className="pis-lead">This is how the app appears to people you share it with.</p>
      <label className="pis-field">
        <span className="pis-label">Name</span>
        <input className="pis-input" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="pis-field">
        <span className="pis-label">Description</span>
        <textarea
          className="pis-input"
          rows={3}
          maxLength={200}
          value={description}
          placeholder="One or two sentences on what it does."
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="pis-field">
        <span className="pis-label">Cover</span>
        <div className="pis-covers" role="radiogroup" aria-label="Cover">
          <button
            type="button"
            role="radio"
            aria-checked={choice === "cover"}
            className={`pis-cover ${choice === "cover" ? "is-on" : ""}`}
            disabled={!hasCover}
            onClick={() => setChoice("cover")}
          >
            {hasCover ? (
              <img src={appCoverUrl(appId, coverVersion)} alt="" onError={() => setHasCover(false)} />
            ) : (
              <span className="pis-empty">No picture yet</span>
            )}
            <span className="pis-cap">Use as cover</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={choice === "banner"}
            className={`pis-cover ${choice === "banner" ? "is-on" : ""}`}
            onClick={() => setChoice("banner")}
          >
            <span className="pis-banner" />
            <span className="pis-cap">Use banner</span>
          </button>
        </div>
        <div className="pis-row">
          <button type="button" className="ss6-btn" disabled={retaking} onClick={() => void retake()}>
            {retaking ? "Taking picture…" : "Retake"}
          </button>
          <span className="pis-hint">
            The picture can show your own data. It's only shared if you pick it.
          </span>
        </div>
      </div>
      {error ? <p className="pis-error">{error}</p> : null}
      <div className="pis-foot">
        <button type="button" className="ss6-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ss6-btn ss6-btn--primary" disabled={saving} onClick={() => void confirm()}>
          {saving ? "Saving…" : mode === "edit" ? "Save" : "Publish"}
        </button>
      </div>
    </div>
  );
}
