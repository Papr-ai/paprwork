/**
 * The @ picker: one quiet row of at most 3 name chips above the composer, best match first.
 * More matches show as a count ("+11 · keep typing"): typing narrows, arrows walk them, Tab/Enter picks.
 * Picking inserts "@Full Name". An @ is context for Pen; nobody is told unless the user says yes.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import "./MentionMenu.css";

import { rankTeammates, type Teammate } from "./mentionText";

export type { Teammate };
export { filterTeammates, insertMention, mentionQueryAt, rankTeammates } from "./mentionText";

let cache: Teammate[] | null = null;
let inflight: Promise<Teammate[]> | null = null;

/** Teammates, fetched once per session. Empty if not signed in or offline. */
export function loadTeammates(): Promise<Teammate[]> {
  if (cache) return Promise.resolve(cache);
  inflight ??= gateway.send("collab:members", {})
    .then((r) => (cache = r.success ? ((r.data as { members?: Teammate[] }).members ?? []) : []))
    .catch(() => [])
    .finally(() => { inflight = null; });
  return inflight;
}

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "@";

export function MentionMenu({ query, onSelect, onClose, onVisible }: {
  query: string; onSelect: (m: Teammate) => void; onClose: () => void;
  /** Whether any teammate is listed, so the composer only yields Enter/arrows when there's a pick. */
  onVisible?: (visible: boolean) => void;
}) {
  const [team, setTeam] = useState<Teammate[]>(cache ?? []);
  const [index, setIndex] = useState(0);
  const { shown, more } = rankTeammates(team, query);

  useEffect(() => { void loadTeammates().then(setTeam); }, []);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => { onVisible?.(shown.length > 0); return () => onVisible?.(false); }, [shown.length, onVisible]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!shown.length) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); onSelect(shown[index]); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [shown, index, onSelect, onClose]);

  if (!shown.length) return null;
  return (
    <div className="mention-chips" role="listbox" aria-label="Mention a teammate">
      {shown.map((m, i) => (
        <button key={m.userId} type="button" role="option" aria-selected={i === index} title={m.email}
          className={`mention-chip${i === index ? " is-on" : ""}`}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onSelect(m)} onMouseEnter={() => setIndex(i)}>
          <i aria-hidden="true">{initials(m.displayName)}</i>{m.displayName}
        </button>
      ))}
      {more ? <span className="mention-chips__more">+{more} · keep typing</span> : null}
      <kbd className="mention-chips__key">Tab</kbd>
    </div>
  );
}
