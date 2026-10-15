/**
 * App info — how the app appears to people (Share Bar Redesign v10). Two steps, like Share:
 *  1. Details — name, headline, description.
 *  2. Gallery — the preview video and five screens in one row (DemoGallery).
 * Shown before the first Publish and from More → App info / the status chip's "Review gallery".
 * The gallery is made in the background; Save shares it, or a plain banner when there is none.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import { setAppCoverShared } from "../../utils/appCover";
import { shareDemoVideo, startDemoGeneration, useDemoStatus } from "../../utils/appDemo";
import { DemoGallery } from "./DemoGallery";
import "./PublishInfoSheet.css";

interface PublishInfoSheetProps {
  appId: string;
  initialTitle: string;
  onCancel: () => void;
  /** Called after name/description/gallery are saved (publish: continue publishing). */
  onConfirmed: () => void;
  /** "publish" = first Publish step; "edit" = More → App info on a live/draft app. */
  mode?: "publish" | "edit";
  /** Open on the Gallery step (the status chip's "Review gallery"). */
  initialStep?: 1 | 2;
}

export function PublishInfoSheet({ appId, initialTitle, onCancel, onConfirmed, mode = "publish", initialStep = 1 }: PublishInfoSheetProps) {
  const [step, setStep] = useState<1 | 2>(initialStep);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [headline, setHeadline] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const demo = useDemoStatus(appId);
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
    if (demo?.task?.state === "failed") setError(demo.task.error ?? "Couldn't make the gallery.");
  }, [demo?.task?.state, demo?.task?.error]);

  const make = () => {
    setError(null);
    void startDemoGeneration(appId).catch((err: Error) => setError(err.message));
  };

  const next = () => {
    if (!title.trim()) {
      setError("Give the app a name.");
      return;
    }
    setError(null);
    setStep(2);
  };

  const confirm = async () => {
    const name = title.trim();
    if (!name) {
      setStep(1);
      setError("Give the app a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await gateway.send("app:update", { appId, title: name, description: description.trim(), headline: headline.trim() });
      if (hasVideo) {
        if (!(await shareDemoVideo(appId))) throw new Error("Couldn't share the gallery.");
      } else if (mode === "publish" || demo?.sharedKind == null) {
        await setAppCoverShared(appId, false);
      }
      onConfirmed();
    } catch (err) {
      setError((err as Error).message || "Couldn't save app info.");
      setSaving(false);
    }
  };

  return (
    <div className={`pis ${step === 2 ? "pis--gallery" : ""}`}>
      <div className="pis-body">
        <p className="pis-step">
          <b>{step === 1 ? "Details" : "Gallery"}</b> · Step {step} of 2{step === 2 ? " · Optional, required to list in Community" : ""}
        </p>
        {step === 1 ? (
          <>
            <label className="pis-field">
              <span className="pis-label">Name</span>
              <input className="pis-input" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="pis-field">
              <span className="pis-label">Headline</span>
              <input className="pis-input" maxLength={80} value={headline}
                placeholder="One line: what it does for you" onChange={(e) => setHeadline(e.target.value)} />
            </label>
            <label className="pis-field">
              <span className="pis-label">Description</span>
              <textarea className="pis-input" rows={3} maxLength={200} value={description}
                placeholder="One or two sentences on what it does." onChange={(e) => setDescription(e.target.value)} />
            </label>
          </>
        ) : demo ? (
          <DemoGallery appId={appId} demo={demo} onMake={make} />
        ) : null}
        {error ? <p className="pis-error">{error}</p> : null}
      </div>
      <div className="pis-foot">
        {step === 1 ? (
          <>
            <button type="button" className="ss6-btn" onClick={onCancel}>Cancel</button>
            <button type="button" className="ss6-btn ss6-btn--primary" onClick={next}>Next</button>
          </>
        ) : (
          <>
            <button type="button" className="ss6-btn" onClick={() => setStep(1)}>Back</button>
            <button type="button" className="ss6-btn ss6-btn--primary" disabled={saving} onClick={() => void confirm()}>
              {saving ? "Saving…" : mode === "edit" ? "Save" : "Publish"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
