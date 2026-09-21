/**
 * Resolve Amplitude organization_id values to Parse Organization names and
 * owner display names (read-only, internal analytics support).
 *
 *   node_modules/.bin/electron scripts/lookup-orgs-by-id.cjs ORGID [ORGID...]
 */

const fs = require("fs");
const path = require("path");
const electron = require("electron");

const { app, safeStorage } = electron;
app.setName("Papr Work");

const PARSE_SERVER_URL =
  process.env.PARSE_SERVER_URL || "https://server.papr.ai/parse";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

const ORG_IDS = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function readSessionToken() {
  const keysFile = path.join(
    app.getPath("userData"),
    "data",
    "custom-keys.global.json",
  );
  const store = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const entry = Object.values(store).find(
    (k) => k && k.name === "PAPR_SESSION_TOKEN",
  );
  if (!entry?.encryptedValue) throw new Error("PAPR_SESSION_TOKEN not found");
  return safeStorage.decryptString(Buffer.from(entry.encryptedValue, "base64"));
}

async function restGet(sessionToken, urlPath, params) {
  const url = new URL(`${PARSE_SERVER_URL}${urlPath}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: {
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Parse REST ${response.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function main() {
  await app.whenReady();
  const sessionToken = readSessionToken();

  const orgs = await restGet(sessionToken, "/classes/Organization", {
    where: JSON.stringify({ objectId: { $in: ORG_IDS } }),
    keys: "objectId,name,plan_tier,owner_user_id,createdAt,workspace",
    limit: "200",
  });

  const byId = new Map(orgs.results.map((o) => [o.objectId, o]));
  const ownerIds = [
    ...new Set(orgs.results.map((o) => o.owner_user_id).filter(Boolean)),
  ];

  let users = { results: [] };
  if (ownerIds.length) {
    try {
      users = await restGet(sessionToken, "/classes/_User", {
        where: JSON.stringify({ objectId: { $in: ownerIds } }),
        keys: "objectId,username,name,firstName,lastName,email,createdAt",
        limit: "200",
      });
    } catch (error) {
      console.error(`  [warn] _User lookup failed: ${error.message}`);
    }
  }
  const userById = new Map(users.results.map((u) => [u.objectId, u]));

  console.log(JSON.stringify({ requested: ORG_IDS.length, found: orgs.results.length }));
  for (const id of ORG_IDS) {
    const org = byId.get(id);
    if (!org) {
      console.log(`${id}\tNOT_VISIBLE\t-\t-\t-`);
      continue;
    }
    const owner = userById.get(org.owner_user_id);
    const ownerLabel = owner
      ? `${owner.name || [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.username || "?"} <${owner.email ?? "no-email"}>`
      : (org.owner_user_id ?? "-");
    console.log(
      `${id}\t${org.name ?? "-"}\t${org.plan_tier ?? "-"}\t${ownerLabel}\t${org.createdAt}`,
    );
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
