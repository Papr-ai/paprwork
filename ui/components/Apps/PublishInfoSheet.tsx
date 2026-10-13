/**
 * App info — name, description and cover: how the app appears to people (Share Bar
 * Redesign v6). Shown before the first Publish and from More → App info.
 *
 * Cover, three choices (one is shared, only when the user saves):
 *  - Preview video — a 3-5s loop the Papr agent makes from the app's code with sample
 *    data. The default: it explains the app and never shows the user's own data.
 *  - Screenshot   — the user's latest private picture of the app (can show real data).
 *  - Banner       — no picture.
 * Making the video runs in the background; the sheet can close and the card updates.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { appCoverUrl, setAppCoverShared } from "../../utils/appCover";
import { appDemoPosterUrl, appDemoVideoUrl, shareDemoVideo, startDemoGeneration, useDemoStatus } from "../../utils/appDemo";
import { getGatewayHttpBase } from "../../utils/gatewayHttpBase";
import { DemoVideo } from "./DemoVideo";
import "./PublishInfoSheet.css";

type CoverChoice = "video" | "cover" | "banner";

const STAGE_LABEL = { writing: "Writing the scene…", recording: "Recording…", polishing: "Polishing…" } as const;

interface PublishInfoSheetProps {
  appId: string;
  initialTitle: string;
  onCancel: () => void;
  /** Called after name/description/cover are saved (publish: continue publishing). */
  onConfirmed: () => void;
  /** "publish" = first Publish step; "edit" = More → App info on a live/draft app. */
  mode?: "publish" | "edit";
}

