import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appIdsFromSyncRelativePaths,
  rebuildPublishedArtifactsForApp,
} from "../src/gateway/services/cloudSync/rebuildPublishedArtifacts.js";

describe("rebuildPublishedArtifacts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("extracts app ids from sync paths", () => {
    expect(
      appIdsFromSyncRelativePaths([
        "apps/abc-123",
        "Jobs/job-1",
        "apps/def-456/nested",
      ]),
    ).toEqual(["abc-123", "def-456"]);
  });

  it("writes backend/bundle.json hashes matching handler source", async () => {
    const paprDir = await fs.mkdtemp(path.join(os.tmpdir(), "papr-rebuild-"));
    tempDirs.push(paprDir);
    const appId = "test-app";
    const backendDir = path.join(paprDir, "apps", appId, "backend");
    await fs.mkdir(backendDir, { recursive: true });
    await fs.writeFile(
      path.join(backendDir, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          actions: {
            ping: {
              handler: "ping.py",
              runtime: "python",
              keys: [],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(backendDir, "ping.py"), 'print("ok")\n', "utf8");
    await fs.writeFile(
      path.join(backendDir, "bundle.json"),
      JSON.stringify({ version: 1, builtAt: "old", actions: {} }, null, 2),
      "utf8",
    );

    await rebuildPublishedArtifactsForApp(paprDir, appId);

    const bundle = JSON.parse(
      await fs.readFile(path.join(backendDir, "bundle.json"), "utf8"),
    ) as { actions: Record<string, { sha256: string }> };
    const handler = await fs.readFile(path.join(backendDir, "ping.py"), "utf8");
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(handler, "utf8").digest("hex");
    expect(bundle.actions.ping.sha256).toBe(expected);
  });
});
