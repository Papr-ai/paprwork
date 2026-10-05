import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withCrossProcessFileLock } from "../src/core/utils/crossProcessFileLock.js";

const LOCK_MODULE = path.resolve(__dirname, "../src/core/utils/crossProcessFileLock.ts");

/** Child: N read-modify-write increments of a JSON counter under the lock. */
function childScript(file: string, n: number): string {
  return `
import { promises as fs } from "node:fs";
import { withCrossProcessFileLock } from ${JSON.stringify(LOCK_MODULE)};
for (let i = 0; i < ${n}; i++) {
  await withCrossProcessFileLock(${JSON.stringify(file)}, async () => {
    const c = JSON.parse(await fs.readFile(${JSON.stringify(file)}, "utf8"));
    await new Promise((r) => setTimeout(r, 1));
    c.n += 1;
    await fs.writeFile(${JSON.stringify(file)}, JSON.stringify(c));
  });
}
`;
}

function runChild(script: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

describe("withCrossProcessFileLock", () => {
  it("serializes read-modify-write across separate processes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xlock-"));
    const file = path.join(dir, "counter.json");
    await fs.writeFile(file, JSON.stringify({ n: 0 }));
    const codes = await Promise.all([0, 1, 2].map(() => runChild(childScript(file, 25))));
    expect(codes).toEqual([0, 0, 0]);
    expect(JSON.parse(await fs.readFile(file, "utf8")).n).toBe(75);
    await expect(fs.stat(`${file}.lock`)).rejects.toThrow();
  }, 60_000);

  it("breaks a lock left behind by a dead process", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xlock-"));
    const file = path.join(dir, "state.json");
    // pid 2^22+7 is far above macOS/Linux defaults — never a live process.
    await fs.writeFile(`${file}.lock`, `${4_194_311} ${Date.now()}`);
    const started = Date.now();
    const out = await withCrossProcessFileLock(file, async () => "ran");
    expect(out).toBe("ran");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("releases the lock when the body throws", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xlock-"));
    const file = path.join(dir, "state.json");
    await expect(
      withCrossProcessFileLock(file, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.stat(`${file}.lock`)).rejects.toThrow();
  });
});
