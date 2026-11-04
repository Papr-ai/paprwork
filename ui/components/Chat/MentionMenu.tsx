/**
 * The @ picker: one compact dropdown above the composer, the same every time (no style switching).
 * Up to 6 rows: Recent first, then everyone else; initials, name, email in grey. More matches show as
 * "N more · keep typing". Arrows or Tab move, Enter picks, Esc closes. Picking inserts "@Full Name",
 * which renders as a name chip in the sent message. An @ is context for Pen; nobody is told unless the user says yes.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import "./MentionMenu.css";

import { UserAvatar } from "../common/UserAvatar";
import { rankTeammates, recentMentions, rememberMention, type Teammate } from "./mentionText";

export type { Teammate };
export { filterTeammates, insertMention, mentionQueryAt, rankTeammates } from "./mentionText";

let cache: Teammate[] | null = null;
let inflight: Promise<Teammate[]> | null = null;

/** Teammates already loaded this session (for pills); [] before the first @. */
export const cachedTeammates = (): Teammate[] => cache ?? [];

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
  const [recent] = useState(recentMentions);
  const { shown, more, recentCount } = rankTeammates(team, query, 6, recent);
  const pick = (m: Teammate) => { rememberMention(m.userId); onSelect(m); };

  useEffect(() => { void loadTeammates().then(setTeam); }, []);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => { onVisible?.(shown.length > 0); return () => onVisible?.(false); }, [shown.length, onVisible]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!shown.length) return;
      const step = (d: number) => { e.preventDefault(); setIndex((i) => (i + d + shown.length) % shown.length); };
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) step(1);
      else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) step(-1);
      else if (e.key === "Enter") { e.preventDefault(); pick(shown[index]); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  if (!shown.length) return null;
  const row = (m: Teammate, i: number) => (
    <button key={m.userId} type="button" role="option" aria-selected={i === index} id={`mention-opt-${i}`}
      className={`mention-dd__row${i === index ? " is-on" : ""}`}
      onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)} onMouseEnter={() => setIndex(i)}>
      {m.imageUrl
        ? <UserAvatar imageUrl={m.imageUrl} displayName={m.displayName} email={m.email} size={24} className="mention-dd__av" />
        : <i aria-hidden="true">{initials(m.displayName)}</i>}<b>{m.displayName}</b><span>{m.email}</span>
    </button>
  );
  const split = recentCount > 0 && recentCount < shown.length;
  return (
    <div className="mention-dd" role="listbox" aria-label="Mention a teammate" aria-activedescendant={`mention-opt-${index}`}>
      {split ? <div className="mention-dd__h">Recent</div> : null}
      {shown.slice(0, split ? recentCount : shown.length).map((m, i) => row(m, i))}
      {split ? <div className="mention-dd__h">In your org</div> : null}
      {split ? shown.slice(recentCount).map((m, i) => row(m, i + recentCount)) : null}
      <div className="mention-dd__foot">
        <span>{more ? `${more} more · keep typing` : ""}</span>
        <span aria-hidden="true"><kbd>↑↓</kbd><kbd>↵</kbd><kbd>esc</kbd></span>
      </div>
    </div>
  );
}
