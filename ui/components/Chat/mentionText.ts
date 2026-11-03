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

export function filterTeammates(team: Teammate[], q: string): Teammate[] {
  const s = q.toLowerCase();
  return team.filter((m) => !s || m.displayName.toLowerCase().split(/\s+/).some((w) => w.startsWith(s)) || m.email.toLowerCase().startsWith(s)).slice(0, 6);
}
