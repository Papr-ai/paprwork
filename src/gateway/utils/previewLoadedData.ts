/**
 * What data a mini-app loaded during the validate_app preview, and whether any of
 * it reached the screen.
 *
 * Console errors and failed calls miss the worst bug class: the request succeeds,
 * returns rows, and the UI renders nothing useful (grocery-list: rows came back as
 * {"name":"name"} and rendered as blank rows; validate_app passed). Every place a
 * preview can load data records the rows here (/api/db/query, /api/db/batch, backend
 * actions — desktop and cloud), and the preview compares them with the rendered page.
 */

interface LoadedRecord {
  at: number;
  origin: string;
  rows: Array<Record<string, unknown>>;
}

const MAX_RECORDS_PER_APP = 40;
const MAX_ROWS_PER_RECORD = 100;
const records = new Map<string, LoadedRecord[]>();

const isPlainRow = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Row arrays inside a JSON value (top level, or one/two levels down: {items:[…]}, {data:{rows:[…]}}). */
export function findRowArrays(value: unknown, depth = 0): Array<Array<Record<string, unknown>>> {
  if (Array.isArray(value)) {
    const rows = value.filter(isPlainRow);
    return rows.length > 0 && rows.length === value.length ? [rows] : [];
  }
  if (!isPlainRow(value) || depth >= 2) return [];
  return Object.values(value).flatMap((v) => findRowArrays(v, depth + 1));
}

export function recordPreviewLoadedRows(appId: string, origin: string, rows: unknown): void {
  if (!appId) return;
  for (const found of findRowArrays(rows)) {
    const list = records.get(appId) ?? [];
    list.push({ at: Date.now(), origin, rows: found.slice(0, MAX_ROWS_PER_RECORD) });
    if (list.length > MAX_RECORDS_PER_APP) list.splice(0, list.length - MAX_RECORDS_PER_APP);
    records.set(appId, list);
  }
}

/** Backend handlers print JSON on stdout; take the last JSON document they printed. */
export function recordPreviewBackendStdout(appId: string, action: string, stdout: string): void {
  const text = stdout.trim();
  if (!text) return;
  const candidates = [text, text.split("\n").filter(Boolean).pop() ?? ""];
  for (const c of candidates) {
    try {
      recordPreviewLoadedRows(appId, `backend/${action}`, JSON.parse(c));
      return;
    } catch {
      // not JSON — try the next candidate
    }
  }
}

const LOOKS_LIKE_ID = /^(?:[0-9a-f]{8,}|[0-9a-f-]{20,}|\d+(?:\.\d+)?)$/i;
const LOOKS_LIKE_DATE = /^\d{4}-\d{2}-\d{2}/;
const LOOKS_LIKE_URL = /^(?:https?:|data:|\/)/i;

/** Values a user would see on screen: human text, not ids, dates, URLs or flags. */
function displayValues(row: Record<string, unknown>): string[] {
  return Object.values(row)
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(
      (v) =>
        v.length >= 2 &&
        v.length <= 80 &&
        /[a-z]/i.test(v) &&
        !LOOKS_LIKE_ID.test(v) &&
        !LOOKS_LIKE_DATE.test(v) &&
        !LOOKS_LIKE_URL.test(v) &&
        !/^(?:true|false|null|none|undefined)$/i.test(v),
    );
}

const isKeyEcho = (row: Record<string, unknown>): boolean => {
  const entries = Object.entries(row);
  return entries.length >= 2 && entries.every(([k, v]) => v === k);
};

const normalize = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();

/**
 * Errors for data loaded in [sinceMs, untilMs] that did not reach the page:
 *  - rows whose values are their own column names (handler built rows wrong)
 *  - rows with display text, none of which appears in the rendered page
 */
export function checkPreviewDataRendered(
  appId: string,
  sinceMs: number,
  untilMs: number,
  renderedPage: string,
): string[] {
  const loaded = (records.get(appId) ?? []).filter((r) => r.at >= sinceMs && r.at <= untilMs);
  if (loaded.length === 0) return [];
  const errors: string[] = [];

  for (const r of loaded) {
    const echo = r.rows.find(isKeyEcho);
    if (echo) {
      errors.push(
        `[data] ${r.origin} returned rows whose values are their column names, e.g. ${JSON.stringify(echo).slice(0, 160)}. ` +
          "The handler builds rows wrong (e.g. dict(zip(cols, row)) over dict rows) — return the row values.",
      );
    }
  }
  if (errors.length > 0 || !renderedPage.trim()) return errors;
  // Charts draw data on a canvas; their values never reach the DOM.
  if (/<canvas[\s>]/i.test(renderedPage)) return errors;

  const shown = normalize(renderedPage);
  const loadedValues = [...new Set(loaded.flatMap((r) => r.rows.flatMap(displayValues)))];
  if (loadedValues.length < 2) return errors;
  const visible = loadedValues.filter((v) => shown.includes(normalize(v)));
  if (visible.length === 0) {
    const rowCount = loaded.reduce((n, r) => n + r.rows.length, 0);
    const origins = [...new Set(loaded.map((r) => r.origin))].join(", ");
    errors.push(
      `[data] The app loaded ${rowCount} row(s) from ${origins} on first load, but none of their values ` +
        `appear on screen (looked for: ${loadedValues.slice(0, 5).map((v) => JSON.stringify(v)).join(", ")}). ` +
        "Check the field names the UI reads against what the query/action returns.",
    );
  }
  return errors;
}

export function clearPreviewLoadedData(appId?: string): void {
  if (appId) records.delete(appId);
  else records.clear();
}
