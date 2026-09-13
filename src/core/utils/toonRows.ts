import { encode } from "@toon-format/toon";

/**
 * TOON encoding for row-shaped tool results.
 *
 * Measured on 244 real stored payloads before writing this: calling `encode()`
 * on results as they are built made three of seven list tools *larger* than
 * JSON (`list_jobs` -1.7%, `list_documents` -4.4%, `validate_app` -3.1%).
 * The cause is that TOON only reaches its tabular form — the one that declares
 * keys once — when every row carries the same keys in the same order with
 * scalar values, and our rows do not: optional fields are dropped entirely by
 * `JSON.stringify`, and several carry nested objects. Normalising into a true
 * table first reaches tabular form on 100% of those payloads, but the saving
 * still ranges 6.9%-37% rather than the 58.8% headline, because much of each
 * row is free text (commands, paths, descriptions) that no encoding compresses.
 *
 * So the saving is a property of the individual payload, not of the tool, and
 * this module measures it per call instead of assuming it.
 */

/**
 * Below this, the `[N]{k1,k2}:` header costs more than the repeated keys it
 * removes.
 */
export const MIN_TOON_ROWS = 8;

/**
 * Minimum measured saving before switching a payload's format. TOON's own
 * agentic-tool-calling benchmark reports 2-18% savings *with* cascading parse
 * failures in multi-turn loops, so a saving inside that band does not pay for
 * the risk of handing the model a format it may misread.
 */
export const MIN_TOON_SAVING_RATIO = 0.15;

type Row = Record<string, unknown>;

function isPlainRow(value: unknown): value is Row {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Union of keys in first-seen order, every row given every key, non-scalars
 * flattened to compact JSON. Absent and `undefined` both become null: a row
 * missing a key is what breaks tabular form, and null is how TOON spells
 * "no value" in a column that exists.
 */
function toScalarTable(rows: readonly Row[]): Row[] {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }

  // A key that is absent or `undefined` in every row carries nothing:
  // `JSON.stringify` omits it, so giving it a column would have TOON spell out
  // a null per row for information JSON never sent. Measured at -31.9% on a
  // ten-row set with a single such key, which is how it was found.
  const informative = keys.filter((key) =>
    rows.some((row) => row[key] !== undefined),
  );

  return rows.map((row) => {
    const out: Row = {};
    for (const key of informative) {
      const value = row[key];
      if (value === undefined) {
        out[key] = null;
      } else if (value === null || typeof value !== "object") {
        out[key] = value;
      } else if (value instanceof Date) {
        out[key] = value.toISOString();
      } else {
        out[key] = JSON.stringify(value);
      }
    }
    return out;
  });
}

export interface ToonEncodeResult {
  /** Self-describing TOON, e.g. `apps[10]{id,title}:` followed by rows. */
  toon: string;
  /** Fraction of embedded characters removed, 0-1. */
  savedRatio: number;
  rowCount: number;
}

/**
 * Encode `rows` as TOON, or return null when it would not measurably help.
 *
 * The comparison is made on the *embedded* size — `JSON.stringify` of each
 * candidate — because the result is delivered to the model inside a JSON
 * envelope, where a TOON string pays two characters for every newline it
 * contains. Comparing the raw strings would overstate the saving on exactly
 * the row-heavy payloads this exists for.
 */
export function encodeRowsAsToon(
  key: string,
  rows: unknown,
): ToonEncodeResult | null {
  if (!Array.isArray(rows) || rows.length < MIN_TOON_ROWS) return null;
  if (!rows.every(isPlainRow)) return null;

  let toon: string;
  try {
    toon = encode({ [key]: toScalarTable(rows) });
  } catch {
    // An un-encodable value (circular, BigInt) must not cost the caller its
    // result — fall back to leaving the payload as it was.
    return null;
  }

  const jsonCost = JSON.stringify(rows).length;
  const toonCost = JSON.stringify(toon).length;
  if (jsonCost <= 0) return null;

  const savedRatio = 1 - toonCost / jsonCost;
  if (savedRatio < MIN_TOON_SAVING_RATIO) return null;

  return { toon, savedRatio, rowCount: rows.length };
}

/**
 * `rows` as TOON when that measurably shrinks the delivered payload, else the
 * rows unchanged. A call site opts in with one wrapper and the accept/reject
 * decision stays with the measurement — which matters because it varies per
 * call, not per tool: across 34 sampled `list_schemas` results the gate
 * accepted 33 and rejected the one whose rows were mostly free text.
 */
export function asToonOrRows<T>(
  key: string,
  rows: readonly T[],
): string | readonly T[] {
  return encodeRowsAsToon(key, rows)?.toon ?? rows;
}