export function PublishInfoSheet({ appId, initialTitle, onCancel, onConfirmed, mode = "publish" }: PublishInfoSheetProps) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [headline, setHeadline] = useState("");
  const [shotVersion, setShotVersion] = useState(() => String(Date.now()));
  const [hasShot, setHasShot] = useState(true);
  const [choice, setChoice] = useState<CoverChoice | null>(null);
  const [retaking, setRetaking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const demo = useDemoStatus(appId);
  const making = demo?.task?.state === "running";
  const hasVideo = Boolean(demo?.exists);

  useEffect(() => {
    let cancelled = false;
    void gateway.send("app:get", { appId }).then((resp) => {
      const data = resp.data as { title?: string; description?: string; headline?: string } | undefined;
      if (cancelled || !data) return;
      if (data.title) setTitle(data.title);
      setDescription(data.description ?? "");
      setHeadline(data.headline ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  // Start from what is shared today; otherwise prefer the video (sample data only).
  useEffect(() => {
    if (choice !== null || !demo) return;
    if (mode === "edit" && demo.sharedKind === "image") setChoice("cover");
    else if (mode === "edit" && demo.sharedKind == null && !hasVideo) setChoice("banner");
    else setChoice("video");
  }, [demo, choice, mode, hasVideo]);

  useEffect(() => {
    if (demo?.task?.state === "failed") setError(demo.task.error ?? "Couldn't make the preview video.");
  }, [demo?.task?.state, demo?.task?.error]);

  const makeVideo = async () => {
    setError(null);
    setChoice("video");
    try {
      await startDemoGeneration(appId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const retake = async () => {
    setRetaking(true);
    setError(null);
    try {
      const res = await fetch(`${getGatewayHttpBase()}/api/apps/${encodeURIComponent(appId)}/cover/retake`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { saved?: boolean; reason?: string };
      if (body.saved) {
        setHasShot(true);
        setChoice("cover");
        setShotVersion(String(Date.now()));
      } else {
        setError(body.reason === "blank" ? "The app looked empty, so the old picture was kept." : "Couldn't take a new picture right now.");
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
      await gateway.send("app:update", { appId, title: name, description: description.trim(), headline: headline.trim() });
      if (choice === "video" && hasVideo) {
        if (!(await shareDemoVideo(appId))) throw new Error("Couldn't share the preview video.");
      } else {
        await setAppCoverShared(appId, choice === "cover" && hasShot);
      }
      onConfirmed();
    } catch (err) {
      setError((err as Error).message || "Couldn't save app info.");
      setSaving(false);
    }
  };

  const v = demo?.updatedAt ?? null;
  const tile = (id: CoverChoice, label: string, art: React.ReactNode, disabled = false) => (
    <button type="button" role="radio" aria-checked={choice === id} disabled={disabled}
      className={`pis-cover ${choice === id ? "is-on" : ""}`} onClick={() => setChoice(id)}>
      <span className="pis-art">{art}</span>
      <span className="pis-cap">{label}</span>
    </button>
  );

  return (
    <div className="pis">
      <div className="pis-body">
      <p className="pis-lead">This is how the app appears to people you share it with.</p>
      <label className="pis-field">
        <span className="pis-label">Name</span>
        <input className="pis-input" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="pis-field">
        <span className="pis-label">Description</span>
        <textarea className="pis-input" rows={2} maxLength={200} value={description}
          placeholder="One or two sentences on what it does." onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="pis-field">
        <span className="pis-label">Headline <em className="pis-opt">optional</em></span>
        <input className="pis-input" maxLength={120} value={headline}
          placeholder="Skip the standup meeting. Keep the standup." onChange={(e) => setHeadline(e.target.value)} />
        <span className="pis-hint">Shown big if the app is featured in Community.</span>
      </label>

      <div className="pis-field">
        <span className="pis-label">Cover</span>
        <div className="pis-hero">
          {choice === "video" && hasVideo && !making ? (
            <DemoVideo className="pis-media" src={appDemoVideoUrl(appId, v)} poster={appDemoPosterUrl(appId, v)} />
          ) : choice === "video" ? (
            <div className={`pis-make ${making ? "is-busy" : ""}`}>
              {making ? (
                <>
                  <span className="pis-spin" aria-hidden="true" />
                  <b>{STAGE_LABEL[demo?.task?.stage ?? "writing"]}</b>
                  <span>About a minute. You can close this — the card updates when it's ready.</span>
                </>
              ) : (
                <>
                  <b>Show what your app does</b>
                  <span>Papr makes a short looping video from your app's code, with sample data.</span>
                  <button type="button" className="ss6-btn ss6-btn--primary" onClick={() => void makeVideo()}>
                    Make preview video
                  </button>
                </>
              )}
            </div>
          ) : choice === "cover" && hasShot ? (
            <img className="pis-media" src={appCoverUrl(appId, shotVersion)} alt="" onError={() => setHasShot(false)} />
          ) : (
            <span className="pis-banner" />
          )}
        </div>
        <div className="pis-covers" role="radiogroup" aria-label="Cover">
          {tile("video", "Preview video", hasVideo
            ? <img src={appDemoPosterUrl(appId, v)} alt="" />
            : <span className="pis-empty">{making ? "Making…" : "Not made yet"}</span>)}
          {tile("cover", "Screenshot", hasShot
            ? <img src={appCoverUrl(appId, shotVersion)} alt="" onError={() => setHasShot(false)} />
            : <span className="pis-empty">No picture yet</span>, !hasShot)}
          {tile("banner", "Banner", <span className="pis-banner" />)}
        </div>
        <div className="pis-row">
          {choice === "video" && hasVideo ? (
            <button type="button" className="pis-link" disabled={making} onClick={() => void makeVideo()}>
              {making ? STAGE_LABEL[demo?.task?.stage ?? "writing"] : "Make a new one"}
            </button>
          ) : choice === "cover" ? (
            <button type="button" className="pis-link" disabled={retaking} onClick={() => void retake()}>
              {retaking ? "Taking picture…" : "Retake"}
            </button>
          ) : null}
          <span className="pis-hint">
            {choice === "cover"
              ? "Screenshots can show your own data. Only shared if you pick it."
              : choice === "video"
                ? "Sample data only — safe to share."
                : "A plain banner with the app's icon."}
          </span>
        </div>
      </div>

      {error ? <p className="pis-error">{error}</p> : null}
      </div>
      <div className="pis-foot">
        <button type="button" className="ss6-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="ss6-btn ss6-btn--primary"
          disabled={saving || (choice === "video" && !hasVideo)} onClick={() => void confirm()}>
          {saving ? "Saving…" : mode === "edit" ? "Save" : "Publish"}
        </button>
      </div>
    </div>
  );
}
