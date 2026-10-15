/**
 * Gallery comments: write one on the selected slide (a video moment or a screen, optionally
 * pinned to a spot), see the open ones, then one Revise makes the next version of the video
 * and the screens. Same model as Launch Video Studio. Owner-only and private.
 */
import { useState } from "react";
import { addDemoNote, deleteDemoNote, reviseDemo, type DemoNote, type DemoScreen, type DemoStatus } from "../../utils/appDemo";

export interface Pin {
  x: number;
  y: number;
}

const where = (n: DemoNote, screens: DemoScreen[]) =>
  n.on ? screens[n.on - 1]?.caption ?? `Screen ${n.on}` : `Video ${n.t.toFixed(1)}s`;

export function DemoComments(props: {
  appId: string;
  demo: DemoStatus;
  /** 0 = the video, k = screen k. */
  item: number;
  at: number;
  screens: DemoScreen[];
  pin: Pin | null;
  pinning: boolean;
  setPin: (p: Pin | null) => void;
  setPinning: (p: boolean) => void;
  onSeek: (on: number, t: number) => void;
}) {
  const { appId, demo, item, at, screens, pin, pinning, setPin, setPinning, onSeek } = props;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = demo.task?.state === "running";
  const open = (demo.notes ?? []).filter((n) => !n.fixedIn).sort((a, b) => (a.on ?? 0) - (b.on ?? 0) || a.t - b.t);
  const fixed = (demo.notes ?? []).filter((n) => n.fixedIn);
  const label = item ? screens[item - 1]?.caption ?? `Screen ${item}` : `the video at ${at.toFixed(1)}s`;

  const run = (p: Promise<void>, after?: () => void) => {
    setError(null);
    void p.then(after).catch((err: Error) => setError(err.message));
  };
  const add = () => {
    const body = draft.trim();
    if (!body) return;
    run(addDemoNote(appId, { t: item ? 0 : at, body, ...(item ? { on: item } : {}), ...pin }), () => {
      setDraft("");
      setPin(null);
    });
  };

  return (
    <div className="dn">
      <div className="dn-compose">
        <textarea className="pis-input" rows={1} value={draft} maxLength={1000} autoFocus
          placeholder={`What should change on ${label}?`} aria-label="New comment"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); add(); } }} />
        <div className="dn-compose-row">
          <span className="dn-at">On <b>{label}</b></span>
          <button type="button" className={`pis-link ${pin ? "is-set" : ""}`} onClick={() => (pin ? setPin(null) : setPinning(!pinning))}>
            {pin ? "Remove point" : pinning ? "Click the spot" : "Point at something"}
          </button>
          <button type="button" className="ss6-btn" disabled={!draft.trim()} onClick={add}>Add comment</button>
        </div>
      </div>

      {open.length ? (
        <ul className="dn-list">
          {open.map((n) => (
            <li key={n.id}>
              <button type="button" className="dn-t" onClick={() => onSeek(n.on ?? 0, n.t)}>{where(n, screens)}</button>
              <span className="dn-body">{n.x != null ? <span className="dn-mark" aria-label="pinned" /> : null}{n.body}</span>
              <button type="button" className="dn-x" aria-label="Delete comment" onClick={() => run(deleteDemoNote(appId, n.id))}>×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pis-hint">Pick the video or a screen and say what should change. One Revise fixes them all.</p>
      )}

      {open.length ? (
        <div className="dn-foot">
          <button type="button" className="ss6-btn ss6-btn--primary" disabled={busy} onClick={() => run(reviseDemo(appId))}>
            Revise with {open.length} comment{open.length === 1 ? "" : "s"}
          </button>
        </div>
      ) : null}
      {fixed.length ? <p className="pis-hint">{fixed.length} fixed in earlier versions</p> : null}
      {error ? <p className="pis-error">{error}</p> : null}
    </div>
  );
}
