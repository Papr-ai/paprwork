import { mkdtempSync, readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/gateway/services/syncV3/MetadataRegistryClient.js", () => ({
  fetchSubAgentsIndexFromCloudDirect: vi.fn(),
}));

import { fetchSubAgentsIndexFromCloudDirect } from "../src/gateway/services/syncV3/MetadataRegistryClient.js";
import { hydrateSubAgentsRegistryForCloudRun } from "../src/gateway/services/cloudAgentGateway/hydrateSubAgentsRegistryForCloudRun.js";

describe("hydrateSubAgentsRegistryForCloudRun", () => {
  let paprHome = "";

  afterEach(() => {
    vi.mocked(fetchSubAgentsIndexFromCloudDirect).mockReset();
  });

  it("merges Mongo custom profiles over stale git clone", async () => {
    paprHome = mkdtempSync(join(tmpdir(), "papr-hydrate-"));
    mkdirSync(join(paprHome, "data"), { recursive: true });
    writeFileSync(
      join(paprHome, "data", "subagents.json"),
      JSON.stringify(
        [
          {
            id: "agent-stale",
            name: "Stale Name",
            description: "old",
            systemPrompt: "old prompt",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            runCount: 0,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    vi.mocked(fetchSubAgentsIndexFromCloudDirect).mockResolvedValue([
      {
        id: "agent-stale",
        name: "Fresh Name",
        description: "new",
        systemPrompt: "new prompt",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-05T00:00:00.000Z",
      },
    ]);

    const result = await hydrateSubAgentsRegistryForCloudRun({
      paprHome,
      paprApiKey: "sk-test",
    });

    expect(result).toEqual({ hydrated: 1, source: "mongo" });
    const saved = JSON.parse(
      readFileSync(join(paprHome, "data", "subagents.json"), "utf8"),
    ) as Array<{ name: string; systemPrompt: string }>;
    expect(saved[0]?.name).toBe("Fresh Name");
    expect(saved[0]?.systemPrompt).toBe("new prompt");
  });

  it("skips when Mongo has no registry yet", async () => {
    paprHome = mkdtempSync(join(tmpdir(), "papr-hydrate-skip-"));
    vi.mocked(fetchSubAgentsIndexFromCloudDirect).mockResolvedValue(null);

    const result = await hydrateSubAgentsRegistryForCloudRun({
      paprHome,
      paprApiKey: "sk-test",
    });

    expect(result).toEqual({ hydrated: 0, source: "skipped" });
  });
});
