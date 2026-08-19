/**
 * Read one WorkSpace and its claiming Organizations through the Parse REST API.
 *
 * A cross-check for the GraphQL reads: REST returns the stored pointer verbatim
 * with no resolver in between, so if REST and GraphQL agree the value really is
 * what is on the server rather than an artefact of how the query was written.
 *
 *   node_modules/.bin/electron scripts/verify-papr-rest-pointer.cjs [workspaceId]
 *
 * Contains no mutations.
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

const WORKSPACE_ID =
  process.argv.slice(2).find((a) => !a.startsWith("--")) || "qDgAdi2eMf";

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
    throw new Error(`Parse REST ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function main() {
  await app.whenReady();
  const sessionToken = readSessionToken();

  console.log(`REST: ${PARSE_SERVER_URL}\n`);

  const ws = await restGet(sessionToken, `/classes/WorkSpace/${WORKSPACE_ID}`, {
    keys: "objectId,workspace_name,workspace_url,memberCount,archive,organization,updatedAt",
  });
  console.log(`WorkSpace ${ws.objectId} (${ws.workspace_url})`);
  console.log(`  memberCount   : ${ws.memberCount}`);
  console.log(`  archive       : ${ws.archive}`);
  console.log(`  organization  : ${JSON.stringify(ws.organization)}`);
  console.log(`  updatedAt     : ${ws.updatedAt}`);

  const orgs = await restGet(sessionToken, "/classes/Organization", {
    where: JSON.stringify({
      workspace: {
        __type: "Pointer",
        className: "WorkSpace",
        objectId: WORKSPACE_ID,
      },
    }),
    keys: "objectId,name,plan_tier,owner,owner_user_id,default_namespace,default_namespace_id,workspace,createdAt,updatedAt",
    order: "-createdAt",
    limit: "50",
  });

  console.log(
    `\nOrganizations whose workspace pointer == ${WORKSPACE_ID}: ${orgs.results.length}`,
  );
  for (const org of orgs.results) {
    console.log(
      `  ${org.objectId}  name=${JSON.stringify(org.name).padEnd(24)} ` +
        `tier=${String(org.plan_tier).padEnd(11)} owner=${String(org.owner_user_id)}`,
    );
    console.log(
      `      default_namespace=${org.default_namespace?.objectId ?? org.default_namespace_id ?? "-"}  ` +
        `created=${org.createdAt}  updated=${org.updatedAt}`,
    );
  }

  console.log("\nSampling updatedAt twice, 3s apart, to detect live writes:");
  for (let i = 0; i < 2; i++) {
    const again = await restGet(
      sessionToken,
      `/classes/WorkSpace/${WORKSPACE_ID}`,
      { keys: "objectId,organization,updatedAt" },
    );
    console.log(
      `  t${i}: updatedAt=${again.updatedAt}  organization=${again.organization?.objectId}`,
    );
    if (i === 0) await new Promise((r) => setTimeout(r, 3000));
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error("\nFAILED:", error.message);
    app.exit(1);
  });
