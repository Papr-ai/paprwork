#!/usr/bin/env node
/**
 * Probe why resolveWorkspaceIdForNamespace fails for a namespace.
 * Usage: node scripts/probe-namespace-workspace-resolve.mjs [--org=YqiHlOHGqg] [--namespace=8Pu0Oc6pIh]
 */
import fs from "node:fs";
import path from "node:path";
import electron from "electron";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);

const orgId = args.org ?? "YqiHlOHGqg";
const namespaceId = args.namespace ?? "8Pu0Oc6pIh";
const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL ?? "https://server.papr.ai/graphql";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID ?? "671e705a-f735-4ec0-8474-15899a475440";

async function getSessionToken() {
  await electron.app.whenReady();
  const userData =
    process.env.PAPR_USER_DATA?.trim() ??
    path.join(process.env.HOME ?? "", "Library/Application Support/Papr Work");
  const candidates = [
    path.join(userData, "data", "custom-keys.global.json"),
    path.join(userData, "data", "orgs", orgId, "custom-keys.json"),
  ];
  for (const keysFile of candidates) {
    if (!fs.existsSync(keysFile)) continue;
    const data = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    for (const entry of Object.values(data)) {
      if (entry?.name === "PAPR_SESSION_TOKEN" && entry?.encryptedValue) {
        return electron.safeStorage.decryptString(
          Buffer.from(entry.encryptedValue, "base64"),
        );
      }
    }
  }
  throw new Error(`PAPR_SESSION_TOKEN not found (org ${orgId})`);
}

const QUERIES = {
  current: `
    query GetNamespaceWorkspace($namespaceId: ID!) {
      namespace(id: $namespaceId) {
        objectId
        organization {
          workspace { objectId }
          workSpace { objectId }
        }
      }
    }
  `,
  orgOnly: `
    query GetNamespaceOrg($namespaceId: ID!) {
      namespace(id: $namespaceId) {
        objectId
        name
        organization {
          objectId
          name
          workspace { objectId }
          workSpace { objectId }
        }
      }
    }
  `,
  orgsWhereNamespace: `
    query OrgsForNamespace($namespaceId: ID!) {
      organizations(
        where: {
          default_namespace: { have: { objectId: { equalTo: $namespaceId } } }
        }
      ) {
        edges {
          node {
            objectId
            name
            workspace { objectId }
            workSpace { objectId }
          }
        }
      }
    }
  `,
  workspaceFromOrg: `
    query GetOrg($orgId: ID!) {
      organization(id: $orgId) {
        objectId
        name
        workspace { objectId }
        workSpace { objectId }
        default_namespace { objectId name }
      }
    }
  `,
};

async function runGraphQL(sessionToken, name, query, variables) {
  const res = await fetch(PARSE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  console.log(`\n=== ${name} (HTTP ${res.status}) ===`);
  console.log(JSON.stringify(json, null, 2));
  return json;
}

async function main() {
  const sessionToken = await getSessionToken();
  console.log(`org=${orgId} namespace=${namespaceId}`);
  console.log(`session token length=${sessionToken.length}`);

  for (const [name, query] of Object.entries(QUERIES)) {
    const vars =
      name === "workspaceFromOrg"
        ? { orgId }
        : { namespaceId };
    await runGraphQL(sessionToken, name, query, vars);
  }

  const membersUrl = new URL("https://dashboard.papr.ai/api/workspace/members");
  membersUrl.searchParams.set("workspaceId", "NOxtJsAPHQ");
  const membersRes = await fetch(membersUrl, {
    headers: { "X-Parse-Session-Token": sessionToken },
  });
  console.log(`\n=== dashboard members for NOxtJsAPHQ (HTTP ${membersRes.status}) ===`);
  console.log((await membersRes.text()).slice(0, 500));

  await electron.app.quit();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await electron.app.quit();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
