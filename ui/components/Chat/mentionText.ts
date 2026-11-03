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

/** The @ dropdown: up to `max` rows, the same every time. People you picked recently come first
 *  (in the order you last used them), then the best matches (first name starts with it, then any
 *  name word, then email). `more` = other matches past the list, shown as "keep typing". */
export function rankTeammates(team: Teammate[], q: string, max = 6, recent: string[] = []): { shown: Teammate[]; more: number; recentCount: number } {
  const s = q.toLowerCase();
  const score = (m: Teammate) => {
    const words = m.displayName.toLowerCase().split(/\s+/);
    if (!s) return 2;
    if (words[0]?.startsWith(s)) return 0;
    if (words.some((w) => w.startsWith(s))) return 1;
    return m.email.toLowerCase().startsWith(s) ? 2 : -1;
  };
  const rank = new Map(recent.map((id, i) => [id, i]));
  const hits = team.map((m) => [score(m), m] as const).filter(([sc]) => sc >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].displayName.localeCompare(b[1].displayName)).map(([, m]) => m);
  const rec = hits.filter((m) => rank.has(m.userId)).sort((a, b) => rank.get(a.userId)! - rank.get(b.userId)!);
  const rest = hits.filter((m) => !rank.has(m.userId));
  const shown = [...rec, ...rest].slice(0, max);
  return { shown, more: Math.max(0, hits.length - max), recentCount: Math.min(rec.length, max) };
}

const RECENT_KEY = "papr.mention.recent";
/** Last people you picked, most recent first (this device). */
export function recentMentions(): string[] {
  try { return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]).slice(0, 8); } catch { return []; }
}
export function rememberMention(userId: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([userId, ...recentMentions().filter((x) => x !== userId)].slice(0, 8))); } catch { /* private mode */ }
}

export function filterTeammates(team: Teammate[], q: string): Teammate[] {
  const s = q.toLowerCase();
  return team.filter((m) => !s || m.displayName.toLowerCase().split(/\s+/).some((w) => w.startsWith(s)) || m.email.toLowerCase().startsWith(s)).slice(0, 6);
}
