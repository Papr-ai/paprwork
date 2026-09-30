/**
 * Verify GetNamespaceWorkspace GraphQL (workspace-only, no Organization.workSpace).
 *   node_modules/.bin/electron scripts/verify-namespace-workspace-query.cjs [namespaceId]
 */
const fs = require("fs");
const path = require("path");
const electron = require("electron");

const { app, safeStorage } = electron;
app.setName("Papr Work");

const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL || "https://server.papr.ai/graphql";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

const namespaceId = process.argv[2] || "8Pu0Oc6pIh";
const expectedWorkspaceId = process.argv[3] || "NOxtJsAPHQ";

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
  if (!entry?.encryptedValue) {
    throw new Error("PAPR_SESSION_TOKEN not found");
  }
  return safeStorage.decryptString(Buffer.from(entry.encryptedValue, "base64"));
}

async function graphql(sessionToken, query, variables) {
  const response = await fetch(PARSE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Session-Token": sessionToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  return { status: response.status, json };
}

const BROKEN_QUERY = `
  query GetNamespaceWorkspace($namespaceId: ID!) {
    namespace(id: $namespaceId) {
      objectId
      organization {
        workspace { objectId }
        workSpace { objectId }
      }
    }
  }
`;

const FIXED_QUERY = `
  query GetNamespaceWorkspace($namespaceId: ID!) {
    namespace(id: $namespaceId) {
      objectId
      name
      organization {
        objectId
        name
        workspace { objectId workspace_name }
      }
    }
  }
`;

app.whenReady().then(async () => {
  const sessionToken = readSessionToken();
  console.log(`namespaceId=${namespaceId} sessionLen=${sessionToken.length}`);

  const broken = await graphql(sessionToken, BROKEN_QUERY, { namespaceId });
  console.log("\n--- broken query (with Organization.workSpace) ---");
  console.log(JSON.stringify(broken.json, null, 2));

  const fixed = await graphql(sessionToken, FIXED_QUERY, { namespaceId });
  console.log("\n--- fixed query (organization.workspace only) ---");
  console.log(JSON.stringify(fixed.json, null, 2));

  const workspaceId =
    fixed.json.data?.namespace?.organization?.workspace?.objectId;
  console.log(`\nresolved workspaceId: ${workspaceId ?? "(null)"}`);
  console.log(`expected workspaceId: ${expectedWorkspaceId}`);
  console.log(`match: ${workspaceId === expectedWorkspaceId}`);

  if (workspaceId) {
    const membersUrl = new URL("https://dashboard.papr.ai/api/workspace/members");
    membersUrl.searchParams.set("workspaceId", workspaceId);
    const membersRes = await fetch(membersUrl, {
      headers: { "X-Parse-Session-Token": sessionToken },
    });
    const membersBody = await membersRes.json();
    console.log(
      `\ndashboard /api/workspace/members: HTTP ${membersRes.status}, count=${membersBody.members?.length ?? 0}`,
    );
  }

  app.quit();
  process.exit(workspaceId ? 0 : 1);
});
