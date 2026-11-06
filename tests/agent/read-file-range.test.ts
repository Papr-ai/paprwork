import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { readFileTool } from "../../src/core/tools/filesystem.js";

type Out = { success: boolean; error?: string; data?: { content: string; truncated?: boolean } };
const read = (input: Record<string, unknown>) =>
  (readFileTool as unknown as { execute: (i: unknown) => Promise<Out> }).execute({
    encoding: "utf8",
    maxSize: 50000,
    ...input,
  });

let dir: string;
let big: string;
let small: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "readfile-range-"));
  big = path.join(dir, "big.txt");
  // 20,000 lines x ~60 bytes = ~1.2MB, well over maxSize.
  const lines = Array.from({ length: 20000 }, (_, i) => `line ${i + 1} ${"x".repeat(50)}`);
  fs.writeFileSync(big, lines.join("\n") + "\n");
  small = path.join(dir, "small.txt");
  fs.writeFileSync(small, "a\nb\nc\nd\n");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("read_file on files larger than maxSize", () => {
  it("returns a requested line range instead of a size error", async () => {
    const r = await read({ path: big, offset: 10000, limit: 3 });
    expect(r.success).toBe(true);
    expect(r.data!.content).toContain("line 10000 ");
    expect(r.data!.content).toContain("line 10002 ");
    expect(r.data!.content).not.toContain("line 10003 ");
    expect(r.data!.content).toContain("[Read lines 10000-10002. More lines follow; continue with offset=10003.]");
  });

  it("caps output at maxSize even when limit is huge", async () => {
    const r = await read({ path: big, offset: 1, limit: 100000 });
    expect(r.success).toBe(true);
    expect(Buffer.byteLength(r.data!.content)).toBeLessThan(50000 + 300);
    expect(r.data!.content).toMatch(/Output capped at 49KB; continue with offset=\d+/);
  });

  it("caps output when offset is given with no limit", async () => {
    const r = await read({ path: big, offset: 5 });
    expect(Buffer.byteLength(r.data!.content)).toBeLessThan(50000 + 300);
  });

  it("reports end of file at the tail", async () => {
    const r = await read({ path: big, offset: 19999, limit: 50 });
    expect(r.data!.content).toContain("line 20000 ");
    expect(r.data!.content).toContain("End of file.");
  });

  it("still returns only the first maxSize bytes with no range", async () => {
    const r = await read({ path: big });
    expect(r.data!.truncated).toBe(true);
    expect(r.data!.content).toContain("line 1 ");
    expect(r.data!.content).toContain("[Partial read:");
  });

  it("keeps the old behavior for small files", async () => {
    const r = await read({ path: small, offset: 2, limit: 2 });
    expect(r.data!.content).toBe("b\nc\n\n[Read lines 2-3 of 5 total lines]");
  });

  it("still refuses a range on an oversized non-utf8 read", async () => {
    const r = await read({ path: big, encoding: "base64", offset: 1, limit: 2 });
    expect(r.success).toBe(false);
  });
});
