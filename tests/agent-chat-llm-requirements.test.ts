import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  buildAgentChatLlmRequirement,
  collectLlmEnvKeysForProviders,
  llmEnvKeyForProvider,
  mergeAgentChatLlmKeysIntoRequirements,
} from "../src/core/utils/agentChatLlmRequirements.js";
import {
  readAgentChatLlmKeyNames,
  readEffectiveAppRequirements,
} from "../src/gateway/services/cloudAppRequirements.js";
import type { SubAgentProfile } from "../src/core/types/subagents.js";

const APP_ID = "9e70c06b-ac30-4c95-bfe2-adc1daecbeb0";
const SUB_AGENT_ID = "agent-test-sub";

function setupPaprDir(): string {
  const paprDir = mkdtempSync(path.join(tmpdir(), "papr-agent-chat-llm-"));
  mkdirSync(path.join(paprDir, "data"), { recursive: true });
  mkdirSync(path.join(paprDir, "apps", APP_ID), { recursive: true });
  return paprDir;
}

describe("agentChatLlmRequirements", () => {
  it("maps providers to LLM env keys", () => {
    expect(llmEnvKeyForProvider("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(llmEnvKeyForProvider("openai-codex")).toBe("OPENAI_API_KEY");
    expect(llmEnvKeyForProvider("google")).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  it("builds owner-scoped ai catalog rows by default", () => {
    const spec = buildAgentChatLlmRequirement("ANTHROPIC_API_KEY");
    expect(spec.category).toBe("ai");
    expect(spec.credentialScope).toBe("owner");
    expect(spec.clientAccess).toBe("server");
  });

  it("merges without overwriting existing scope", () => {
    const merged = mergeAgentChatLlmKeysIntoRequirements(
      [
        {
          name: "ANTHROPIC_API_KEY",
          service: "Anthropic",
          category: "ai",
          description: "Visitor pays",
          required: true,
          credentialScope: "user",
          clientAccess: "server",
        },
      ],
      ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    );
    expect(merged).toHaveLength(2);
    const anthropic = merged.find((row) => row.name === "ANTHROPIC_API_KEY");
    expect(anthropic?.credentialScope).toBe("user");
    const openai = merged.find((row) => row.name === "OPENAI_API_KEY");
    expect(openai?.credentialScope).toBe("owner");
  });

  it("collects primary and fallback provider keys", () => {
    expect(
      collectLlmEnvKeysForProviders(["anthropic", "openai"]),
    ).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });
});

describe("readAgentChatLlmKeyNames", () => {
  it("returns LLM keys when embedded chat is enabled", async () => {
    const paprDir = setupPaprDir();
    const jobId = "job-agent-chat-1";
    mkdirSync(path.join(paprDir, "Jobs", jobId), { recursive: true });

    const profile: SubAgentProfile = {
      id: SUB_AGENT_ID,
      name: "Deck Assistant",
      description: "Helps edit decks",
      systemPrompt: "You help with decks",
      provider: "anthropic",
      fallbackProvider: "openai",
      allowedToolIds: [],
      assignedSkills: [],
      outputMode: "natural",
      maxTurns: 20,
      memoryPolicy: "none",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      runCount: 0,
    };

    writeFileSync(
      path.join(paprDir, "data", "subagents.json"),
      JSON.stringify([profile], null, 2),
      "utf8",
    );
    writeFileSync(
      path.join(paprDir, "data", "apps.json"),
      JSON.stringify([
        {
          id: APP_ID,
          title: "Deck Studio",
          agentChat: {
            enabled: true,
            subAgentId: SUB_AGENT_ID,
            cloudJobId: jobId,
          },
        },
      ]),
      "utf8",
    );
    writeFileSync(
      path.join(paprDir, "Jobs", jobId, "job.json"),
      JSON.stringify({ provider: "google" }),
      "utf8",
    );

    expect(readAgentChatLlmKeyNames(paprDir, APP_ID).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "OPENAI_API_KEY",
    ]);

    const effective = await readEffectiveAppRequirements(paprDir, APP_ID);
    const names = effective.map((row) => row.name).sort();
    expect(names).toEqual([
      "ANTHROPIC_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "OPENAI_API_KEY",
    ]);
    expect(
      effective.every((row) => row.category === "ai" && row.credentialScope === "owner"),
    ).toBe(true);
  });

  it("returns empty when agent chat disabled", () => {
    const paprDir = setupPaprDir();
    writeFileSync(
      path.join(paprDir, "data", "apps.json"),
      JSON.stringify([
        {
          id: APP_ID,
          title: "Deck Studio",
          agentChat: { enabled: false, subAgentId: SUB_AGENT_ID },
        },
      ]),
      "utf8",
    );
    expect(readAgentChatLlmKeyNames(paprDir, APP_ID)).toEqual([]);
  });
});
