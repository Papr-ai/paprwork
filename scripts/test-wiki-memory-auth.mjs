#!/usr/bin/env node
/**
 * Diagnose Wiki / Papr Memory auth + scope issues.
 *
 * Usage:
 *   node scripts/test-wiki-memory-auth.mjs
 *   npm run test:wiki-memory-auth
 */

import { config } from "dotenv";
import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import Papr from "@papr/memory";

config({ path: join(process.cwd(), ".env.local") });

const apiKey = process.env.PAPR_API_KEY;
const baseURL = process.env.PAPR_BASE_URL || "https://memory.papr.ai";

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function parseNamespaceFromKey(key) {
  const match = key.match(/namespace-([A-Za-z0-9]+)-/);
  return match?.[1] ?? "(unknown)";
}

async function main() {
  section("Config");
  console.log("Base URL:", baseURL);
  console.log("API key:", apiKey ? `${apiKey.slice(0, 24)}… (namespace ${parseNamespaceFromKey(apiKey)})` : "MISSING");

  let pointer;
  try {
    const { readActiveWorkspacePointer } = await import(
      "../dist/core/utils/paprWorkspace.js"
    );
    pointer = readActiveWorkspacePointer();
    console.log("Active workspace:", pointer ?? "(legacy ~/Papr)");
  } catch (error) {
    console.log("Active workspace: (could not read)", error);
  }

  const { getPaprWorkspaceDir } = await import("../dist/core/utils/paprRoot.js");
  const entitiesDir = join(getPaprWorkspaceDir(), "entities");
  console.log("Wiki entities dir:", entitiesDir);
  console.log("Entities dir exists:", existsSync(entitiesDir));
  if (existsSync(entitiesDir)) {
    let count = 0;
    for (const typeDir of readdirSync(entitiesDir)) {
      const dirPath = join(entitiesDir, typeDir);
      if (!statSync(dirPath).isDirectory()) continue;
      count += readdirSync(dirPath).filter((f) => f.endsWith(".md")).length;
    }
    console.log("Local entity files:", count);
  }

  if (!apiKey) {
    console.error("\nSet PAPR_API_KEY in .env.local or sign in via Papr.");
    process.exit(1);
  }

  const client = new Papr({ xAPIKey: apiKey, baseURL, maxRetries: 0, timeout: 30000 });

  const { getMemoryScopeContext } = await import(
    "../dist/gateway/utils/memoryScopeResolver.js"
  );
  const { buildMemorySearchScopeFields } = await import(
    "../dist/core/utils/memoryScope.js"
  );
  const ctx = getMemoryScopeContext();
  console.log("Memory scope context:", ctx);

  section("GraphQL (API key only)");
  const graphqlTests = [
    ["people", "{ people { id } }"],
    ["projects", "{ projects { id } }"],
    ["goals", "{ goals { status } }"],
    ["people+name (bad)", "{ people { id name } }"],
  ];
  for (const [label, query] of graphqlTests) {
    try {
      const raw = await client.graphql.query({ body: { query } });
      const response = raw;
      const key = query.match(/\{\s*(\w+)/)?.[1];
      const rows = key && response.data?.[key];
      const count = Array.isArray(rows) ? rows.length : 0;
      const errCount = response.errors?.length ?? 0;
      console.log(
        `${label}: ${errCount ? `partial/errors (${errCount})` : "OK"}, rows=${count}`,
      );
      if (errCount) {
        console.log("  ", response.errors.map((e) => e.message).join("; ").slice(0, 120));
      }
    } catch (error) {
      const err = error;
      console.log(`${label}: HTTP FAIL ${err.status ?? ""} ${err.message ?? error}`);
    }
  }

  section("Memory search scopes");
  const scopes = [
    ["none", {}],
    ["user", buildMemorySearchScopeFields("user", ctx)],
    ["namespace", buildMemorySearchScopeFields("namespace", ctx)],
  ];
  for (const [label, scope] of scopes) {
    try {
      const response = await client.memory.search({
        query: "projects and initiatives",
        ...scope,
        max_memories: 5,
        max_nodes: 12,
        enable_agentic_graph: true,
      });
      const root = response;
      const memories = root.data?.memories ?? root.memories ?? [];
      const nodes = root.data?.nodes ?? root.nodes ?? [];
      console.log(
        `${label}: OK memories=${memories.length} nodes=${nodes.length}`,
      );
    } catch (error) {
      const err = error;
      console.log(`${label}: ${err.status ?? "ERR"} ${(err.message ?? String(error)).slice(0, 100)}`);
    }
  }

  section("Wiki home fetch");
  try {
    const { fetchWikiHome } = await import(
      "../dist/gateway/services/KnowledgeGraphWikiService.js"
    );
    const home = await fetchWikiHome();
    console.log("configured:", home.configured);
    console.log("rails:", home.rails.length);
    console.log("error:", home.error ?? "(none)");
    for (const rail of home.rails.slice(0, 6)) {
      console.log(`  - ${rail.title}: ${rail.items.length} items`);
    }
  } catch (error) {
    console.log("fetchWikiHome failed:", error);
  }

  section("Notes");
  console.log(
    "- JWKS 401 usually means Bearer/JWT auth failed on the memory server, not X-API-Key.",
  );
  console.log(
    "- Search rail 404 = no graph nodes for that query/scope (often empty namespace or user scope).",
  );
  console.log(
    "- Wiki prefers local ~/…/workspace/entities; if missing, it falls back to remote GraphQL/search.",
  );
  console.log(
    "- Restart gateway after code changes: npm run build:gateway && restart app.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
