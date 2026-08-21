#!/usr/bin/env node
/**
 * Seed three workspace-log workload patterns on memory server and capture replay fixtures.
 *
 * Usage:
 *   npm run fixtures:capture-workspace-log
 *
 * Requires PAPR_API_KEY and memory server at PAPR_MEMORY_URL (default http://127.0.0.1:5001).
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

function loadApiKey() {
  if (process.env.PAPR_API_KEY) {
    return process.env.PAPR_API_KEY;
  }
  const settingsPath = join(homedir(), "Papr", "data", "settings.json");
  if (!existsSync(settingsPath)) {
    return null;
  }
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    return (
      settings?.customKeys?.PAPR_API_KEY ??
      settings?.paprProfile?.apiKey ??
      null
    );
  } catch {
    return null;
  }
}

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/workspace-log",
);

const apiKey = loadApiKey();
if (!apiKey) {
  console.error("Set PAPR_API_KEY (env or Papr login in ~/Papr/data/settings.json).");
  process.exit(1);
}

const baseUrl = (
  process.env.PAPR_MEMORY_URL ??
  process.env.PAPR_MEMORY_SERVER_URL ??
  "http://127.0.0.1:5001"
).replace(/\/$/, "");

async function apiPost(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** @typedef {{ replicaId: string; description: string; seeds: Array<{ kind: string; payload: Record<string, unknown>; dbSourceId?: string }> }} Workload */

/** @type {Workload[]} */
const workloads = [
  {
    replicaId: "j-prod-sample-1",
    description: "Row delta workload — INSERT/UPDATE/DELETE",
    seeds: [
      {
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "fixture-app-1",
          sql: "INSERT INTO items (name, qty) VALUES (?, ?)",
          params: ["widget", 1],
        },
      },
      {
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "fixture-app-1",
          sql: "UPDATE items SET qty = ? WHERE name = ?",
          params: [2, "widget"],
        },
      },
      {
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "fixture-app-1",
          sql: "DELETE FROM items WHERE name = ?",
          params: ["widget"],
        },
      },
    ],
  },
  {
    replicaId: "j-prod-sample-2",
    description: "Schema migration + row insert",
    seeds: [
      {
        kind: "schema",
        dbSourceId: "primary",
        payload: {
          migrationId: "20260802_add_metrics",
          contentHash: "abc123schema",
          sql: "CREATE TABLE metrics (id INTEGER PRIMARY KEY, value REAL NOT NULL)",
        },
      },
      {
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "fixture-app-2",
          sql: "INSERT INTO metrics (value) VALUES (?)",
          params: [42.5],
        },
      },
    ],
  },
  {
    replicaId: "j-prod-sample-3",
    description: "Genesis snapshot + mixed row batch",
    seeds: [
      {
        kind: "snapshot",
        dbSourceId: "primary",
        payload: {
          snapshotHash: "genesis-hash-prod-3",
          tableCount: 2,
          genesis: true,
        },
      },
      {
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "fixture-app-3",
          sql: "INSERT INTO events (type) VALUES (?)",
          params: ["open"],
        },
      },
      {
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "fixture-app-3",
          sql: "INSERT INTO events (type) VALUES (?)",
          params: ["click"],
        },
      },
      {
        kind: "row",
        dbSourceId: "primary",
        payload: {
          appId: "fixture-app-3",
          sql: "INSERT INTO events (type) VALUES (?)",
          params: ["close"],
        },
      },
    ],
  },
];

mkdirSync(FIXTURE_DIR, { recursive: true });

for (let index = 0; index < workloads.length; index += 1) {
  const workload = workloads[index];
  console.log(`Seeding ${workload.replicaId} (${workload.seeds.length} entries)...`);
  for (const seed of workload.seeds) {
    await apiPost("/v1/cloud/workspace/log/append", {
      replicaId: workload.replicaId,
      kind: seed.kind,
      dbSourceId: seed.dbSourceId,
      payload: seed.payload,
    });
  }

  const outFile = resolve(FIXTURE_DIR, `prod-sample-${index + 1}.json`);
  const capture = spawnSync(
    process.execPath,
    [
      resolve(dirname(fileURLToPath(import.meta.url)), "capture-workspace-log-sample.mjs"),
      `--replica-id=${workload.replicaId}`,
      "--cursor=0",
      `--out=${outFile}`,
    ],
    {
      env: process.env,
      encoding: "utf8",
    },
  );
  if (capture.status !== 0) {
    console.error(capture.stderr || capture.stdout);
    process.exit(1);
  }
  console.log(capture.stdout.trim());
}

console.log(`Captured ${workloads.length} fixtures to ${FIXTURE_DIR}`);
