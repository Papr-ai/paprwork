import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  initializeCodeIndexIoPool,
  readCodeFileForIndex,
  terminateCodeIndexIoPool,
} from "../src/gateway/services/CodeIndexIoPool.js";

describe("CodeIndexIoPool", () => {
  let tmpDir = "";

  afterEach(() => {
    terminateCodeIndexIoPool();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  test("readUtf8WithHash off main thread", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-code-io-"));
    const filePath = path.join(tmpDir, "sample.ts");
    fs.writeFileSync(filePath, "export const x = 1;\n", "utf-8");

    initializeCodeIndexIoPool(
      new URL("../src/gateway/workers/code-index-io-worker.ts", import.meta.url),
    );

    const result = await readCodeFileForIndex(filePath);
    expect(result.content).toContain("export const x");
    expect(result.lineCount).toBe(2);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
