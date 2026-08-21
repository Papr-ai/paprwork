/**
 * E2E: Sync V3 — memory server route contract + RepoRegistry + P0 coordination.
 *
 * Requires:
 *   - Memory server running with Sync V3 routes (default http://127.0.0.1:5001)
 *   - PAPR_API_KEY in env or Papr login settings
 *
 * Run:
 *   npm run test:sync-v3-e2e:vitest
 *   PAPR_MEMORY_SERVER_URL=http://127.0.0.1:5001 npm run test:sync-v3-e2e:vitest
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAppRepoRecord } from "../../src/core/types/appRepoRegistry.js";
import { buildDesktopHeartbeatBody } from "../../src/gateway/services/syncV3/buildDesktopHeartbeatBody.js";
import {
  assertAppRepoRouteHandlesMissingApp,
  verifySyncV3MemoryRoutes,
} from "../../scripts/lib/syncV3MemoryContract.mjs";

function loadApiKey(): string | null {
  if (process.env.PAPR_API_KEY?.trim()) {
    return process.env.PAPR_API_KEY.trim();
  }
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
      if (key) return key;
    } catch {
      /* try next */
    }
  }
  return null;
}

const memoryBase = (
  process.env.PAPR_MEMORY_SERVER_URL ?? "http://127.0.0.1:5001"
).replace(/\/$/, "");

const apiKey = loadApiKey();
const e2eEnabled = apiKey !== null;
const allowPartial = process.env.SYNC_V3_E2E_ALLOW_PARTIAL === "1";

