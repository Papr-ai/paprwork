/**
 * Write with AI (v9): draft a proposal title + summary from the copy's edits.
 *
 * Desktop only — the server still receives the same title + description the
 * Propose sheet always sent. The diff is compact on purpose: per file, only
 * the changed middle (common prefix/suffix trimmed), capped in size, which is
 * plenty for a cheap model to say what changed in plain words.
 */

export interface DraftFileChange {
  path: string;
  before: string | undefined;
  after: string | undefined;
}

const PER_FILE_CHARS = 2_500;
const TOTAL_CHARS = 14_000;

/** The changed middle of a file, as -/+ lines (no diff lib needed). */
export function compactFileDiff(change: DraftFileChange): string {
  const { path, before, after } = change;
  if (before === undefined) return `New file ${path}\n${clip(prefixLines(after ?? "", "+"))}`;
  if (after === undefined) return `Removed file ${path}`;
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA + 1).map((l) => `- ${l}`);
  const added = b.slice(start, endB + 1).map((l) => `+ ${l}`);
  return `Edited ${path} (line ${start + 1})\n${clip([...removed, ...added].join("\n"))}`;
}

function prefixLines(text: string, mark: string): string {
  return text
    .split("\n")
    .map((l) => `${mark} ${l}`)
    .join("\n");
}

function clip(text: string, max = PER_FILE_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text;
}

export function buildDraftPrompt(appTitle: string, changes: DraftFileChange[]): string {
  let body = "";
  for (const c of changes) {
    const part = `${compactFileDiff(c)}\n\n`;
    if (body.length + part.length > TOTAL_CHARS) {
      body += `…and ${changes.length - changes.indexOf(c)} more file(s).\n`;
      break;
    }
    body += part;
  }
  return `App: ${appTitle}\nChanged files: ${changes.length}\n\n${body}`;
}

export const DRAFT_SYSTEM_PROMPT =
  "You write change proposals for a small app, for the app's owner to review. " +
  "Read the edits and reply with exactly two parts:\n" +
  "TITLE: a short title (max 60 chars, sentence case, no trailing period)\n" +
  "SUMMARY: 1-3 plain sentences saying what changed for someone using the app, and why if it is obvious. " +
  "No file names unless they help, no code, no markdown, no bullet points.";

export function parseDraft(text: string): { title: string; description: string } | null {
  const title = /TITLE:\s*(.+)/i.exec(text)?.[1]?.trim();
  const summary = /SUMMARY:\s*([\s\S]+)/i.exec(text)?.[1]?.trim();
  if (!title || !summary) return null;
  return { title: title.replace(/[.\s]+$/, "").slice(0, 80), description: summary.slice(0, 1_000) };
}
