/**
 * Read-only report of the signed-in Papr user's workspaces, straight from Parse.
 *
 * The desktop switcher shows workspaces after resolution and deduplication, so
 * it cannot answer "which of these rows is the real one". This prints the raw
 * membership rows with the fields that decide that: the slug, the member count,
 * the archive flags, and whether the organization points back at the workspace.
 *
 * Runs as a real Electron main process because the session token is encrypted
 * with safeStorage, which is unavailable under ELECTRON_RUN_AS_NODE.
 *
 *   node_modules/.bin/electron scripts/list-papr-workspaces.cjs
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
        organization_id
      }
    }
  }
`;

const MY_FOLLOWERS = `
  query MyFollowers($input: Workspace_followerWhereInput!) {
    workspace_followers(where: $input, first: 200) {
      edges {
        node {
          objectId
          archive
          isMember
          isFollower
          isSelected
          workspace {
            objectId
            workspace_name
            workspace_url
            archive
            memberCount
            followerCount
            createdAt
            user { objectId }
            organization {
              objectId
              name
              plan_tier
              workspace { objectId }
              default_namespace { objectId name }
            }
          }
        }
      }
    }
  }
`;

async function main() {
  await app.whenReady();

  const sessionToken = readSessionToken();
  const me = await graphql(sessionToken, ME, {});
  const userId = me.viewer?.user?.objectId;
  const developerOrgId = me.viewer?.user?.organization_id;
  console.log(`user=${userId}  developerOrg=${developerOrgId ?? "(none)"}\n`);

  const data = await graphql(sessionToken, MY_FOLLOWERS, {
    input: {
      user: { have: { objectId: { equalTo: userId } } },
      isMember: { equalTo: true },
    },
  });

  const rows = (data.workspace_followers?.edges ?? [])
    .map((e) => e.node)
    .filter((n) => n?.workspace?.objectId);

  console.log(`${rows.length} membership rows:\n`);
  for (const row of rows) {
    const ws = row.workspace;
    const org = ws.organization;
    const isOrgPrimary = org?.workspace?.objectId === ws.objectId;
    console.log(
      [
        `ws=${ws.objectId}`,
        `follower=${row.objectId}`,
        `slug=${String(ws.workspace_url ?? "-").padEnd(22)}`,
        `name=${JSON.stringify(ws.workspace_name ?? null).padEnd(14)}`,
        `members=${String(ws.memberCount ?? "?").padEnd(4)}`,
        `wsArchive=${String(ws.archive).padEnd(5)}`,
        `folArchive=${String(row.archive).padEnd(5)}`,
        `selected=${String(row.isSelected).padEnd(5)}`,
        `org=${org?.objectId}`,
        `orgPrimary=${isOrgPrimary ? "YES" : "no "}`,
        `ns=${org?.default_namespace?.objectId ?? "-"}`,
      ].join("  "),
    );
  }

  console.log(
    "\norgPrimary=YES means the organization's own `workspace` pointer " +
      "references this row — the authoritative workspace for that org.",
  );
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error("\nFAILED:", error.message);
    app.exit(1);
  });
