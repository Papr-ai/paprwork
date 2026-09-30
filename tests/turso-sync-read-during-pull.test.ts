import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Live Turso + Papr Memory experiment (not CI by default).
 * Run: npm run test:turso-read-during-pull
 */
describe("turso sync read during pull (live)", () => {
  it.skipIf(process.env.TURSO_READ_PULL_LIVE !== "1")(
    "runs scripts/test-turso-sync-read-during-pull.mjs",
    async () => {
      const root = path.resolve(__dirname, "..");
      const electron = path.join(root, "node_modules/.bin/electron");
      const script = path.join(root, "scripts/test-turso-sync-read-during-pull.mjs");
      const { stdout, stderr } = await execFileAsync(
        electron,
        [script],
        {
          cwd: root,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      if (stderr.trim()) {
        console.warn(stderr);
      }
      expect(stdout).toContain("SDK: one handle");
      expect(stdout).toContain("pull (long poll)");
    },
    130_000,
  );
});
