import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { describe, expect, test } from "vitest";
import { detectGrep, loadNpyF16, readCorpusFilter } from "../../scripts/curation-bench/lib.mts";
import { gate } from "../../scripts/curation-bench/gate.mts";
import { chunkFile } from "../../src/core/tools/codeEmbed/chunker.js";

// Unit tests for the Curation Bench harness itself (the bench runs on a GPU; these run in CI on every PR).
describe("curation bench helpers", () => {
  test("detectGrep matches bash.ts detectPaprGrepCommand", () => {
    expect(detectGrep(`cd x; grep -rn "incomplete input" src`)).toBe("incomplete input");
    expect(detectGrep(`grep -rln 'code_indexer\\|codeIndex' --include="*.ts" src`)).toBe("code_indexer\\|codeIndex");
    expect(detectGrep(`ls -la`)).toBeNull();
  });

  test("readCorpusFilter mirrors codeSearchV2.readCorpus", () => {
    expect(readCorpusFilter("src/a.ts", "x")).toBe(true);
    expect(readCorpusFilter("node_modules/x/a.ts", "x")).toBe(false);
    expect(readCorpusFilter(".github/workflows/a.yml", "x")).toBe(false);
    expect(readCorpusFilter("package-lock.json", "x")).toBe(false);
    expect(readCorpusFilter("src/a.ts", "x".repeat(400_001))).toBe(false);
    expect(readCorpusFilter("img/logo.png", "x")).toBe(false);
  });

  test("loadNpyF16 reads numpy float16 C-order", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cb-npy-"));
    const header = "{'descr': '<f2', 'fortran_order': False, 'shape': (2, 3), }";
    const pad = 64 - ((10 + header.length + 1) % 64);
    const h = Buffer.from(header + " ".repeat(pad) + "\n", "latin1");
    const pre = Buffer.alloc(10);
    Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]).copy(pre);
    pre.writeUInt16LE(h.length, 8);
    // 1.0, -2.0, 0.5, 0, 65504, 2^-14
    const vals = Buffer.alloc(12);
    [0x3c00, 0xc000, 0x3800, 0x0000, 0x7bff, 0x0400].forEach((v, i) => vals.writeUInt16LE(v, i * 2));
    const p = path.join(dir, "a.npy");
    writeFileSync(p, Buffer.concat([pre, h, vals]));
    const r = loadNpyF16(p);
    expect([r.rows, r.dim]).toEqual([2, 3]);
    expect(Array.from(r.data)).toEqual([1, -2, 0.5, 0, 65504, 2 ** -14]);
  });

  test("bench chunks are the desktop chunks", () => {
    // export-chunks.mts calls chunkFile with the real tokenizer; a long file must split with File: headers.
    const text = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i}; // line ${i}`).join("\n");
    const cs = chunkFile("src/big.ts", text);
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.every((c) => c.text.startsWith("File: src/big.ts\n"))).toBe(true);
    expect(cs[0]!.lineStart).toBe(1);
    expect(cs.at(-1)!.lineEnd).toBe(400);
  });
});

describe("curation bench gate", () => {
  test("an empty index cannot pass: no semantic hits means no pointers (as codePointerBlock)", async () => {
    const { codePointerBlock } = await import("../../src/core/tools/codeSearchV2.js");
    expect(await codePointerBlock({ projectRoot: "/nonexistent", memoryHits: [], query: "x", command: "grep x .", pattern: "x" })).toBe("");
  });
  const res = (miss: number, ctrl: number) => ({ summary: { miss: { n: 50, top10: 0, harness: miss, shown: miss }, ctrl: { n: 25, top10: 0, harness: ctrl, shown: ctrl } } });
  const base = { miss: { harness: 42 }, ctrl: { harness: 15 } };
  test("passes at or above the floor and baseline", () => {
    expect(gate(res(42, 15), { minMiss: 41, baseline: base, tolerance: 1 }).ok).toBe(true);
    expect(gate(res(41, 14), { minMiss: 41, baseline: base, tolerance: 1 }).ok).toBe(true);
  });
  test("fails under the floor", () => {
    const g = gate(res(40, 15), { minMiss: 41, baseline: base, tolerance: 1 });
    expect(g.ok).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/40 of 50 misses < 41/);
  });
  test("fails on a regression against the baseline beyond tolerance", () => {
    const g = gate(res(43, 13), { minMiss: 41, baseline: base, tolerance: 1 });
    expect(g.ok).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/controls 13 < baseline 15 - 1/);
  });
});

