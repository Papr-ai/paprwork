/**
 * Gallery comments: write one on the open slide (a video moment or a screen, optionally
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
  screens: DemoScreen[];
  onSeek: (on: number, t: number) => void;
}) {
  const { appId, demo, screens, onSeek } = props;
  const [error, setError] = useState<string | null>(null);
  const busy = demo.task?.state === "running";
  const open = (demo.notes ?? []).filter((n) => !n.fixedIn).sort((a, b) => (a.on ?? 0) - (b.on ?? 0) || a.t - b.t);
  const fixed = (demo.notes ?? []).filter((n) => n.fixedIn);
  const run = (p: Promise<void>, after?: () => void) => {
    setError(null);
    void p.then(after).catch((err: Error) => setError(err.message));
  };
  return (
    <div className="dn">

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
      ) : null}

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

/**
 * The comment box that opens right at the clicked spot, like Launch Video Studio: type,
 * Enter (or Add) saves it on that moment / screen; Esc or Cancel closes.
 */
export function DemoDraft({ appId, item, at, pin, onDone }: { appId: string; item: number; at: number; pin: Pin; onDone: () => void }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const label = item ? `screen ${item}` : `${at.toFixed(1)}s`;
  const add = () => {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    void addDemoNote(appId, { t: item ? 0 : at, body, ...(item ? { on: item } : {}), ...pin })
      .then(onDone).catch((err: Error) => setError(err.message));
  };
  const flipX = pin.x > 0.55;
  const flipY = pin.y > 0.6;
  return (
    <div className={`dn-draft ${flipX ? "is-left" : ""} ${flipY ? "is-up" : ""}`} style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
      onClick={(e) => e.stopPropagation()}>
      <form className="dn-draft__box" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <textarea rows={2} value={draft} maxLength={1000} autoFocus aria-label="New comment"
          placeholder="What should change here?" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onDone();
            else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); add(); }
          }} />
        <div className="dn-draft__row">
          <span className="dn-at">On <b>{label}</b></span>
          <button type="button" className="pis-link dn-cancel" onClick={onDone}>Cancel</button>
          <button type="submit" className="ss6-btn ss6-btn--primary" disabled={!draft.trim()}>Comment</button>
        </div>
        {error ? <p className="pis-error">{error}</p> : null}
      </form>
    </div>
  );
}
