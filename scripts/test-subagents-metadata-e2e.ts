#!/usr/bin/env node
/**
 * E2E — sub-agents Mongo metadata registry (Phase 4.6).
 *
 * Layer 1: Mock memory server — upload, fetch, hydrate round-trip (always runs).
 * Layer 2: Live memory server — PUT/GET /v1/cloud/metadata/subagents (optional).
 * Layer 3: Local Deck Studio profile on disk.
 *
 * Usage:
 *   node --import tsx scripts/test-subagents-metadata-e2e.ts
 *   PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 node --import tsx scripts/test-subagents-metadata-e2e.ts
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  uploadSubAgentsIndexToCloudDirect,
  fetchSubAgentsIndexFromCloudDirect,
} from "../src/gateway/services/syncV3/MetadataRegistryClient.js";
import { hydrateSubAgentsRegistryForCloudRun } from "../src/gateway/services/cloudAgentGateway/hydrateSubAgentsRegistryForCloudRun.js";
import type { SubAgentConfigSlice } from "../src/gateway/services/subagents/subAgentMetadataSlice.js";

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RESET = "\x1b[0m";

let failed = 0;
let passed = 0;

function pass(name: string, detail = ""): void {
  console.log(`  ${GREEN}PASS${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

function fail(name: string, detail = ""): void {
  console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
  failed++;
}

function skip(name: string, detail = ""): void {
  console.log(`  ${YELLOW}SKIP${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
}

function loadEnvLocal(): void {
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

function loadApiKeyFromSettings(): string | null {
  for (const settingsPath of [
    join(homedir(), "Papr", "data", "settings.json"),
    join(homedir(), ".paprwork-v2", "settings.json"),
  ]) {
    try {
      if (!existsSync(settingsPath)) continue;
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        customKeys?: { PAPR_API_KEY?: string };
        paprProfile?: { apiKey?: string };
      };
      const key =
        settings.customKeys?.PAPR_API_KEY ?? settings.paprProfile?.apiKey ?? null;
      if (key?.trim()) return key.trim();
    } catch {
      /* try next */
    }
  }
  return null;
}

async function resolveLiveCredentials(): Promise<{
  apiKey: string;
  source: string;
} | null> {
  const fromEnv = process.env.PAPR_API_KEY?.trim();
  if (fromEnv) {
    return { apiKey: fromEnv, source: "env" };
  }

  const fromSettings = loadApiKeyFromSettings();
  if (fromSettings) {
    return { apiKey: fromSettings, source: "settings" };
  }

  try {
    const { resolvePaprApiKey } = await import("./lib/testEnv.mjs");
    const resolved = await resolvePaprApiKey();
    if (resolved) {
      return { apiKey: resolved.key, source: resolved.source };
    }
  } catch {
    /* optional */
  }

  // Local dev fallback: memory repo test keys (same org as typical Papr dev workspaces).
  try {
    const memoryEnvPath = join(process.cwd(), "..", "memory", ".env");
    const memoryEnv = readFileSync(memoryEnvPath, "utf8");
    for (const line of memoryEnv.split("\n")) {
      const match = line.match(/^TEST_X_USER_API_KEY_B=(.+)$/);
      if (match?.[1]?.trim().startsWith("sk-")) {
        return { apiKey: match[1].trim(), source: "memory/.env (dev)" };
      }
    }
  } catch {
    /* optional */
  }

  return null;
}

interface MockStore {
  profiles: SubAgentConfigSlice[];
  updatedAt: string;
}

function startMockMemoryServer(): Promise<{
  baseUrl: string;
  server: Server;
  getStore: () => MockStore;
}> {
  let store: MockStore = {
    profiles: [],
    updatedAt: new Date().toISOString(),
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname !== "/v1/cloud/metadata/subagents") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    if (req.method === "PUT") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as {
            profiles?: SubAgentConfigSlice[];
            updatedAt?: string;
          };
          store = {
            profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
            updatedAt: parsed.updatedAt ?? new Date().toISOString(),
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true, source: "mongo" }));
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
      return;
    }

    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          profiles: store.profiles,
          source: "mongo",
          count: store.profiles.length,
        }),
      );
      return;
    }

    res.writeHead(405);
    res.end("method not allowed");
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mock server failed to bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        server,
        getStore: () => store,
      });
    });
  });
}

