/** The … on each Needs you item: change it from the thing that bugged you. Urgent stays on until it's fixed. */
import { useEffect, useRef, useState } from "react";

interface Props {
  urgent: boolean; source: string; type: string; laterWhen: string;
  onLater: () => void; onMute: () => void; onTurnOff: () => void; onSettings: () => void;
  /** Only for items that live on a chat or app: change whether that source comes into Focus. */
  focus?: { always: () => void; never: () => void };
}

export function NeedsYouMenu({ urgent, source, type, laterWhen, onLater, onMute, onTurnOff, onSettings, focus }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <div className="needs-you__menu" ref={ref}>
      <button type="button" className="needs-you__dots" aria-label="Options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>&hellip;</button>
      {open ? (
        <div className="needs-you__pop" role="menu">
          {urgent ? <p>Always on: this reaches you until it&apos;s fixed.</p> : (
            <>
              <button type="button" role="menuitem" onClick={pick(onLater)}>Later<em>Back {laterWhen}</em></button>
              <button type="button" role="menuitem" onClick={pick(onMute)}>Mute {source} for 1 hour<em>No desktop notifications, out of this list</em></button>
              {focus ? (
                <>
                  <button type="button" role="menuitem" onClick={pick(focus.always)}>Always show {source} in Focus<em>Right away, without waiting for Pen</em></button>
                  <button type="button" role="menuitem" onClick={pick(focus.never)}>Keep {source} off Focus<em>Stays as a dot on {source}</em></button>
                </>
              ) : null}
              <button type="button" role="menuitem" onClick={pick(onTurnOff)}>Turn off {type}</button>
            </>
          )}
          <button type="button" role="menuitem" className="is-link" onClick={pick(onSettings)}>{source} notification settings</button>
        </div>
      ) : null}
    </div>
  );
}
