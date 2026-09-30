#!/usr/bin/env node
/**
 * Validate schema-first graph read + local entity directory discovery.
 *
 * Usage:
 *   npm run test:memory-graph-read
 *   PAPR_API_KEY=sk-... node scripts/validate-memory-graph-read.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Papr from "@papr/memory";
import { resolveMemoryAccess } from "./lib/testEnv.mjs";
import { listSchemasForGraphRead, buildGraphReadOrderNote } from "../src/core/utils/memoryGraphSchemaRead.ts";
import { resolveEntityDirConfig } from "../src/gateway/services/KnowledgeGraphWikiService.ts";

const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    types {
      name
      kind
      fields { name }
    }
  }
}`;

function resolveEntitiesDir() {
  const paprHome = process.env.PAPR_HOME?.trim() || join(homedir(), "Papr");
  const activeWorkspace = join(paprHome, ".active-workspace.json");
  if (existsSync(activeWorkspace)) {
    try {
      const raw = JSON.parse(readFileSync(activeWorkspace, "utf8"));
      if (raw?.workspacePath && existsSync(join(raw.workspacePath, "entities"))) {
        return join(raw.workspacePath, "entities");
      }
    } catch {
      /* fall through */
    }
  }
  return join(paprHome, "workspace", "entities");
}

function scanLocalEntityDirs(entitiesDir) {
  if (!existsSync(entitiesDir)) {
    return { entitiesDir, dirs: [], filesByDir: {} };
  }

  const dirs = [];
  const filesByDir = {};

  for (const entry of readdirSync(entitiesDir)) {
    const full = join(entitiesDir, entry);
    if (!statSync(full).isDirectory()) continue;
    dirs.push(entry);
    const mdFiles = readdirSync(full).filter((f) => f.endsWith(".md"));
    filesByDir[entry] = mdFiles.length;
  }

  return { entitiesDir, dirs, filesByDir };
}

async function main() {
  console.log("=== Memory graph read + entity UI validation ===\n");

  // 1. Local entity directory scan
  const entitiesDir = resolveEntitiesDir();
  const local = scanLocalEntityDirs(entitiesDir);
  console.log(`Local entities dir: ${local.entitiesDir}`);
  if (local.dirs.length === 0) {
    console.log("  (no entity subdirectories yet — Wiki Writer creates these)\n");
  } else {
    for (const dir of local.dirs.sort()) {
      const cfg = resolveEntityDirConfig(dir);
      const count = local.filesByDir[dir] ?? 0;
      console.log(
        `  ${dir}/ → rail "${cfg.railTitle}" (${cfg.singular}), ${count} .md file(s)`,
      );
    }
    console.log("");
  }

  // 2. Live Papr API (schema read order + introspection)
  const access = await resolveMemoryAccess();
  if (!access) {
    console.log("⚠️  Skipping live API tests — no PAPR_API_KEY and gateway not reachable");
    console.log("   Set PAPR_API_KEY in .env.local or run Papr Work with gateway on :18789\n");
    process.exit(0);
  }

  if (access.mode === "gateway") {
    console.log(`Live API via gateway: ${access.gatewayBase} (${access.source})\n`);
    console.log("⚠️  Schema read utility requires direct Papr client — use PAPR_API_KEY for full live test");
    process.exit(0);
  }

  console.log(`Live API: ${access.memoryBase} (${access.source})\n`);

  const client = new Papr({
    xAPIKey: access.apiKey,
    maxRetries: 1,
    timeout: 30_000,
  });

  let passed = 0;
  let failed = 0;

  function ok(label, detail = "") {
    passed++;
    console.log(`✅ ${label}${detail ? ` — ${detail}` : ""}`);
  }

  function fail(label, detail = "") {
    failed++;
    console.log(`❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }

  try {
    const schemas = await listSchemasForGraphRead(client);
    if (schemas.length === 0) {
      ok("listSchemasForGraphRead", "0 schemas (API error or none active — GraphQL still works)");
    } else {
      const primary = schemas.filter((s) => s.priority === "primary");
      const note = buildGraphReadOrderNote(schemas);
      ok(
        "listSchemasForGraphRead",
        `${schemas.length} schema(s), ${primary.length} primary (WorkspaceContext)`,
      );
      console.log("\nRead order note:");
      console.log(note.split("\n").map((l) => `  ${l}`).join("\n"));
      console.log("");

      for (const schema of schemas.slice(0, 5)) {
        console.log(
          `  • ${schema.priority === "primary" ? "★" : "○"} ${schema.name} (${schema.id}) — ${schema.nodeTypeNames.length} node type(s), ${schema.relationshipCount} relationship(s)`,
        );
        if (schema.nodeTypeNames.length > 0) {
          console.log(`      types: ${schema.nodeTypeNames.join(", ")}`);
        }
      }
      console.log("");
    }
  } catch (error) {
    fail("listSchemasForGraphRead", error instanceof Error ? error.message : String(error));
  }

  try {
    const intro = await client.graphql.query({ body: { query: INTROSPECTION_QUERY } });
    const types = intro.data?.__schema?.types?.filter(
      (t) =>
        t.kind === "OBJECT" &&
        !t.name.startsWith("__") &&
        t.fields?.some((f) => f.name === "id"),
    );
    ok("GraphQL introspection", `${types?.length ?? 0} queryable object types`);

    for (const q of [
      "{ people(limit: 5) { id name } }",
      "{ companies(limit: 5) { id name } }",
      "{ projects(limit: 5) { id name } }",
    ]) {
      const label = q.match(/\{\s*(\w+)/)?.[1] ?? "query";
      try {
        const res = await client.graphql.query({ body: { query: q } });
        if (res.errors?.length) {
          fail(`${label} list query`, res.errors[0].message.slice(0, 80));
        } else {
          const rows = res.data?.[label]?.length ?? 0;
          ok(`${label} list query`, `${rows} row(s) returned`);
        }
      } catch (error) {
        fail(`${label} list query`, error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    fail("GraphQL introspection", error instanceof Error ? error.message : String(error));
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
