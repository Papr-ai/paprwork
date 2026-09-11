import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import {
  MIN_TOON_ROWS,
  MIN_TOON_SAVING_RATIO,
  asToonOrRows,
  encodeRowsAsToon,
} from "../src/core/utils/toonRows.js";

/** Uniform scalar rows with short values — the shape TOON is built for. */
function uniformRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`,
    status: i % 2 === 0 ? "error" : "warning",
    file: `src/components/widget-${i}.tsx`,
    line: i * 7,
  }));
}

describe("encodeRowsAsToon — the gate", () => {
  it("rejects a row set below the minimum, where the header costs more than it saves", () => {
    expect(encodeRowsAsToon("rows", uniformRows(MIN_TOON_ROWS - 1))).toBeNull();
    expect(encodeRowsAsToon("rows", uniformRows(MIN_TOON_ROWS))).not.toBeNull();
  });

  it("rejects anything that is not an array of plain objects", () => {
    expect(encodeRowsAsToon("rows", "already a string")).toBeNull();
    expect(encodeRowsAsToon("rows", null)).toBeNull();
    expect(encodeRowsAsToon("rows", [])).toBeNull();
    // A list of scalars has no repeated keys to omit — list_job_files is exactly
    // this shape, which is why it is not a TOON candidate.
    expect(encodeRowsAsToon("files", ["a.py", "b.py", "c.py"])).toBeNull();
    expect(encodeRowsAsToon("rows", [{ a: 1 }, "not an object"])).toBeNull();
  });

  it("rejects rows whose bytes are mostly free text, where keys are a rounding error", () => {
    const prose = "x".repeat(4000);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      body: prose,
    }));
    expect(encodeRowsAsToon("rows", rows)).toBeNull();
  });

  /**
   * The load-bearing invariant. Encoding as it was measured on real payloads
   * made `list_jobs` 1.7% and `list_documents` 4.4% *larger* than JSON, so the
   * gate exists to guarantee a switch can never cost more than it saves.
   */
  it("never returns an encoding larger than the JSON it replaces", () => {
    const shapes: unknown[][] = [
      uniformRows(8),
      uniformRows(500),
      Array.from({ length: 30 }, (_, i) => ({
        id: i,
        nested: { deep: { deeper: [1, 2, 3] } },
        text: "some free text ".repeat(20),
      })),
      Array.from({ length: 12 }, (_, i) =>
        i % 3 === 0 ? { a: 1 } : { a: 1, b: 2, c: "three", d: null },
      ),
    ];

    for (const rows of shapes) {
      const encoded = encodeRowsAsToon("rows", rows);
      if (encoded === null) continue;
      const jsonCost = JSON.stringify(rows).length;
      const toonCost = JSON.stringify(encoded.toon).length;
      expect(toonCost).toBeLessThan(jsonCost);
      expect(encoded.savedRatio).toBeGreaterThanOrEqual(MIN_TOON_SAVING_RATIO);
    }
  });

  /**
   * The comparison is made on the embedded size because the result is delivered
   * inside a JSON envelope, where every newline in the TOON string costs two
   * characters. Comparing raw strings would overstate the saving.
   */
  it("measures the embedded cost, not the raw string length", () => {
    const rows = uniformRows(40);
    const encoded = encodeRowsAsToon("rows", rows);
    expect(encoded).not.toBeNull();

    const rawRatio = 1 - encoded!.toon.length / JSON.stringify(rows).length;
    expect(encoded!.savedRatio).toBeLessThan(rawRatio);
  });
});

describe("encodeRowsAsToon — normalization", () => {
  /**
   * Zero of 244 real stored payloads reached tabular form without this, because
   * `JSON.stringify` drops `undefined` fields entirely and TOON needs every row
   * to carry the same keys.
   */
  it("reaches tabular form when optional fields are absent from some rows", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `id-${i}`,
      status: "ok",
      ...(i % 4 === 0 ? { error: "boom" } : {}),
      ...(i % 5 === 0 ? { retries: 2 } : {}),
    }));

    const encoded = encodeRowsAsToon("runs", rows);
    expect(encoded).not.toBeNull();
    expect(encoded!.toon).toMatch(/^runs\[20]\{id,status,error,retries}:/);
  });

  /**
   * Giving such a key a column would have TOON spell out a null per row for
   * something JSON omitted entirely — measured at -31.9% before this, which is
   * how the case was found.
   */
  it("omits a key that is undefined in every row rather than materialising nulls", () => {
    const withUndefined = encodeRowsAsToon(
      "rows",
      Array.from({ length: 10 }, (_, i) => ({ id: i, note: undefined })),
    );
    const withAbsent = encodeRowsAsToon(
      "rows",
      Array.from({ length: 10 }, (_, i) => ({ id: i })),
    );
    expect(withUndefined?.toon).toBe(withAbsent?.toon);
  });

  it("flattens nested values rather than abandoning tabular form", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `id-${i}-with-enough-text-to-clear-the-gate`,
      status: "ok",
      schedule: { on: 1 },
    }));
    const encoded = encodeRowsAsToon("jobs", rows);
    expect(encoded).not.toBeNull();
    expect(encoded!.toon).toMatch(/^jobs\[20]\{id,status,schedule}:/);
  });

  /**
   * Flattening a nested object to JSON and embedding that in a JSON envelope
   * escapes its quotes twice, so it costs slightly *more* than the nested
   * original. Measured at 6.0% on 20 rows carrying a two-field `schedule` —
   * below the gate, and the reason `list_jobs` is not a TOON candidate.
   */
  it("declines when flattened nested content dominates the row", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `id-${i}`,
      status: "ok",
      schedule: { enabled: true, cron: "0 7 * * 1" },
    }));
    expect(encodeRowsAsToon("jobs", rows)).toBeNull();
  });

  it("round-trips scalar values, so the encoding is not lossy or ambiguous", () => {
    const rows = [
      { id: "plain", text: "no commas here", n: 1, flag: true, gone: null },
      {
        id: "comma",
        text: "has, commas, inside",
        n: -2.5,
        flag: false,
        gone: null,
      },
      {
        id: "quote",
        text: 'has "quotes" inside',
        n: 0,
        flag: true,
        gone: null,
      },
      { id: "newline", text: "has\nnewline", n: 99, flag: false, gone: null },
      { id: "colon", text: "key: value", n: 3, flag: true, gone: null },
      { id: "bracket", text: "[1,2]{a}", n: 4, flag: false, gone: null },
      { id: "empty", text: "", n: 5, flag: true, gone: null },
      { id: "unicode", text: "héllo — wörld", n: 6, flag: false, gone: null },
      { id: "numeric-ish", text: "0123", n: 7, flag: true, gone: null },
    ];
    const encoded = encodeRowsAsToon("rows", rows);
    expect(encoded).not.toBeNull();
    expect(decode(encoded!.toon)).toEqual({ rows });
  });
});

describe("asToonOrRows", () => {
  it("returns the rows untouched when the gate declines", () => {
    const rows = uniformRows(3);
    expect(asToonOrRows("rows", rows)).toBe(rows);
  });

  it("returns a self-describing string when the gate accepts", () => {
    const encoded = asToonOrRows("apps", uniformRows(40));
    expect(typeof encoded).toBe("string");
    expect(encoded as string).toMatch(/^apps\[40]\{/);
  });
});
