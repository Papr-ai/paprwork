/**
 * App info — name, description and cover: how the app appears to people (Share Bar
 * Redesign v6). Shown before the first Publish and from More → App info.
 *
 * Cover choices (one is shared when the user saves):
 *  - Preview video — a 3-5s loop from the app's code with sample data (default).
 *  - Banner — no picture.
 * Making the video runs in the background; the sheet can close and the card updates.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { setAppCoverShared } from "../../utils/appCover";
import { appDemoPosterUrl, appDemoVideoUrl, shareDemoVideo, startDemoGeneration, useDemoStatus } from "../../utils/appDemo";
import { DemoVideo } from "./DemoVideo";
import "./PublishInfoSheet.css";

type CoverChoice = "video" | "banner";

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
  const [choice, setChoice] = useState<CoverChoice | null>(null);
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

  useEffect(() => {
    if (choice !== null || !demo) return;
    if (mode === "edit" && demo.sharedKind === "image") setChoice("banner");
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
        await setAppCoverShared(appId, false);
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
                  <span>Takes a few minutes. You can close this — the card updates when it's ready.</span>
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
          ) : (
            <span className="pis-banner" />
          )}
        </div>
        <div className="pis-covers" role="radiogroup" aria-label="Cover">
          {tile("video", "Preview video", hasVideo
            ? <img src={appDemoPosterUrl(appId, v)} alt="" />
            : <span className="pis-empty">{making ? "Making…" : "Not made yet"}</span>)}
          {tile("banner", "Banner", <span className="pis-banner" />)}
        </div>
        <div className="pis-row">
          {choice === "video" && hasVideo ? (
            <button type="button" className="pis-link" disabled={making} onClick={() => void makeVideo()}>
              {making ? STAGE_LABEL[demo?.task?.stage ?? "writing"] : "Make a new one"}
            </button>
          ) : null}
          <span className="pis-hint">
            {choice === "video"
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
