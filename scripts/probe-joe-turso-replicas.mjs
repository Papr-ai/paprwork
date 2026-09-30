#!/usr/bin/env node
/**
 * Compare Turso replicas for Joe Coffee: web runtime path vs desktop sync path.
 *
 * Usage:
 *   npm run probe:joe-turso
 *   node scripts/probe-joe-turso-replicas.mjs --api-key=sk-org-...
 *
 * Env (.env.local): PAPR_CLOUD_APP_HOST_KEY, optional PAPR_API_KEY
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const JOE = {
  namespaceId: "85ZIB7mD1V",
  slug: "joe-coffee-intelligence",
  database: "d-0ff146f4",
  shareToken: "y6fBNxGQyTW0WvU-cmCs9Gzunxehi6Yu68Bo5ogETe4",
  ownerUserId: "WkPutXGdqg",
};

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

function parseArgs() {
  const apiKeyArg = process.argv
    .slice(2)
    .find((a) => a.startsWith("--api-key="))
    ?.slice("--api-key=".length);
  if (apiKeyArg) process.env.PAPR_API_KEY = apiKeyArg;
}

function userSegmentFromTursoUrl(tursoUrl) {
  try {
    const host = new URL(tursoUrl).hostname;
    const match = host.match(/^p-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)-/i);
    if (!match) return { host, org8: null, ns8: null, user8: null };
    return {
      host,
      org8: match[1],
      ns8: match[2],
      user8: match[3],
    };
  } catch {
    return { host: tursoUrl, org8: null, ns8: null, user8: null };
  }
}

async function fetchJson(url, opts) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: resp.status, data, text };
}

async function inspectTurso(label, tursoUrl, authToken) {
  const segment = userSegmentFromTursoUrl(tursoUrl);
  const client = createClient({ url: tursoUrl, authToken });
  try {
    const tablesRes = await client.execute(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    const tables = tablesRes.rows.map((r) => String(r.name));
    const userTables = tables.filter(
      (t) => !t.startsWith("_papr_") && t !== "_papr_sync_log",
    );

    let migrationIds = [];
    if (tables.includes("_papr_schema_migrations")) {
      const migRes = await client.execute(
        "SELECT id FROM _papr_schema_migrations ORDER BY id",
      );
      migrationIds = migRes.rows.map((r) => String(r.id));
    }

    let benchmarkCount = null;
    if (tables.includes("benchmarks")) {
      const countRes = await client.execute("SELECT COUNT(*) AS c FROM benchmarks");
      benchmarkCount = Number(countRes.rows[0]?.c ?? 0);
    }

    return {
      label,
      ok: true,
      tursoUrl,
      segment,
      tableCount: tables.length,
      userTableCount: userTables.length,
      tables: userTables.slice(0, 25),
      tablesTruncated: userTables.length > 25,
      migrationIds,
      benchmarkCount,
    };
  } catch (err) {
    return {
      label,
      ok: false,
      tursoUrl,
      segment,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client.close();
  }
}

async function tryRuntimeDbToken(base, hostKey, variant) {
  const headers = {
    "Content-Type": "application/json",
    "X-Cloud-App-Host-Key": hostKey,
  };
  if (variant.apiKey) headers["X-API-Key"] = variant.apiKey;

  const body = {
    namespaceId: JOE.namespaceId,
    slug: JOE.slug,
    database: variant.database ?? JOE.database,
  };
  if (variant.shareToken) body.shareToken = variant.shareToken;
  if (variant.apiKey) body.paprApiKey = variant.apiKey;
  if (variant.externalUserId) body.external_user_id = variant.externalUserId;

  const res = await fetchJson(`${base}/v1/cloud/apps/runtime/db-token`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return { variant: variant.label, ...res };
}

async function tryDesktopDbToken(base, apiKey, variant) {
  const body = { database: variant.database ?? JOE.database };
  if (variant.externalUserId) body.external_user_id = variant.externalUserId;

  const res = await fetchJson(`${base}/v1/cloud/databases/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

  return { variant: variant.label, ...res };
}

function printProbeResult(tokenResult) {
  console.log(`\n--- ${tokenResult.variant} ---`);
  if (tokenResult.status !== 200) {
    console.log(`  TOKEN FAILED: HTTP ${tokenResult.status}`);
    console.log(`  ${String(tokenResult.text).slice(0, 300)}`);
    return null;
  }
  const { tursoUrl, authToken } = tokenResult.data;
  console.log(`  tursoUrl: ${tursoUrl}`);
  const seg = userSegmentFromTursoUrl(tursoUrl);
  console.log(
    `  segment: org=${seg.org8 ?? "?"} ns=${seg.ns8 ?? "?"} user=${seg.user8 ?? "?"}`,
  );
  return { tursoUrl, authToken };
}

async function main() {
  loadEnvLocal();
  parseArgs();

  const base = (
    process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai"
  ).replace(/\/$/, "");
  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
  const apiKey = process.env.PAPR_API_KEY?.trim();

  console.log("Joe Coffee Turso replica probe");
  console.log("=".repeat(72));
  console.log(`Memory: ${base}`);
  console.log(`App: ${JOE.namespaceId}/${JOE.slug}`);
  console.log(`Database short name: ${JOE.database}`);
  console.log(`Owner user id: ${JOE.ownerUserId}`);

  if (!hostKey) {
    console.error("\nMissing PAPR_CLOUD_APP_HOST_KEY (set in .env.local)");
    process.exit(1);
  }

  if (apiKey) {
    console.log("\n### access/validate (owner API key)");
    const validate = await fetchJson(`${base}/v1/cloud/apps/access/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        namespaceId: JOE.namespaceId,
        slug: JOE.slug,
        shareToken: JOE.shareToken,
      }),
    });
    console.log(`  status: ${validate.status}`);
    if (validate.status === 200) {
      console.log(`  userId (runtime owner): ${validate.data.userId ?? "?"}`);
      console.log(`  appId: ${validate.data.appId ?? "?"}`);
      console.log(`  mode: ${validate.data.mode ?? "?"}`);
      console.log(`  canRead/canWrite: ${validate.data.canRead}/${validate.data.canWrite}`);
    } else {
      console.log(`  ${String(validate.text).slice(0, 300)}`);
    }

    console.log("\n### databases/list (desktop catalog)");
    const list = await fetchJson(`${base}/v1/cloud/databases/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ external_user_id: JOE.ownerUserId }),
    });
    console.log(`  status: ${list.status}`);
    if (list.status === 200 && Array.isArray(list.data?.databases)) {
      const joeDb = list.data.databases.filter(
        (d) =>
          d.name === JOE.database ||
          d.name?.includes("0ff146f4") ||
          d.tursoUrl?.includes("0ff146f4"),
      );
      console.log(`  total databases: ${list.data.databases.length}`);
      for (const d of joeDb.length > 0 ? joeDb : list.data.databases.slice(0, 8)) {
        console.log(`  - ${d.name}: ${d.tursoUrl ?? "(no url)"}`);
      }
      if (joeDb.length === 0 && list.data.databases.length > 8) {
        console.log("  (Joe db not in first 8 — search by name failed)");
      }
    } else {
      console.log(`  ${String(list.text).slice(0, 300)}`);
    }
  }

  const runtimeVariants = [
    {
      label: "WEB: runtime/db-token + share token only (anonymous visitor)",
      shareToken: JOE.shareToken,
    },
    {
      label: "WEB: runtime/db-token + owner API key",
      apiKey,
    },
    {
      label: "WEB: runtime/db-token + API key + external_user_id=owner",
      apiKey,
      externalUserId: JOE.ownerUserId,
    },
    {
      label: "WEB: runtime/db-token + share token + external_user_id=owner",
      shareToken: JOE.shareToken,
      externalUserId: JOE.ownerUserId,
    },
    {
      label: "WEB: runtime/db-token + API key + database=legacy data",
      apiKey,
      database: "data",
    },
  ];

  const desktopVariants = apiKey
    ? [
        {
          label: "DESKTOP: databases/token + API key (no acting user)",
        },
        {
          label: "DESKTOP: databases/token + API key + external_user_id=owner",
          externalUserId: JOE.ownerUserId,
        },
        {
          label: "DESKTOP: databases/token + API key + external_user_id=logged-in (from env)",
          externalUserId: process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID?.trim(),
        },
        {
          label: "DESKTOP: databases/token + API key + database=legacy data",
          database: "data",
        },
      ].filter((v) => !v.externalUserId || v.externalUserId.length > 0)
    : [];

  const credsByUrl = new Map();

  console.log("\n### Token probes (web runtime path)");
  for (const variant of runtimeVariants) {
    if (variant.apiKey && !apiKey) {
      console.log(`\n--- ${variant.label} ---`);
      console.log("  SKIP: no PAPR_API_KEY");
      continue;
    }
    const result = await tryRuntimeDbToken(base, hostKey, variant);
    const creds = printProbeResult(result);
    if (creds) {
      credsByUrl.set(creds.tursoUrl, {
        ...creds,
        source: variant.label,
      });
    }
  }

  if (desktopVariants.length > 0) {
    console.log("\n### Token probes (desktop sync path)");
    for (const variant of desktopVariants) {
      const result = await tryDesktopDbToken(base, apiKey, variant);
      const creds = printProbeResult(result);
      if (creds) {
        if (!credsByUrl.has(creds.tursoUrl)) {
          credsByUrl.set(creds.tursoUrl, {
            ...creds,
            source: variant.label,
          });
        }
      }
    }
  } else {
    console.log("\n### Desktop path skipped (no PAPR_API_KEY)");
  }

  if (credsByUrl.size === 0) {
    console.error("\nNo successful Turso tokens — cannot inspect replicas.");
    process.exit(1);
  }

  console.log("\n### Turso inspection (unique hostnames)");
  console.log(`Found ${credsByUrl.size} distinct replica(s)`);

  const inspections = [];
  for (const [url, meta] of credsByUrl) {
    const inspection = await inspectTurso(meta.source, url, meta.authToken);
    inspections.push(inspection);
  }

  for (const row of inspections) {
    console.log("\n" + "=".repeat(72));
    console.log(row.label);
    if (!row.ok) {
      console.log(`  QUERY FAILED: ${row.error}`);
      continue;
    }
    console.log(`  user segment: ${row.segment.user8 ?? "?"}`);
    console.log(`  tables: ${row.tableCount} total, ${row.userTableCount} user tables`);
    if (row.migrationIds.length > 0) {
      console.log(`  ledger: ${row.migrationIds.join(", ")}`);
    } else {
      console.log("  ledger: (none or table missing)");
    }
    if (row.benchmarkCount !== null) {
      console.log(`  benchmarks rows: ${row.benchmarkCount}`);
    }
    console.log(`  user tables: ${row.tables.join(", ")}${row.tablesTruncated ? ", …" : ""}`);
  }

  const best = inspections
    .filter((r) => r.ok)
    .sort((a, b) => b.userTableCount - a.userTableCount)[0];

  console.log("\n" + "=".repeat(72));
  console.log("SUMMARY");
  if (best) {
    console.log(
      `Richest replica: ${best.userTableCount} user tables (segment ${best.segment.user8 ?? "?"})`,
    );
    console.log(`Source path: ${best.label.split("\n")[0]}`);
    console.log(`URL: ${best.tursoUrl}`);
  }

  const localPath =
    process.env.PAPR_HOME?.trim() ??
    "/Users/amirkabbara/Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V";
  const localDb = join(
    localPath,
    "data/databases/joe-coffee-intelligence/data.db",
  );
  console.log(`\nLocal SQLite (reference): ${localDb}`);
  try {
    const { execSync } = await import("node:child_process");
    const count = execSync(
      `sqlite3 ${JSON.stringify(localDb)} "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_papr_%';"`,
      { encoding: "utf8" },
    ).trim();
    console.log(`  local user table count: ${count}`);
  } catch (err) {
    console.log(`  (could not read local db: ${err.message})`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
