import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  buildRecoveryProfileFromSidecar,
  collectSubAgentReferences,
  findOrphanedSubAgentReferences,
  mergeSubAgentProfileLists,
  readSubAgentProfilesSync,
  reconcileSubAgentProfilesOnDisk,
  recoverProfilesFromAppAgentSidecars,
} from "../src/gateway/services/subagents/subAgentIntegrity.js";
import type { SubAgentProfile } from "../src/core/types/subagents.js";

const APP_ID = "9e70c06b-ac30-4c95-bfe2-adc1daecbeb0";
const SUB_AGENT_ID = "agent-f1e31d27-eef4-4222-8769-c9c858feb9cc";

function setupPaprDir(): string {
  const paprDir = mkdtempSync(path.join(tmpdir(), "papr-subagent-integrity-"));
  mkdirSync(path.join(paprDir, "data"), { recursive: true });
  mkdirSync(path.join(paprDir, "apps", APP_ID), { recursive: true });
  return paprDir;
}

function writeAppsJson(paprDir: string, entry: Record<string, unknown>): void {
  writeFileSync(
    path.join(paprDir, "data", "apps.json"),
    JSON.stringify([entry]),
    "utf8",
  );
}

function writeJobsJson(paprDir: string, jobs: Record<string, unknown>[]): void {
  writeFileSync(
    path.join(paprDir, "data", "jobs.json"),
    JSON.stringify(jobs),
    "utf8",
  );
}

function writeSubagents(paprDir: string, profiles: SubAgentProfile[]): void {
  writeFileSync(
    path.join(paprDir, "data", "subagents.json"),
    JSON.stringify(profiles, null, 2),
    "utf8",
  );
}

describe("subAgentIntegrity", () => {
  it("detects orphaned app agent chat references", () => {
    const paprDir = setupPaprDir();
    writeAppsJson(paprDir, {
      id: APP_ID,
      title: "Deck Studio",
      agentChat: { enabled: true, subAgentId: SUB_AGENT_ID },
    });
    writeSubagents(paprDir, [
      {
        id: "product-architect",
        name: "Product Architect",
        description: "x",
        systemPrompt: "x",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        runCount: 0,
      },
    ]);

    const orphans = findOrphanedSubAgentReferences(paprDir, readSubAgentProfilesSync(paprDir));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.subAgentId).toBe(SUB_AGENT_ID);
    expect(orphans[0]?.references[0]?.kind).toBe("app");
  });

  it("recovers missing profile from agent-chat sidecar", async () => {
    const paprDir = setupPaprDir();
    writeAppsJson(paprDir, {
      id: APP_ID,
      title: "Deck Studio",
      agentChat: { enabled: true, subAgentId: SUB_AGENT_ID },
    });
    writeSubagents(paprDir, []);
    writeFileSync(
      path.join(paprDir, "apps", APP_ID, "agent-chat.json"),
      JSON.stringify({
        enabled: true,
        subAgentId: SUB_AGENT_ID,
        bubbleLabel: "Build my deck",
        systemContext: "Embedded deck assistant rules",
        allowedToolIds: ["read_app_file", "edit_app_file"],
      }),
      "utf8",
    );

    const result = await reconcileSubAgentProfilesOnDisk(paprDir);
    expect(result.recoveredFromSidecar).toEqual([SUB_AGENT_ID]);
    expect(result.stillOrphaned).toHaveLength(0);

    const profiles = readSubAgentProfilesSync(paprDir);
    expect(profiles.some((p) => p.id === SUB_AGENT_ID)).toBe(true);
    const recovered = profiles.find((p) => p.id === SUB_AGENT_ID);
    expect(recovered?.name).toBe("Build my deck");
    expect(recovered?.systemPrompt).toContain("Embedded deck assistant rules");
  });

  it("merges custom local profiles back after simulated git pull", () => {
    const localCustom: SubAgentProfile = {
      id: SUB_AGENT_ID,
      name: "Deck Assistant",
      description: "Deck helper",
      systemPrompt: "Write decks",
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      runCount: 0,
    };
    const pulled: SubAgentProfile[] = [
      {
        id: "product-architect",
        name: "Product Architect",
        description: "x",
        systemPrompt: "x",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        runCount: 0,
      },
    ];

    const merged = mergeSubAgentProfileLists(pulled, [localCustom]);
    expect(merged.map((p) => p.id).sort()).toEqual(
      ["product-architect", SUB_AGENT_ID].sort(),
    );
  });

  it("collectSubAgentReferences includes app and job", () => {
    const paprDir = setupPaprDir();
    writeAppsJson(paprDir, {
      id: APP_ID,
      title: "Deck Studio",
      agentChat: { enabled: true, subAgentId: SUB_AGENT_ID },
    });
    writeJobsJson(paprDir, [
      {
        id: "job-1",
        name: "App Agent Chat: Deck Studio",
        type: "subagent",
        subAgentId: SUB_AGENT_ID,
      },
    ]);

    const refs = collectSubAgentReferences(paprDir, SUB_AGENT_ID);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.kind).sort()).toEqual(["app", "job"]);
  });

  it("buildRecoveryProfileFromSidecar uses bubble label and system context", () => {
    const profile = buildRecoveryProfileFromSidecar({
      subAgentId: SUB_AGENT_ID,
      appId: APP_ID,
      appTitle: "Deck Studio",
      sidecar: {
        bubbleLabel: "Build my deck",
        systemContext: "Never edit demo deck",
        allowedToolIds: ["read_app_file"],
      },
    });
    expect(profile.id).toBe(SUB_AGENT_ID);
    expect(profile.name).toBe("Build my deck");
    expect(profile.systemPrompt).toContain("Never edit demo deck");
    expect(profile.allowedToolIds).toEqual(["read_app_file"]);
  });

  it("recoverProfilesFromAppAgentSidecars skips apps without matching sidecar", () => {
    const paprDir = setupPaprDir();
    writeAppsJson(paprDir, {
      id: APP_ID,
      title: "Deck Studio",
      agentChat: { enabled: true, subAgentId: SUB_AGENT_ID },
    });
    const recovered = recoverProfilesFromAppAgentSidecars(paprDir, [SUB_AGENT_ID]);
    expect(recovered).toHaveLength(0);
  });
});
