import fs from "fs";
import path from "path";
import electron from "electron";
import { createClient } from "@libsql/client";

const { app, safeStorage } = electron;
const base = (process.env.PAPR_MEMORY_SERVER_URL ?? "https://memory.papr.ai").replace(/\/$/, "");
const keysFile = "/Users/amirkabbara/Library/Application Support/Papr Work/data/orgs/YqiHlOHGqg/custom-keys.json";

async function getPaprApiKey() {
  await app.whenReady();
  const data = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const entry = data.keys?.find((k) => k.name === "PAPR_API_KEY");
  if (!entry) throw new Error("PAPR_API_KEY not found for YqiHlOHGqg");
  return safeStorage.decryptString(Buffer.from(entry.encryptedValue, "base64"));
}

async function post(route, apiKey, body) {
  const resp = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data, text };
}

const apiKey = await getPaprApiKey();
console.log("memory server:", base);
console.log("api key prefix:", apiKey.slice(0, 32) + "...");

const list = await post("/v1/cloud/databases/list", apiKey, {});
console.log("\n=== DATABASE LIST ===");
console.log("status:", list.status);
if (list.status !== 200) {
  console.log(list.text.slice(0, 500));
  app.quit();
  process.exit(1);
}

const dbs = list.data?.databases ?? [];
console.log("total databases:", dbs.length);
console.log("first 10:", dbs.slice(0, 10).map((d) => d.name ?? d).join(", "));

const tok = await post("/v1/cloud/databases/token", apiKey, { database: "d-8e5c9ee5" });
console.log("\n=== TOKEN d-8e5c9ee5 (sqa) ===");
console.log("status:", tok.status);
if (tok.status !== 200) {
  console.log(tok.text.slice(0, 400));
} else {
  const client = createClient({ url: tok.data.tursoUrl, authToken: tok.data.authToken });
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' ORDER BY name",
  );
  const names = tables.rows.map((r) => String(r.name));
  console.log("remote tables:", names.length);
  const localOnly = ["assessment_scores", "cycles"];
  for (const t of localOnly) console.log(`  ${t} on remote:`, names.includes(t));
  try {
    await client.execute("CREATE TABLE IF NOT EXISTS _papr_write_probe (id INTEGER PRIMARY KEY)");
    console.log("WRITE TEST: OK");
  } catch (e) {
    console.log("WRITE TEST FAILED:", e.message);
  }
  await client.close();
}

const tok2 = await post("/v1/cloud/databases/token", apiKey, { database: "j-2cafb2e9" });
console.log("\n=== TOKEN j-2cafb2e9 (daily brief) ===");
if (tok2.status === 200) {
  const client = createClient({ url: tok2.data.tursoUrl, authToken: tok2.data.authToken });
  try {
    await client.execute("CREATE TABLE IF NOT EXISTS _papr_write_probe (id INTEGER PRIMARY KEY)");
    console.log("WRITE TEST: OK");
  } catch (e) {
    console.log("WRITE TEST FAILED:", e.message);
  }
  await client.close();
} else {
  console.log("token failed:", tok2.text.slice(0, 300));
}

app.quit();
