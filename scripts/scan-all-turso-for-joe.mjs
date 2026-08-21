#!/usr/bin/env node
/**
 * Scan all Turso DBs in namespace for Joe Coffee tables (benchmarks, shops).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import electron from "electron";
import { resolvePaprApiKeyFromKeychain } from "./lib/resolvePaprApiKeyFromKeychain.mjs";

const JOE_TABLES = ["benchmarks", "shops", "social_posts", "weekly_briefs"];
const JOE_PREFIX = "src_744f60d6";

async function main() {
  for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }

  process.env.PAPR_ORG_ID = "Y8D4H7Yp3Z";
  process.env.PAPR_NAMESPACE_ID = "85ZIB7mD1V";
  process.env.PAPR_MEMORY_SERVER_URL = "https://memory.papr.ai";

  const apiKey = await resolvePaprApiKeyFromKeychain();
  await electron.app.quit();

  const res = await fetch("https://memory.papr.ai/v1/cloud/databases/list", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ external_user_id: "WkPutXGdqg" }),
  });
  const data = await res.json();
  const dbs = data.databases ?? [];
  console.log(`Scanning ${dbs.length} Turso databases for Joe Coffee data...\n`);

  const hits = [];

  for (const db of dbs) {
    const name = db.name ?? "";
    const url = db.tursoUrl;
    if (!url || !db.authToken) continue;

    const client = createClient({ url, authToken: db.authToken });
    try {
      const tablesRes = await client.execute(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `);
      const tables = tablesRes.rows.map((r) => String(r.name));

      let joeScore = 0;
      for (const t of JOE_TABLES) {
        if (tables.includes(t)) joeScore += 10;
      }
      const prefixed = tables.filter((t) => t.includes(JOE_PREFIX) || t.startsWith("src_744f60d6"));
      if (prefixed.length > 0) joeScore += 5;

      if (joeScore > 0 || tables.length >= 15) {
        let benchmarkCount = null;
        if (tables.includes("benchmarks")) {
          const c = await client.execute("SELECT COUNT(*) AS c FROM benchmarks");
          benchmarkCount = Number(c.rows[0]?.c ?? 0);
        }
        hits.push({
          name,
          url,
          tableCount: tables.length,
          joeScore,
          benchmarkCount,
          sampleTables: tables.filter((t) => !t.startsWith("_papr")).slice(0, 8),
          prefixed: prefixed.slice(0, 3),
        });
      }
    } catch (err) {
      /* skip unreadable */
    } finally {
      client.close();
    }
  }

  hits.sort((a, b) => b.joeScore - a.joeScore || b.tableCount - a.tableCount);

  if (hits.length === 0) {
    console.log("NO databases found with Joe tables or 15+ user tables.");
  } else {
    for (const h of hits) {
      console.log("=".repeat(72));
      console.log(`DB: ${h.name}`);
      console.log(`URL: ${h.url}`);
      console.log(`tables: ${h.tableCount}, joeScore: ${h.joeScore}`);
      if (h.benchmarkCount !== null) console.log(`benchmarks rows: ${h.benchmarkCount}`);
      console.log(`sample: ${h.sampleTables.join(", ")}`);
      if (h.prefixed.length) console.log(`prefixed: ${h.prefixed.join(", ")}`);
    }
  }

  // Also scan legacy 'data' db on both user segments
  console.log("\n" + "=".repeat(72));
  console.log("Legacy `data` DB scan:");
  for (const uid of [undefined, "WkPutXGdqg"]) {
    const label = uid ?? "api-key-user";
    const tokRes = await fetch("https://memory.papr.ai/v1/cloud/databases/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ database: "data", ...(uid ? { external_user_id: uid } : {}) }),
    });
    if (tokRes.status !== 200) {
      console.log(`  ${label}: token failed ${tokRes.status}`);
      continue;
    }
    const tok = await tokRes.json();
    const client = createClient({ url: tok.tursoUrl, authToken: tok.authToken });
    const tablesRes = await client.execute(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `);
    const tables = tablesRes.rows.map((r) => String(r.name));
    const joePrefixed = tables.filter((t) => t.includes("744f60d6") || t.includes("0ff146f4"));
    console.log(`  ${label}: ${tables.length} tables, joe-related: ${joePrefixed.length}`);
    if (joePrefixed.length) console.log(`    ${joePrefixed.slice(0, 5).join(", ")}`);
    client.close();
  }
}

main().catch(console.error);
