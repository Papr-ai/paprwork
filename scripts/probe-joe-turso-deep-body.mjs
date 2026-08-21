#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

function loadEnvLocal() {
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

async function dbToken(base, apiKey, database, externalUserId) {
  const body = { database };
  if (externalUserId) body.external_user_id = externalUserId;
  const res = await fetch(`${base}/v1/cloud/databases/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== 200) {
    console.log(
      `token ${database} (${externalUserId ?? "api-key-user"}) → ${res.status} ${text.slice(0, 160)}`,
    );
    return null;
  }
  return JSON.parse(text);
}

async function main() {
  loadEnvLocal();
  const apiKey = process.env.PAPR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("PAPR_API_KEY required");
  }
  const base = "https://memory.papr.ai";
  const share = "y6fBNxGQyTW0WvU-cmCs9Gzunxehi6Yu68Bo5ogETe4";
  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();

  for (const [label, uid] of [
    ["mkcnhhg5 (catalog default)", undefined],
    ["wkputxgd (owner WkPutXGdqg)", "WkPutXGdqg"],
  ]) {
    console.log("\n=== Deep inspect:", label, "===");
    const creds = await dbToken(base, apiKey, "d-0ff146f4", uid);
    if (!creds) continue;
    console.log("URL:", creds.tursoUrl);
    const client = createClient({
      url: creds.tursoUrl,
      authToken: creds.authToken,
    });
    const objects = await client.execute(
      "SELECT name, type FROM sqlite_master ORDER BY name",
    );
    console.log("sqlite_master:");
    for (const row of objects.rows) {
      console.log(`  ${row.type}: ${row.name}`);
    }
    if (objects.rows.some((r) => r.name === "_papr_schema_migrations")) {
      const ledger = await client.execute("SELECT * FROM _papr_schema_migrations");
      console.log("ledger rows:", ledger.rows.length, ledger.rows);
    }
    for (const table of [
      "benchmarks",
      "shops",
      "social_posts",
      "schema_migrations",
    ]) {
      try {
        const c = await client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
        console.log(`${table}: ${c.rows[0]?.c} rows`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`${table}: missing (${msg.split("\n")[0]})`);
      }
    }
    client.close();
  }

  if (hostKey) {
    console.log("\n=== runtime/db-token (host key + api key) ===");
    const res = await fetch(`${base}/v1/cloud/apps/runtime/db-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cloud-App-Host-Key": hostKey,
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        namespaceId: "85ZIB7mD1V",
        slug: "joe-coffee-intelligence",
        database: "d-0ff146f4",
        paprApiKey: apiKey,
      }),
    });
    console.log("status:", res.status, (await res.text()).slice(0, 300));
  }

  console.log("\n=== Live apps.papr.ai /api/db/query ===");
  const liveUrl =
    "https://apps.papr.ai/85ZIB7mD1V/joe-coffee-intelligence/api/db/query";
  const liveRes = await fetch(liveUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Papr-Share-Token": share,
    },
    body: JSON.stringify({
      sourceId: "joe",
      sql: "SELECT COUNT(*) AS c FROM benchmarks",
    }),
  });
  console.log("status:", liveRes.status);
  console.log("body:", (await liveRes.text()).slice(0, 500));

  console.log("\n=== GET publish config ===");
  const pubRes = await fetch(
    `${base}/v1/cloud/apps/publish/config?namespaceId=85ZIB7mD1V&slug=joe-coffee-intelligence`,
    { headers: { "X-API-Key": apiKey } },
  );
  console.log("status:", pubRes.status);
  console.log("body:", (await pubRes.text()).slice(0, 800));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
