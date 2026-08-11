import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  writeJsonAtomic,
  parseJsonTolerant,
} from "../src/core/utils/atomicJsonWrite.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-index-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("atomic job.json writes (torn-write corruption)", () => {
  test("overwriting a longer file with a shorter one leaves no trailing bytes", async () => {
    const target = path.join(tmpDir, "job.json");

    await writeJsonAtomic(target, { id: "job-1", padding: "x".repeat(5000) });
    await writeJsonAtomic(target, { id: "job-1", appIds: ["__standalone__"] });

    const raw = fs.readFileSync(target, "utf-8");

    // The exact production failure: valid JSON followed by leftover bytes
    // ("...}3784\"\n}") which threw "Unexpected non-whitespace character".
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toEqual({ id: "job-1", appIds: ["__standalone__"] });
    expect(raw).not.toContain("xxxx");
  });

  test("concurrent writers never produce a corrupt file", async () => {
    const target = path.join(tmpDir, "job.json");

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        writeJsonAtomic(target, {
          id: "job-1",
          n: i,
          pad: "y".repeat((i % 5) * 900),
        }),
      ),
    );

    const raw = fs.readFileSync(target, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("no .tmp files are left behind", async () => {
    const target = path.join(tmpDir, "job.json");
    await writeJsonAtomic(target, { ok: true });

    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("parseJsonTolerant (self-heals already-corrupted files)", () => {
  test("recovers the valid prefix of a torn write", () => {
    const corrupt = JSON.stringify({ id: "job-1", name: "Feed" }) + '3784"\n}';

    expect(() => JSON.parse(corrupt)).toThrow();
    expect(parseJsonTolerant(corrupt)).toEqual({ id: "job-1", name: "Feed" });
  });

  test("returns clean JSON unchanged", () => {
    expect(parseJsonTolerant('{"a":1}')).toEqual({ a: 1 });
  });

  test("returns undefined when nothing is recoverable", () => {
    expect(parseJsonTolerant("not json at all")).toBeUndefined();
  });
});
