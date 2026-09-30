import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  readAgentChatSidecarSync,
  writeAgentChatSidecar,
} from "../src/gateway/services/appAgentChatSidecar.js";
import { writeCloudAppMetadataFile } from "../src/gateway/services/cloudAppMetadataFile.js";
import {
  agentChatConfigFromMetadataFile,
  hydrateAppAgentChatFromDisk,
  resolveAppAgentChatConfig,
  resolveAppAgentChatForMetadataWrite,
} from "../src/gateway/services/appAgentChat/appAgentChatPersistence.js";
import { serializeCloudAppMetadataFile } from "../src/core/utils/cloudAppMetadata.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";

function setupAppDir(paprDir: string, appsJsonEntry: Record<string, unknown>): void {
  mkdirSync(path.join(paprDir, "data"), { recursive: true });
  mkdirSync(path.join(paprDir, "apps", APP_ID), { recursive: true });
  writeFileSync(
    path.join(paprDir, "data", "apps.json"),
    JSON.stringify([appsJsonEntry]),
    "utf8",
  );
}

describe("appAgentChatPersistence", () => {
  it("writes sidecar and metadata via enable flow files", async () => {
    const paprDir = mkdtempSync(path.join(tmpdir(), "papr-sidecar-"));
    setupAppDir(paprDir, {
      id: APP_ID,
      title: "Test App",
      type: "app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const agentChat = {
      enabled: true,
      subAgentId: "agent-test",
      welcomeMessage: "Hello",
      systemContext: "Domain rules",
      allowedToolIds: ["read_app_file"],
      cloudJobId: "job-123",
    };

    await writeAgentChatSidecar(paprDir, APP_ID, agentChat);
    expect(readAgentChatSidecarSync(paprDir, APP_ID)).toEqual(agentChat);

    await writeCloudAppMetadataFile(paprDir, APP_ID);
    const metadata = JSON.parse(
      readFileSync(path.join(paprDir, "apps", APP_ID, "metadata.json"), "utf8"),
    ) as {
      agentChat?: { enabled?: boolean; subAgentId?: string };
      agentChatJobId?: string;
    };

    expect(metadata.agentChat?.enabled).toBe(true);
    expect(metadata.agentChat?.subAgentId).toBe("agent-test");
    expect(metadata.agentChatJobId).toBe("job-123");
  });

  it("resolves agent chat from metadata.json when registry is stripped", async () => {
    const paprDir = mkdtempSync(path.join(tmpdir(), "papr-metadata-fallback-"));
    setupAppDir(paprDir, {
      id: APP_ID,
      title: "Deck Studio",
      type: "app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    writeFileSync(
      path.join(paprDir, "apps", APP_ID, "metadata.json"),
      serializeCloudAppMetadataFile({
        appId: APP_ID,
        title: "Deck Studio",
        description: "Pitch decks",
        updatedAt: new Date().toISOString(),
        agentChat: {
          enabled: true,
          subAgentId: "agent-deck",
          welcomeMessage: "Build my deck",
        },
        agentChatJobId: "job-deck-1",
      }),
      "utf8",
    );

    const resolved = await resolveAppAgentChatConfig(paprDir, APP_ID);
    expect(resolved?.enabled).toBe(true);
    expect(resolved?.subAgentId).toBe("agent-deck");
    expect(resolved?.cloudJobId).toBe("job-deck-1");
  });

  it("backfills sidecar from metadata on hydrate", async () => {
    const paprDir = mkdtempSync(path.join(tmpdir(), "papr-hydrate-"));
    setupAppDir(paprDir, {
      id: APP_ID,
      title: "Test App",
      type: "app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    writeFileSync(
      path.join(paprDir, "apps", APP_ID, "metadata.json"),
      serializeCloudAppMetadataFile({
        appId: APP_ID,
        title: "Test App",
        description: "Test",
        updatedAt: new Date().toISOString(),
        agentChat: {
          enabled: true,
          subAgentId: "agent-hydrate",
        },
        agentChatJobId: "job-hydrate",
      }),
      "utf8",
    );

    const hydration = await hydrateAppAgentChatFromDisk(paprDir, APP_ID);
    expect(hydration.sidecarBackfilled).toBe(true);
    expect(hydration.agentChat?.subAgentId).toBe("agent-hydrate");
    expect(readAgentChatSidecarSync(paprDir, APP_ID)?.cloudJobId).toBe("job-hydrate");
  });

  it("does not strip metadata agentChat when registry entry lacks agentChat", () => {
    const paprDir = mkdtempSync(path.join(tmpdir(), "papr-metadata-merge-"));
    setupAppDir(paprDir, {
      id: APP_ID,
      title: "Test App",
      type: "app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    writeFileSync(
      path.join(paprDir, "apps", APP_ID, "metadata.json"),
      serializeCloudAppMetadataFile({
        appId: APP_ID,
        title: "Test App",
        description: "Test",
        updatedAt: new Date().toISOString(),
        agentChat: {
          enabled: true,
          subAgentId: "agent-keep",
        },
        agentChatJobId: "job-keep",
      }),
      "utf8",
    );

    const forWrite = resolveAppAgentChatForMetadataWrite(paprDir, APP_ID);
    expect(forWrite?.enabled).toBe(true);
    expect(forWrite?.subAgentId).toBe("agent-keep");
  });

  it("converts metadata file to full config shape", () => {
    const config = agentChatConfigFromMetadataFile({
      appId: APP_ID,
      title: "T",
      description: "D",
      updatedAt: new Date().toISOString(),
      agentChat: {
        enabled: true,
        subAgentId: "agent-x",
        bubbleLabel: "Ask",
      },
      agentChatJobId: "job-x",
    });
    expect(config).toEqual({
      enabled: true,
      subAgentId: "agent-x",
      bubbleLabel: "Ask",
      cloudJobId: "job-x",
    });
  });
});
