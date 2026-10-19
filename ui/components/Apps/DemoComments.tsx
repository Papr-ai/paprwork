/**
 * Gallery comments: write one on the open slide (a video moment or a screen, optionally
 * pinned to a spot), see the open ones, then one Revise makes the next version of the video
 * and the screens. Same model as Launch Video Studio. Owner-only and private.
 */
import { useState } from "react";
import { addDemoNote, deleteDemoNote, reviseDemo, type DemoNote, type DemoScreen, type DemoStatus } from "../../utils/appDemo";
import { useProfileStore } from "../../stores/profileStore";

export interface Pin {
  x: number;
  y: number;
}

const where = (n: DemoNote) => (n.on ? `Screen ${n.on}` : `${n.t.toFixed(1)}s`);

/** The commenter (comments are owner-only, so it's the signed-in user), like Launch Video Studio. */
export function Avatar({ size = 20 }: { size?: number }) {
  const { imageUrl, name, email } = useProfileStore();
  const [broken, setBroken] = useState(false);
  const initial = (name || email || "?").trim().charAt(0).toUpperCase();
  return imageUrl && !broken
    ? <img className="dn-av" src={imageUrl} alt="" style={{ width: size, height: size }} onError={() => setBroken(true)} />
    : <span className="dn-av is-init" style={{ width: size, height: size, fontSize: size * 0.48 }}>{initial}</span>;
}

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
              <Avatar />
              <button type="button" className="dn-row" title={n.on ? screens[n.on - 1]?.caption : undefined} onClick={() => onSeek(n.on ?? 0, n.t)}>
                <span className="dn-t">{where(n)}</span>
                <span className="dn-body">{n.body}</span>
              </button>
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
          {fixed.length ? <span className="dn-fixed">{fixed.length} fixed earlier</span> : null}
        </div>
      ) : null}
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
  // Above the pin (below it near the top edge), centred on it but kept inside the picture.
  const below = pin.y < 0.42;
  const style = {
    "--px": `${pin.x * 100}%`,
    ...(below ? { top: `calc(${pin.y * 100}% + 16px)` } : { bottom: `calc(${(1 - pin.y) * 100}% + 16px)` }),
  } as unknown as React.CSSProperties;
  return (
    <div className="dn-draft" style={style} onClick={(e) => e.stopPropagation()}>
      <form className="dn-draft__box" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Avatar size={22} />
        <div className="dn-draft__main">
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
        </div>
      </form>
    </div>
  );
}
