/**
 * The @ picker: typing "@" in the composer lists teammates (you excluded). Picking one inserts
 * "@Full Name"; Pen tags that person (quietly) and notifies them only when asked (People section of its prompt).
 * Same keyboard and look as the slash menu.
 */
import { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import "./SlashCommandMenu.css";

import { filterTeammates, type Teammate } from "./mentionText";

export type { Teammate };
export { filterTeammates, insertMention, mentionQueryAt } from "./mentionText";

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

export function MentionMenu({ query, onSelect, onClose, onVisible }: {
  query: string; onSelect: (m: Teammate) => void; onClose: () => void;
  /** Whether any teammate is listed, so the composer only yields Enter/arrows when there's a pick. */
  onVisible?: (visible: boolean) => void;
}) {
  const [team, setTeam] = useState<Teammate[]>(cache ?? []);
  const [index, setIndex] = useState(0);
  const shown = filterTeammates(team, query);

  useEffect(() => { void loadTeammates().then(setTeam); }, []);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => { onVisible?.(shown.length > 0); return () => onVisible?.(false); }, [shown.length, onVisible]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!shown.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); onSelect(shown[index]); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [shown, index, onSelect, onClose]);

  if (!shown.length) return null;
  return (
    <div className="slash-command-menu" role="listbox" aria-label="Mention a teammate">
      {shown.map((m, i) => (
        <button key={m.userId} type="button" role="option" aria-selected={i === index}
          className={`slash-command-item${i === index ? " slash-command-item--active" : ""}`}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onSelect(m)} onMouseEnter={() => setIndex(i)}>
          <span className="slash-command-icon">{(m.displayName[0] ?? "@").toUpperCase()}</span>
          <div className="slash-command-content">
            <span className="slash-command-label">{m.displayName}</span>
            <span className="slash-command-desc">{m.email}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
