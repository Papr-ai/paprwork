/**
 * Gallery (App info, step 2): one row, the preview video first, then the screens. Scroll right.
 * Versions on the left; Comment and Download all as icons on the right. Comments attach to
 * the selected slide (a video moment or a screen, optionally a pinned spot); one Revise
 * makes the next version of the video and the screens. Owner-only, private until Save.
 */
import { useEffect, useRef, useState } from "react";
import {
  appDemoScreenUrl,
  appDemoVersionUrl,
  downloadGallery,
  markGallerySeen,
  updateDemoScreen,
  useDemoVersion,
  type DemoStatus,
} from "../../utils/appDemo";
import { DemoComments, type Pin } from "./DemoComments";
import "./DemoNotes.css";
import "./DemoGallery.css";

const MIN_SCREENS = 4;
const STAGE = { writing: "Writing the scene", recording: "Recording", reviewing: "Checking how it looks", polishing: "Polishing", revising: "Applying your comments", screens: "Picking the screens" } as const;

export function DemoGallery({ appId, demo, onMake }: { appId: string; demo: DemoStatus; onMake: () => void }) {
  const current = demo.current ?? 0;
  const [viewing, setViewing] = useState(current);
  const [item, setItem] = useState(0);
  const [composing, setComposing] = useState(false);
  const [pin, setPin] = useState<Pin | null>(null);
  const [pinning, setPinning] = useState(false);
  const [at, setAt] = useState(0);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const running = demo.task?.state === "running";
  const making = running && demo.task?.kind !== "revise";
  const ver = (demo.versions ?? []).find((v) => v.v === viewing);
  const screens = ver?.screens ?? [];
  const kept = screens.filter((s) => !s.hidden).length;
  const open = (demo.notes ?? []).filter((n) => !n.fixedIn);

  useEffect(() => setViewing(current), [current]);
  useEffect(() => {
    if (current && current > (demo.seen ?? 0)) void markGallerySeen(appId).catch(() => undefined);
  }, [appId, current, demo.seen]);

  const run = (p: Promise<unknown>) => {
    setError(null);
    void p.catch((err: Error) => setError(err.message));
  };
  const select = (k: number) => {
    if (k !== item) setPin(null);
    setItem(k);
  };
  const place = (k: number, e: React.MouseEvent<HTMLDivElement>) => {
    select(k);
    if (!pinning || k !== item) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPin({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    setPinning(false);
  };
  const pins = (k: number) => [
    ...open.filter((n) => (n.on ?? 0) === k && n.v === viewing && n.x != null && (k > 0 || Math.abs(n.t - at) <= 0.6))
      .map((n) => <span key={n.id} className="dn-pin" style={{ left: `${n.x! * 100}%`, top: `${n.y! * 100}%` }} title={n.body} />),
    ...(pin && k === item ? [<span key="draft" className="dn-pin is-draft" style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }} />] : []),
  ];
  const download = () => run(downloadGallery(appId).then(() => {
    setFlash("dl");
    setTimeout(() => setFlash(""), 1600);
  }));

  if (!current && !making) {
    return (
      <div className="dg-empty">
        <b>Show what your app does</b>
        <span>Papr makes a short video and five screens from your app's code, with sample data.</span>
        <button type="button" className="ss6-btn ss6-btn--primary" onClick={onMake}>Make video and screens</button>
      </div>
    );
  }

  return (
    <div className="dg">
      {current && !making ? (
        <div className="dg-tools">
          {(demo.versions ?? []).length > 1 ? (demo.versions ?? []).map((v) => (
            <button key={v.v} type="button" className={`dn-ver ${v.v === viewing ? "is-on" : ""}`} onClick={() => setViewing(v.v)}>
              v{v.v}{v.v === current ? <span className="dn-dot" aria-label="in use" /> : null}
            </button>
          )) : null}
          {viewing !== current ? <button type="button" className="pis-link" onClick={() => run(useDemoVersion(appId, viewing))}>Use v{viewing}</button> : null}
          <span className="dg-ibs">
            <button type="button" className={`dg-ib ${composing ? "is-on" : ""}`} aria-label="Comment" title="Comment on the selected slide"
              onClick={() => { setComposing((c) => !c); video.current?.pause(); }}>
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" /></svg>
              {open.length ? <b>{open.length}</b> : null}
            </button>
            <button type="button" className="dg-ib" aria-label="Download all" title={flash ? "Saved to Downloads" : "Download all"} onClick={download}>
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={flash ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={flash ? "m3.5 8.5 3 3 6-7" : "M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13.5h10"} />
              </svg>
            </button>
          </span>
        </div>
      ) : null}

      <div className={`dg-strip ${composing ? "is-cmt" : ""}`}>
        <figure className={`dg-item ${composing && item === 0 ? "is-on" : ""}`}>
          {making ? (
            <div className="dg-box dg-making"><span className="pis-spin" aria-hidden /><b>{STAGE[demo.task?.stage ?? "writing"]}…</b><span>Takes a few minutes. You can close this.</span></div>
          ) : (
            <div className={`dg-box ${pinning && item === 0 ? "is-pinning" : ""}`} onClick={(e) => place(0, e)}>
              <video ref={video} key={viewing} className="dn-video" src={appDemoVersionUrl(appId, viewing)} poster={appDemoVersionUrl(appId, viewing, "poster")}
                muted loop playsInline autoPlay controls={!composing} onTimeUpdate={(e) => setAt(Math.round(e.currentTarget.currentTime * 10) / 10)} />
              {pins(0)}
            </div>
          )}
        </figure>
        {(making || !screens.length ? [0, 1, 2, 3, 4].map(() => null) : screens).map((s, j) => s ? (
          <figure key={j} className={`dg-item ${composing && item === j + 1 ? "is-on" : ""} ${s.hidden ? "is-off" : ""}`}>
            <div className={`dg-box dg-shot ${pinning && item === j + 1 ? "is-pinning" : ""}`} onClick={(e) => place(j + 1, e)}>
              <input className="dg-cap" defaultValue={s.caption} maxLength={40} aria-label={`Caption for screen ${j + 1}`} disabled={viewing !== current}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => e.target.value.trim() !== s.caption && run(updateDemoScreen(appId, j + 1, { caption: e.target.value }))} />
              <img src={appDemoScreenUrl(appId, j + 1, viewing, demo.updatedAt)} alt={s.caption} />
              {pins(j + 1)}
              {viewing === current && (s.hidden || kept > MIN_SCREENS) ? (
                <button type="button" className={`dg-x ${s.hidden ? "is-back" : ""}`} aria-label={s.hidden ? "Put back" : `Leave out screen ${j + 1}`}
                  onClick={(e) => { e.stopPropagation(); run(updateDemoScreen(appId, j + 1, { hidden: !s.hidden })); }}>
                  {s.hidden ? "Put back" : "×"}
                </button>
              ) : null}
            </div>
          </figure>
        ) : <figure key={j} className="dg-item is-slot"><div className="dg-box" /></figure>)}
      </div>

      {composing && current && !making ? (
        <DemoComments appId={appId} demo={demo} item={item} at={at} screens={screens} pin={pin} pinning={pinning}
          setPin={setPin} setPinning={(p) => { if (p) video.current?.pause(); setPinning(p); }}
          onSeek={(on, t) => { setItem(on); if (!on && video.current) { video.current.pause(); video.current.currentTime = t; setAt(t); } }} />
      ) : null}
      {error ? <p className="pis-error">{error}</p> : null}
    </div>
  );
}
