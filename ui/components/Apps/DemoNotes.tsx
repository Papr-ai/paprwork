/**
 * Preview video review: watch a version, leave notes on moments (optionally pinned on the
 * frame), then one Revise makes the next version that addresses all open notes.
 * Same model as Launch Video Studio, sized for a 4-second loop inside App info.
 * Owner-only and private: notes and versions never leave this Mac.
 */
import { useEffect, useRef, useState } from "react";
import {
  addDemoNote,
  appDemoVersionUrl,
  deleteDemoNote,
  reviseDemo,
  useDemoVersion,
  type DemoNote,
  type DemoStatus,
} from "../../utils/appDemo";
import "./DemoNotes.css";

const fmt = (t: number) => `${t.toFixed(1)}s`;

export function DemoNotes({ appId, demo }: { appId: string; demo: DemoStatus }) {
  const current = demo.current ?? 0;
  const versions = demo.versions ?? [];
  const notes = demo.notes ?? [];
  const [viewing, setViewing] = useState(current);
  const [draft, setDraft] = useState("");
  const [at, setAt] = useState(0);
  const [pin, setPin] = useState<{ x: number; y: number } | null>(null);
  const [pinning, setPinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const busy = demo.task?.state === "running";

  // Follow the newest version when a run finishes (or on first load).
  useEffect(() => setViewing(current), [current]);

  const open = notes.filter((n) => !n.fixedIn).sort((a, b) => a.t - b.t);
  const fixed = notes.filter((n) => n.fixedIn).sort((a, b) => (b.fixedIn ?? 0) - (a.fixedIn ?? 0));
  const near = (n: DemoNote) => n.v === viewing && Math.abs(n.t - at) <= 0.6;

  const seek = (t: number) => {
    const el = video.current;
    if (!el) return;
    el.pause();
    el.currentTime = t;
    setAt(t);
  };

  const onStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!pinning) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPin({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    setPinning(false);
  };

  const add = async () => {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    try {
      await addDemoNote(appId, { t: at, body, ...(pin ?? {}) });
      setDraft("");
      setPin(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const run = (p: Promise<void>) => {
    setError(null);
    void p.catch((err: Error) => setError(err.message));
  };

  return (
    <div className="dn">
      <div className={`dn-stage ${pinning ? "is-pinning" : ""}`} onClick={onStageClick}>
        <video
          ref={video}
          key={viewing}
          className="dn-video"
          src={appDemoVersionUrl(appId, viewing)}
          poster={appDemoVersionUrl(appId, viewing, "poster")}
          muted
          loop
          playsInline
          controls={!pinning}
          onTimeUpdate={(e) => setAt(Math.round(e.currentTarget.currentTime * 10) / 10)}
          onPlay={() => setPinning(false)}
        />
        {notes.filter((n) => n.x != null && n.y != null && near(n)).map((n) => (
          <span key={n.id} className={`dn-pin ${n.fixedIn ? "is-done" : ""}`} style={{ left: `${n.x! * 100}%`, top: `${n.y! * 100}%` }} title={n.body} />
        ))}
        {pin ? <span className="dn-pin is-draft" style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }} /> : null}
        {pinning ? <span className="dn-hint">Click the spot to point at</span> : null}
      </div>

      {versions.length > 1 ? (
        <div className="dn-versions" role="tablist" aria-label="Versions">
          {versions.map((v) => (
            <button key={v.v} type="button" role="tab" aria-selected={v.v === viewing}
              className={`dn-ver ${v.v === viewing ? "is-on" : ""}`} onClick={() => setViewing(v.v)}
              title={v.kind === "revise" ? `Fixed ${v.notes ?? 0} note${v.notes === 1 ? "" : "s"}` : "First make"}>
              v{v.v}{v.v === current ? <span className="dn-dot" aria-label="in use" /> : null}
            </button>
          ))}
          {viewing !== current ? (
            <button type="button" className="pis-link" onClick={() => run(useDemoVersion(appId, viewing))}>Use v{viewing}</button>
          ) : null}
        </div>
      ) : null}

      <div className="dn-compose">
        <textarea className="pis-input" rows={1} value={draft} maxLength={1000}
          placeholder="What should change at this moment?" aria-label="New note"
          onFocus={() => video.current?.pause()} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void add(); } }} />
        <div className="dn-compose-row">
          <span className="dn-at">at <b>{fmt(at)}</b></span>
          <button type="button" className={`pis-link ${pin ? "is-set" : ""}`}
            onClick={() => (pin ? setPin(null) : (video.current?.pause(), setPinning(true)))}>
            {pin ? "Remove point" : "Point at something"}
          </button>
          <button type="button" className="ss6-btn" disabled={!draft.trim()} onClick={() => void add()}>Add note</button>
        </div>
      </div>

      {open.length ? (
        <ul className="dn-list">
          {open.map((n) => (
            <li key={n.id}>
              <button type="button" className="dn-t" onClick={() => { setViewing(n.v); seek(n.t); }}>{fmt(n.t)}</button>
              <span className="dn-body">{n.x != null ? <span className="dn-mark" aria-label="pinned" /> : null}{n.body}</span>
              {n.v !== current ? <span className="dn-chip">from v{n.v}</span> : null}
              <button type="button" className="dn-x" aria-label="Delete note" onClick={() => run(deleteDemoNote(appId, n.id))}>×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pis-hint">Pause where something's off and say what should change. One Revise fixes them all.</p>
      )}

      {open.length ? (
        <div className="dn-foot">
          <button type="button" className="ss6-btn ss6-btn--primary" disabled={busy} onClick={() => run(reviseDemo(appId))}>
            Revise with {open.length} note{open.length === 1 ? "" : "s"}
          </button>
          {busy ? <span className="pis-hint">Working on v{Math.max(0, ...versions.map((v) => v.v)) + 1}…</span> : null}
        </div>
      ) : null}

      {fixed.length ? (
        <details className="dn-done">
          <summary>{fixed.length} fixed</summary>
          <ul className="dn-list">
            {fixed.map((n) => (
              <li key={n.id} className="is-done">
                <button type="button" className="dn-t" onClick={() => { setViewing(n.fixedIn!); seek(n.t); }}>{fmt(n.t)}</button>
                <span className="dn-body">{n.body}</span>
                <span className="dn-chip">fixed in v{n.fixedIn}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {error ? <p className="pis-error">{error}</p> : null}
    </div>
  );
}