async function runMockRoundTripE2E(): Promise<void> {
  console.log(`\n${CYAN}Layer 1 — Mock memory server round-trip${RESET}`);

  const savedMemoryUrl = process.env.PAPR_MEMORY_SERVER_URL;
  const savedApiKey = process.env.PAPR_API_KEY;

  const agentId = `agent-e2e-${randomUUID()}`;
  const profile: SubAgentConfigSlice = {
    id: agentId,
    name: "E2E Test Agent",
    description: "metadata registry e2e",
    systemPrompt: "You are an E2E test assistant.",
    allowedToolIds: ["bash"],
    assignedSkills: [],
    outputMode: "natural",
    maxTurns: 10,
    memoryPolicy: "none",
    icon: "robot",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T05:00:00.000Z",
  };

  const mock = await startMockMemoryServer();
  const paprHome = mkdtempSync(join(tmpdir(), "papr-subagents-e2e-"));

  try {
    mkdirSync(join(paprHome, "data"), { recursive: true });
    writeFileSync(
      join(paprHome, "data", "subagents.json"),
      JSON.stringify(
        [
          {
            ...profile,
            name: "Stale Clone Name",
            systemPrompt: "stale prompt from git clone",
            updatedAt: "2026-01-01T00:00:00.000Z",
            runCount: 0,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    process.env.PAPR_MEMORY_SERVER_URL = mock.baseUrl;
    process.env.PAPR_API_KEY = "sk-e2e-test-key";

    const uploaded = await uploadSubAgentsIndexToCloudDirect(
      [profile],
      profile.updatedAt,
      "sk-e2e-test-key",
    );
    if (!uploaded) {
      fail("desktop upload to mock Mongo");
    } else {
      pass("desktop upload to mock Mongo");
    }

    const stored = mock.getStore();
    if (stored.profiles.some((p) => p.id === agentId && p.name === "E2E Test Agent")) {
      pass("mock Mongo persisted profile");
    } else {
      fail("mock Mongo persisted profile", JSON.stringify(stored.profiles));
    }

    const fetched = await fetchSubAgentsIndexFromCloudDirect("sk-e2e-test-key");
    if (fetched?.some((p) => p.id === agentId)) {
      pass("desktop fetch from mock Mongo");
    } else {
      fail("desktop fetch from mock Mongo");
    }

    const hydrateResult = await hydrateSubAgentsRegistryForCloudRun({
      paprHome,
      paprApiKey: "sk-e2e-test-key",
    });
    if (hydrateResult.hydrated >= 1 && hydrateResult.source === "mongo") {
      pass("cloud hydrate from mock Mongo", `hydrated=${hydrateResult.hydrated}`);
    } else {
      fail("cloud hydrate from mock Mongo", JSON.stringify(hydrateResult));
    }

    const hydrated = JSON.parse(
      readFileSync(join(paprHome, "data", "subagents.json"), "utf8"),
    ) as Array<{ id: string; name: string; systemPrompt: string }>;
    const entry = hydrated.find((p) => p.id === agentId);
    if (entry?.name === "E2E Test Agent" && entry.systemPrompt.includes("E2E test")) {
      pass("hydrated subagents.json has fresh Mongo profile");
    } else {
      fail("hydrated subagents.json has fresh Mongo profile", JSON.stringify(entry));
    }
  } finally {
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    rmSync(paprHome, { recursive: true, force: true });
    if (savedMemoryUrl === undefined) delete process.env.PAPR_MEMORY_SERVER_URL;
    else process.env.PAPR_MEMORY_SERVER_URL = savedMemoryUrl;
    if (savedApiKey === undefined) delete process.env.PAPR_API_KEY;
    else process.env.PAPR_API_KEY = savedApiKey;
  }
}

async function runLiveMemoryE2E(apiKey: string): Promise<void> {
  const memoryBase = (
    process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001"
  ).replace(/\/$/, "");

  console.log(`\n${CYAN}Layer 2 — Live memory server (${memoryBase})${RESET}`);

  const health = await fetch(`${memoryBase}/health`).catch(() => null);
  if (!health?.ok) {
    skip("live memory", `not reachable at ${memoryBase}/health`);
    console.log("         Start: cd ../memory && poetry run uvicorn main:app --host 127.0.0.1 --port 5001");
    return;
  }
  pass("live memory /health");

  const savedMemoryUrl = process.env.PAPR_MEMORY_SERVER_URL;
  process.env.PAPR_MEMORY_SERVER_URL = memoryBase;

  try {
    const agentId = `agent-e2e-live-${randomUUID().slice(0, 8)}`;
    const updatedAt = new Date().toISOString();
    const profile: SubAgentConfigSlice = {
      id: agentId,
      name: "Live E2E Agent",
      description: "live metadata e2e",
      systemPrompt: "Live E2E sub-agent profile",
      allowedToolIds: ["bash"],
      assignedSkills: [],
      outputMode: "natural",
      maxTurns: 10,
      memoryPolicy: "none",
      icon: "robot",
      createdAt: updatedAt,
      updatedAt,
    };

    const uploaded = await uploadSubAgentsIndexToCloudDirect(
      [profile],
      updatedAt,
      apiKey,
    );
    if (!uploaded) {
      fail("live PUT subagents index accepted");
      return;
    }
    pass("live PUT subagents index accepted");

    const profiles = await fetchSubAgentsIndexFromCloudDirect(apiKey);
    const found = profiles?.some((p) => p.id === agentId) ?? false;
    if (!found) {
      fail("live GET contains uploaded profile");
      return;
    }
    pass("live GET subagents index", `count=${profiles?.length ?? 0}`);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("404")) {
      fail(
        "live subagents metadata route",
        "404 — deploy memory server with subagents routes first",
      );
    } else {
      fail("live subagents metadata route", message.slice(0, 160));
    }
  } finally {
    if (savedMemoryUrl === undefined) delete process.env.PAPR_MEMORY_SERVER_URL;
    else process.env.PAPR_MEMORY_SERVER_URL = savedMemoryUrl;
  }
}

function runDeckStudioLocalCheck(): void {
  console.log(`\n${CYAN}Layer 3 — Local Deck Studio profile (disk)${RESET}`);
  const paprHome =
    process.env.PAPR_HOME ??
    join(homedir(), "Papr", "orgs", "Y8D4H7Yp3Z", "namespaces", "85ZIB7mD1V");
  const subagentsPath = join(paprHome, "data", "subagents.json");
  const deckAgentId = "agent-f1e31d27-eef4-4222-8769-c9c858feb9cc";

  if (!existsSync(subagentsPath)) {
    skip("local subagents.json", subagentsPath);
    return;
  }

  let list: unknown;
  try {
    list = JSON.parse(readFileSync(subagentsPath, "utf8"));
  } catch {
    fail("parse local subagents.json");
    return;
  }

  const deckProfile = Array.isArray(list)
    ? (list as Array<{ id?: string; name?: string }>).find((p) => p?.id === deckAgentId)
    : null;
  if (deckProfile) {
    pass("Deck Studio sub-agent profile on disk", deckProfile.name ?? deckAgentId);
  } else {
    fail(
      "Deck Studio sub-agent profile on disk",
      `${deckAgentId} missing — restart gateway for sidecar recovery`,
    );
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log(`\n${CYAN}Sub-agents Mongo metadata E2E${RESET}`);
  console.log("=".repeat(60));

  await runMockRoundTripE2E();

  const credentials = await resolveLiveCredentials();
  if (credentials) {
    console.log(`         Auth: ${credentials.source}`);
    await runLiveMemoryE2E(credentials.apiKey);
  } else {
    console.log(`\n${CYAN}Layer 2 — Live memory server${RESET}`);
    skip("live memory", "PAPR_API_KEY not found — login with Papr or start local memory server");
  }

  runDeckStudioLocalCheck();

  console.log("\n" + "=".repeat(60));
  console.log(
    `Results: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : GREEN}${failed} failed${RESET}`,
  );
  if (failed > 0) process.exit(1);
  console.log(`${GREEN}All sub-agents metadata E2E checks passed.${RESET}\n`);
}

main().catch((err: Error) => {
  console.error(`${RED}Fatal:${RESET}`, err.message);
  process.exit(1);
});
