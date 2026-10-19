/**
 * App info — how the app appears to people (Share Bar Redesign v10).
 *  - First Publish: Details only (name, headline, description). The app goes live with the
 *    default Papr-blue cover; a gallery is only asked for when it is listed in Community
 *    (Share → Community adds a required Gallery step).
 *  - More → App info: 1. Details, 2. Gallery (optional). Save approves the gallery if there
 *    is one; without one the default cover stays.
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
  const publish = mode === "publish";
  const [step, setStep] = useState<1 | 2>(publish ? 1 : initialStep);
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
      setDescription((cur) => cur || (data.description ?? ""));
      setHeadline((cur) => cur || (data.headline ?? ""));
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

  const next = async () => {
    if (!title.trim()) {
      setError("Give the app a name.");
      return;
    }
    setError(null);
    if (publish) return void confirm();
    // App info: Details save on Next, so closing on the Gallery step never drops a headline edit.
    setSaving(true);
    try {
      await saveDetails();
      setStep(2);
    } catch (err) {
      setError((err as Error).message || "Couldn't save app info.");
    } finally {
      setSaving(false);
    }
  };

  const saveDetails = () =>
    gateway.send("app:update", { appId, title: title.trim(), description: description.trim(), headline: headline.trim() });

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
      await saveDetails();
      if (hasVideo && !publish) {
        if (!(await shareDemoVideo(appId))) throw new Error("Couldn't share the gallery.");
      } else if (publish ? demo?.sharedKind !== "video" : demo?.sharedKind == null) {
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
        {publish ? null : (
          <p className="pis-step">
            <b>{step === 1 ? "Details" : "Gallery"}</b> · Step {step} of 2{step === 2 ? " · Optional" : ""}
          </p>
        )}
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
          <DemoGallery appId={appId} appName={title.trim() || initialTitle} demo={demo} onMake={make} />
        ) : null}
        {error ? <p className="pis-error">{error}</p> : null}
      </div>
      <div className="pis-foot">
        {step === 1 ? (
          <>
            <button type="button" className="ss6-btn" onClick={onCancel}>Cancel</button>
            <button type="button" className="ss6-btn ss6-btn--primary" disabled={saving} onClick={() => void next()}>
              {publish ? (saving ? "Publishing…" : "Publish") : "Next"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ss6-btn" onClick={() => setStep(1)}>Back</button>
            <button type="button" className="ss6-btn ss6-btn--primary" disabled={saving} onClick={() => void confirm()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