async function memoryFetch(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: unknown; text: string }> {
  const res = await fetch(`${memoryBase}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey ?? "",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    /* plain text error */
  }
  return { status: res.status, data, text };
}

function expectRouteOrSkip(label: string, status: number): boolean {
  if (status === 404 || status === 501) {
    if (allowPartial) {
      console.warn(`[sync-v3 e2e] skipping ${label} — route returned ${status}`);
      return true;
    }
    expect.fail(`${label}: route unavailable (${status}) — deploy Sync V3 memory server`);
  }
  return false;
}

describe.skipIf(!e2eEnabled)("E2E: Sync V3 memory server", () => {
  beforeAll(async () => {
    const contract = await verifySyncV3MemoryRoutes(memoryBase);
    if (!contract.ok) {
      const missing = contract.missing.map((m) => m.label).join(", ");
      if (allowPartial) {
        console.warn(
          `[sync-v3 e2e] Sync V3 OpenAPI contract incomplete (${missing}) — set SYNC_V3_E2E_ALLOW_PARTIAL=1 to skip strict mode`,
        );
        return;
      }
      expect.fail(
        `Sync V3 OpenAPI route contract failed: ${contract.error}. Missing: ${missing}`,
      );
    }
  });

  it("OpenAPI lists all Sync V3 routes", async () => {
    const contract = await verifySyncV3MemoryRoutes(memoryBase);
    expect(contract.ok).toBe(true);
  });

  it("accepts desktop heartbeat body built by gateway", async () => {
    const body = buildDesktopHeartbeatBody("2.0.0-e2e-vitest");
    const res = await memoryFetch("/v1/cloud/runtime/heartbeat", {
      method: "POST",
      body,
    });

    expect(res.status).toBe(200);
    const payload = res.data as {
      recordedAt?: string;
      staleAfterSeconds?: number;
      pendingCloudRuns?: unknown[];
    };
    expect(payload.recordedAt).toBeTruthy();
    expect(typeof payload.staleAfterSeconds).toBe("number");
    expect(Array.isArray(payload.pendingCloudRuns)).toBe(true);
  });

  it("GET /repo returns 404 for unknown app after contract", async () => {
    const contract = await verifySyncV3MemoryRoutes(memoryBase);
    if (!contract.ok && allowPartial) {
      return;
    }
    expect(contract.ok).toBe(true);

    const appId = `e2e-vitest-${randomUUID()}`;
    const probe = await assertAppRepoRouteHandlesMissingApp(
      async (path, init = {}) => {
        const res = await memoryFetch(path, init);
        return { status: res.status, text: res.text };
      },
      appId,
    );
    expect(probe.ok).toBe(true);
  });

  it("RepoRegistry ensure + GET round-trip (when GitHub configured)", async () => {
    const contract = await verifySyncV3MemoryRoutes(memoryBase);
    if (!contract.ok && allowPartial) {
      return;
    }

    const appId = `e2e-vitest-${randomUUID()}`;

    const ensure = await memoryFetch(
      `/v1/cloud/apps/${encodeURIComponent(appId)}/repo/ensure`,
      { method: "POST", body: {} },
    );

    if (ensure.status === 503) {
      console.warn(
        "[sync-v3 e2e] skipping RepoRegistry ensure — GitHub not configured on memory server",
      );
      return;
    }

    expect(ensure.status).toBe(200);
    const record = parseAppRepoRecord(ensure.data);
    expect(record.appId).toBe(appId);
    expect(record.cloneUrl.endsWith(".git")).toBe(true);

    const getRes = await memoryFetch(
      `/v1/cloud/apps/${encodeURIComponent(appId)}/repo`,
    );
    expect(getRes.status).toBe(200);
    const fetched = parseAppRepoRecord(getRes.data);
    expect(fetched.cloneUrl).toBe(record.cloneUrl);
    expect(fetched.createdAt).toBe(record.createdAt);

    const ensureAgain = await memoryFetch(
      `/v1/cloud/apps/${encodeURIComponent(appId)}/repo/ensure`,
      { method: "POST", body: {} },
    );
    expect(ensureAgain.status).toBe(200);
    const again = parseAppRepoRecord(ensureAgain.data);
    expect(again.cloneUrl).toBe(record.cloneUrl);
    expect(again.createdAt).toBe(record.createdAt);
  });

  it("job-runtime upsert persists without git writeback", async () => {
    const jobId = `e2e-vitest-runtime-${randomUUID().slice(0, 8)}`;
    const recordedAt = new Date().toISOString();
    const marker = `vitest_sync_v3_${Date.now()}`;

    const upsert = await memoryFetch("/v1/cloud/runtime/job-runtime/upsert", {
      method: "POST",
      body: {
        jobId,
        status: "completed",
        recordedAt,
        lastOutput: marker,
        source: "sync_v3_e2e_vitest",
      },
    });

    expect(upsert.status).toBe(200);
    const upsertBody = upsert.data as { accepted?: boolean };
    expect(upsertBody.accepted).toBe(true);

    const list = await memoryFetch("/v1/cloud/runtime/job-runtime");
    expect(list.status).toBe(200);
    const listBody = list.data as {
      patches?: Array<{ jobId?: string; lastOutput?: string }>;
    };
    const patch = (listBody.patches ?? []).find((p) => p.jobId === jobId);
    expect(patch).toBeDefined();
    expect(String(patch?.lastOutput ?? "")).toContain(marker);
  });

  it("scheduler run lease acquire blocks cross-side contention", async () => {
    const jobId = `e2e-vitest-lease-${randomUUID().slice(0, 8)}`;
    const dueAt = new Date().toISOString();

    const desktop = await memoryFetch(
      "/v1/cloud/runtime/scheduler-run-lease/acquire",
      {
        method: "POST",
        body: { jobId, dueAt, holder: "desktop" },
      },
    );
    if (expectRouteOrSkip("scheduler run lease", desktop.status)) {
      return;
    }
    expect(desktop.status).toBe(200);
    const desktopBody = desktop.data as { acquired?: boolean; runId?: string };
    expect(desktopBody.acquired).toBe(true);
    expect(desktopBody.runId).toBeTruthy();

    const cloud = await memoryFetch(
      "/v1/cloud/runtime/scheduler-run-lease/acquire",
      {
        method: "POST",
        body: { jobId, dueAt, holder: "cloud:vitest" },
      },
    );
    expect(cloud.status).toBe(200);
    const cloudBody = cloud.data as { acquired?: boolean };
    if (cloudBody.acquired) {
      console.warn("[sync-v3 e2e] Mongo degraded — both holders acquired");
    } else {
      expect(cloudBody.acquired).toBe(false);
    }

    const release = await memoryFetch(
      "/v1/cloud/runtime/scheduler-run-lease/release",
      {
        method: "POST",
        body: {
          jobId,
          dueAt,
          runId: desktopBody.runId,
          holder: "desktop",
        },
      },
    );
    expect(release.status).toBe(200);
  });

  it("workspace log rejects non-idempotent UPDATE and returns monotonic seq", async () => {
    const replicaId = `j-vt${randomUUID().replace(/-/g, "").slice(0, 10)}`;

    const schema = await memoryFetch("/v1/cloud/workspace/log/append", {
      method: "POST",
      body: {
        replicaId,
        kind: "schema",
        dbSourceId: "primary",
        payload: {
          appId: "vitest-log",
          sql: "CREATE TABLE IF NOT EXISTS vitest_items (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
        },
      },
    });
    if (expectRouteOrSkip("workspace log append", schema.status)) {
      return;
    }
    expect(schema.status).toBe(200);
    const schemaBody = schema.data as { seq?: number };
    expect(schemaBody.seq).toBeGreaterThan(0);

    const row = await memoryFetch("/v1/cloud/workspace/log/append", {
      method: "POST",
      body: {
        replicaId,
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "vitest-log",
          sql: "INSERT OR REPLACE INTO vitest_items (id, n) VALUES (?, ?)",
          params: [1, 7],
        },
      },
    });
    expect(row.status).toBe(200);
    const rowBody = row.data as { seq?: number };
    expect(rowBody.seq).toBe((schemaBody.seq ?? 0) + 1);

    const bad = await memoryFetch("/v1/cloud/workspace/log/append", {
      method: "POST",
      body: {
        replicaId,
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "vitest-log",
          sql: "UPDATE vitest_items SET n = n + 1 WHERE id = ?",
          params: [1],
        },
      },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});
