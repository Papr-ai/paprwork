/** Pure helpers for the @ picker (no React), shared with gateway tests. */
export interface Teammate { userId: string; displayName: string; email: string }

/** "@sha" right before the cursor → "sha". Null when the cursor isn't in an @word. */
export function mentionQueryAt(text: string, cursor: number): string | null {
  const m = text.slice(0, cursor).match(/(?:^|\s)@([\p{L}\p{N}._-]{0,30})$/u);
  return m ? m[1] : null;
}

/** Replace the @query before the cursor with "@Name ". Returns the new text and cursor. */
export function insertMention(text: string, cursor: number, name: string): { text: string; cursor: number } {
  const before = text.slice(0, cursor).replace(/@[\p{L}\p{N}._-]*$/u, `@${name} `);
  return { text: before + text.slice(cursor), cursor: before.length };
}

/** The compact picker: at most `max` chips, best first (first name starts with it, then any name word, then email).
 *  `more` is how many others match, shown as a count so typing narrows instead of scrolling. */
export function rankTeammates(team: Teammate[], q: string, max = 3): { shown: Teammate[]; more: number } {
  const s = q.toLowerCase();
  const score = (m: Teammate) => {
    const words = m.displayName.toLowerCase().split(/\s+/);
    if (!s) return 2;
    if (words[0]?.startsWith(s)) return 0;
    if (words.some((w) => w.startsWith(s))) return 1;
    return m.email.toLowerCase().startsWith(s) ? 2 : -1;
  };
  const hits = team.map((m) => [score(m), m] as const).filter(([sc]) => sc >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].displayName.localeCompare(b[1].displayName)).map(([, m]) => m);
  return { shown: hits.slice(0, max), more: Math.max(0, hits.length - max) };
}

export function filterTeammates(team: Teammate[], q: string): Teammate[] {
  const s = q.toLowerCase();
  return team.filter((m) => !s || m.displayName.toLowerCase().split(/\s+/).some((w) => w.startsWith(s)) || m.email.toLowerCase().startsWith(s)).slice(0, 6);
}
