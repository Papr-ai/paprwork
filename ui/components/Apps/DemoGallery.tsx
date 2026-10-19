/**
 * Gallery: one big view with six thumbnails below (the video first, then five screens),
 * the same order as on the catalog card. Click a thumbnail to open it large; the sheet
 * keeps one width. Comment comments on whatever is open (a video moment or a screen,
 * optionally a pinned spot); one Revise makes the next version. Owner-only, private
 * until approved (Save in App info, List in Community in Share).
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
import { DemoComments, DemoDraft, type Pin } from "./DemoComments";
import { DemoPlayer } from "./DemoPlayer";
import { DefaultCover } from "./DefaultCover";
import "./DemoNotes.css";
import "./DemoGallery.css";

const MIN_SCREENS = 4;
const SLOTS = 6;
const STAGE = { writing: "Writing the scene", recording: "Recording", reviewing: "Checking how it looks", polishing: "Polishing", revising: "Applying your comments", screens: "Picking the screens" } as const;
const SPARKLE = "M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4zM12.5 10.5l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z";

export function DemoGallery({ appId, appName, demo, onMake }: { appId: string; appName: string; demo: DemoStatus; onMake: () => void }) {
  const current = demo.current ?? 0;
  const [viewing, setViewing] = useState(current);
  const [item, setItem] = useState(0);
  const [composing, setComposing] = useState(false);
  const [pin, setPin] = useState<Pin | null>(null);
  const [at, setAt] = useState(0);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const making = demo.task?.state === "running" && demo.task?.kind !== "revise";
  const ver = (demo.versions ?? []).find((v) => v.v === viewing);
  const screens = ver?.screens ?? [];
  const kept = screens.filter((s) => !s.hidden).length;
  const open = (demo.notes ?? []).filter((n) => !n.fixedIn);
  const openOn = (k: number) => open.filter((n) => (n.on ?? 0) === k && n.v === viewing);

  useEffect(() => setViewing(current), [current]);
  useEffect(() => {
    if (current && current > (demo.seen ?? 0)) void markGallerySeen(appId).catch(() => undefined);
  }, [appId, current, demo.seen]);

  const run = (p: Promise<unknown>) => {
    setError(null);
    void p.catch((err: Error) => setError(err.message));
  };
  const show = (k: number) => {
    video.current?.pause();
    if (k !== item) setPin(null);
    setItem(k);
  };
  // Comment mode: a click on the picture drops the pin and opens the box right there.
  const place = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!composing) return;
    video.current?.pause();
    const r = e.currentTarget.getBoundingClientRect();
    setPin({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };
  const stopComposing = () => { setComposing(false); setPin(null); };
  const pins = (k: number) => [
    ...openOn(k).filter((n) => n.x != null && (k > 0 || Math.abs(n.t - at) <= 0.6))
      .map((n) => <span key={n.id} className="dn-pin" style={{ left: `${n.x! * 100}%`, top: `${n.y! * 100}%` }} title={n.body} />),
    ...(composing && pin ? [
      <span key="draft" className="dn-pin is-draft" style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }} />,
      <DemoDraft key={`box-${k}-${pin.x}-${pin.y}`} appId={appId} item={k} at={at} pin={pin} onDone={stopComposing} />,
    ] : []),
    ...(composing && !pin ? [<span key="hint" className="dn-hint">Click where something should change</span>] : []),
  ];
  const badge = (k: number) => (openOn(k).length ? <b className="dg-thn">{openOn(k).length}</b> : null);

  // Nothing yet: the default cover is what ships; one button generates the rest.
  if (!current && !making) {
    return (
      <div className="dg">
        <div className="dg-box">
          <DefaultCover name={appName} tag="Default cover">
            <button type="button" className="ss6-btn dg-gen" onClick={onMake}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden><path d={SPARKLE} /></svg>
              Generate video and screens
            </button>
          </DefaultCover>
        </div>
        <Slots />
      </div>
    );
  }
  if (making) {
    return (
      <div className="dg">
        <div className="dg-box dg-making"><span className="pis-spin" aria-hidden /><b>{STAGE[demo.task?.stage ?? "writing"]}…</b><span>Takes a few minutes. You can close this.</span></div>
        <Slots />
      </div>
    );
  }

  const s = item ? screens[item - 1] : undefined;
  return (
    <div className="dg">
      <div className="dg-tools">
        {(demo.versions ?? []).length > 1 ? (demo.versions ?? []).map((v) => (
          <button key={v.v} type="button" className={`dn-ver ${v.v === viewing ? "is-on" : ""}`} onClick={() => setViewing(v.v)}>
            v{v.v}{v.v === current ? <span className="dn-dot" aria-label="in use" /> : null}
          </button>
        )) : null}
        {viewing !== current ? <button type="button" className="pis-link" onClick={() => run(useDemoVersion(appId, viewing))}>Use v{viewing}</button> : null}
        <span className="dg-ibs">
          <button type="button" className={`dg-ib ${composing ? "is-on" : ""}`} aria-label="Comment"
            title={item ? `Comment on screen ${item}` : "Comment on the video"}
            onClick={() => { video.current?.pause(); if (composing) stopComposing(); else setComposing(true); }}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" /></svg>
            {open.length ? <b>{open.length}</b> : null}
          </button>
          <button type="button" className="dg-ib" aria-label="Download all" title={flash ? "Saved to Downloads" : "Download all"}
            onClick={() => run(downloadGallery(appId).then(() => { setFlash(true); setTimeout(() => setFlash(false), 1600); }))}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={flash ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={flash ? "m3.5 8.5 3 3 6-7" : "M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13.5h10"} />
            </svg>
          </button>
        </span>
      </div>

      {item === 0 || !s ? (
        <DemoPlayer key={viewing} src={appDemoVersionUrl(appId, viewing)} poster={appDemoVersionUrl(appId, viewing, "poster")}
          videoRef={video} pinning={composing} onTime={setAt} onPlace={place}
          marks={openOn(0).map((n) => ({ id: n.id, t: n.t }))}>
          {pins(0)}
        </DemoPlayer>
      ) : (
        <div className={`dg-box dg-shot ${s.style === "scene" ? "is-scene" : ""} ${composing ? "is-pinning" : ""} ${s.hidden ? "is-off" : ""}`} onClick={place}>
          {s.style === "scene" ? null : (
            <input key={`${viewing}-${item}`} className="dg-cap" defaultValue={s.caption} maxLength={40} aria-label={`Caption for screen ${item}`}
              disabled={viewing !== current} onClick={(e) => e.stopPropagation()}
              onBlur={(e) => e.target.value.trim() !== s.caption && run(updateDemoScreen(appId, item, { caption: e.target.value }))} />
          )}
          <img src={appDemoScreenUrl(appId, item, viewing, demo.updatedAt)} alt={s.caption} />
          {pins(item)}
          {viewing === current && (s.hidden || kept > MIN_SCREENS) ? (
            <button type="button" className={`dg-x ${s.hidden ? "is-back" : ""}`}
              onClick={(e) => { e.stopPropagation(); run(updateDemoScreen(appId, item, { hidden: !s.hidden })); }}>
              {s.hidden ? "Put back" : "Leave out"}
            </button>
          ) : null}
        </div>
      )}
      {s?.style === "scene" && item !== 0 && viewing === current ? (
        <div className="dg-words" key={`w-${viewing}-${item}-${s.caption}-${s.sub ?? ""}`}>
          <input className="dg-words__h" defaultValue={s.caption} maxLength={40} aria-label={`Headline for screen ${item}`}
            onBlur={(e) => e.target.value.trim() !== s.caption && run(updateDemoScreen(appId, item, { caption: e.target.value }))} />
          <input className="dg-words__s" defaultValue={s.sub ?? ""} maxLength={70} placeholder="Supporting line" aria-label={`Supporting line for screen ${item}`}
            onBlur={(e) => e.target.value.trim() !== (s.sub ?? "") && run(updateDemoScreen(appId, item, { sub: e.target.value }))} />
        </div>
      ) : null}

      <div className="dg-minis">
        <button type="button" className={`dg-mini ${item === 0 ? "is-on" : ""}`} aria-label="Video" onClick={() => show(0)}>
          <img src={appDemoVersionUrl(appId, viewing, "poster")} alt="" /><span className="dg-thplay" aria-hidden />{badge(0)}
        </button>
        {Array.from({ length: SLOTS - 1 }, (_, j) => screens[j] ? (
          <button key={j} type="button" className={`dg-mini ${item === j + 1 ? "is-on" : ""} ${screens[j].hidden ? "is-off" : ""}`}
            aria-label={`Screen ${j + 1}: ${screens[j].caption}`} onClick={() => show(j + 1)}>
            <img src={appDemoScreenUrl(appId, j + 1, viewing, demo.updatedAt)} alt="" />{badge(j + 1)}
          </button>
        ) : <span key={j} className="dg-mini is-slot" />)}
      </div>

      {open.length ? (
        <DemoComments appId={appId} demo={demo} screens={screens}
          onSeek={(on, t) => {
            show(on);
            if (!on) requestAnimationFrame(() => { if (video.current) { video.current.pause(); video.current.currentTime = t; setAt(t); } });
          }} />
      ) : null}
      {error ? <p className="pis-error">{error}</p> : null}
    </div>
  );
}

function Slots() {
  return <div className="dg-minis">{Array.from({ length: SLOTS }, (_, i) => <span key={i} className="dg-mini is-slot" />)}</div>;
}
