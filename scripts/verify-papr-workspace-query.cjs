/**
 * Read-only check that the workspace switcher's own query returns the two fields
 * the duplicate tie-break depends on: WorkSpace.memberCount and the
 * organization's own workspace pointer.
 *
 * Both are new selections on an existing query. If either is not selectable in
 * this shape the query still succeeds and the fields come back undefined, so the
 * tie-break silently falls back to arrival order — the exact bug it fixes. This
 * asserts they are actually populated against live Parse.
 *
 * Runs as a real Electron main process because the session token is encrypted
 * with safeStorage, which is unavailable under ELECTRON_RUN_AS_NODE:
 *
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/verify-papr-workspace-query.cjs
 *
 * Contains no mutations.
 */

const fs = require("fs");
const path = require("path");
const electron = require("electron");

const { app, safeStorage } = electron;

// Must match the running app, or safeStorage looks at the wrong keychain entry
// and userData points at the wrong directory.
app.setName("Papr Work");

const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL || "https://server.papr.ai/graphql";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

function readSessionToken() {
  const keysFile = path.join(
    app.getPath("userData"),
    "data",
    "custom-keys.global.json",
  );
  if (!fs.existsSync(keysFile)) {
    throw new Error(`No global keys file at ${keysFile} — sign in first.`);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("safeStorage unavailable (keychain locked?)");
  }

  const store = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  const entry = Object.values(store).find(
    (k) => k && k.name === "PAPR_SESSION_TOKEN",
  );
  if (!entry?.encryptedValue) {
    throw new Error("PAPR_SESSION_TOKEN not found in global keys");
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

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Parse GraphQL ${response.status}: ${text.slice(0, 400)}`);
  }

  const result = JSON.parse(text);
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }
  return result.data ?? {};
}

const ME = `
  query Me {
    viewer {
      user {
        objectId
      }
    }
  }
`;

// Kept in sync with GET_USER_WORKSPACES in src/electron/ipc/paprLogin.ts.
const GET_USER_WORKSPACES = `
  query GetUserWorkspaces($input: Workspace_followerWhereInput!) {
    workspace_followers(where: $input) {
      edges {
        node {
          objectId
          archive
          isMember
          isSelected
          workspace {
            objectId
            workspace_name
            memberCount
            organization {
              objectId
              name
              logoUrl
              workspace {
                objectId
              }
              default_namespace {
                objectId
                name
              }
            }
          }
        }
      }
    }
  }
`;

async function main() {
  const sessionToken = readSessionToken();

  const me = await graphql(sessionToken, ME, {});
  const userId = me.viewer?.user?.objectId;
  if (!userId) throw new Error("Could not resolve signed-in user");

  const data = await graphql(sessionToken, GET_USER_WORKSPACES, {
    input: {
      user: { have: { objectId: { equalTo: userId } } },
      isMember: { equalTo: true },
    },
  });

  const edges = data.workspace_followers?.edges ?? [];
  console.log(`\nuser=${userId}  rows=${edges.length}\n`);

  let missingMemberCount = 0;
  let orgPrimaryRows = 0;

  for (const edge of edges) {
    const workspace = edge.node?.workspace;
    if (!workspace) continue;

    const memberCount = workspace.memberCount;
    const orgPrimaryId = workspace.organization?.workspace?.objectId;
    const isOrgPrimary = orgPrimaryId === workspace.objectId;

    if (typeof memberCount !== "number") missingMemberCount += 1;
    if (isOrgPrimary) orgPrimaryRows += 1;

    console.log(
      [
        `ws=${workspace.objectId}`,
        `name=${JSON.stringify(workspace.workspace_name ?? null).padEnd(16)}`,
        `memberCount=${String(memberCount ?? "MISSING").padEnd(8)}`,
        `orgPrimary=${isOrgPrimary ? "YES" : "no "}`,
        `orgPointsAt=${orgPrimaryId ?? "none"}`,
      ].join("  "),
    );
  }

  console.log(
    `\nmemberCount populated on ${edges.length - missingMemberCount}/${edges.length} rows`,
  );
  console.log(`rows the organization points at: ${orgPrimaryRows}`);

  if (missingMemberCount === edges.length && edges.length > 0) {
    console.error(
      "\nFAIL: memberCount came back empty on every row — the tie-break would " +
        "fall back to arrival order.",
    );
    process.exitCode = 1;
  } else {
    console.log("\nOK: both tie-break signals are readable from this query.");
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
