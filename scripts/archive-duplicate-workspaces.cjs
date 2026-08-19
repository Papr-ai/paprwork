/**
 * Archive duplicate Parse workspaces for the signed-in Papr user.
 *
 * Duplicate provisioning can leave several WorkSpace rows pointing at one
 * organization (typo'd slugs like `papr-ai.papr.ais` alongside the real
 * `papr-ai.papr.ai`). They are indistinguishable in the desktop switcher, and
 * whichever one wins deduplication becomes the workspace the Team panel and
 * billing queries use — so the wrong winner reports one member and no usage.
 *
 * Runs as a real Electron main process because the session token is encrypted
 * with safeStorage, which is unavailable under ELECTRON_RUN_AS_NODE.
 *
 *   node_modules/.bin/electron scripts/archive-duplicate-workspaces.cjs
 *   node_modules/.bin/electron scripts/archive-duplicate-workspaces.cjs --apply
 *
 * Dry run by default: it prints the plan and changes nothing without --apply.
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

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

function listArg(name, fallback) {
  const raw = args.find((a) => a.startsWith(`--${name}=`));
  if (!raw) return fallback;
  return raw
    .slice(name.length + 3)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Workspaces to keep no matter what. */
const KEEP = new Set(listArg("keep", ["qDgAdi2eMf", "7I5tUcLunV"]));
/** Explicit archive list; omit to let the guards choose. */
const ARCHIVE_ONLY = listArg("archive", null);

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
          isSelected
          workspace {
            objectId
            workspace_name
            workspace_url
            archive
            memberCount
            followerCount
            user { objectId }
            organization {
              objectId
              name
              workspace { objectId }
            }
          }
        }
      }
    }
  }
`;

const ARCHIVE_WORKSPACE = `
  mutation ArchiveWorkspace($id: ID!) {
    updateWorkSpace(input: { id: $id, fields: { archive: true } }) {
      workSpace { objectId workspace_url archive }
    }
  }
`;

const ARCHIVE_FOLLOWER = `
  mutation ArchiveFollower($id: ID!) {
    updateWorkspace_follower(
      input: { id: $id, fields: { archive: true, isSelected: false } }
    ) {
      workspace_follower { objectId archive isSelected }
    }
  }
`;

/**
 * Guards, in order of how much damage skipping them would do. memberCount is
 * the important one: a workspace other people belong to is never a duplicate to
 * discard, whatever its slug looks like.
 */
function classify(row, userId) {
  const ws = row.workspace;
  const orgPrimaryWorkspaceId = ws.organization?.workspace?.objectId;

  if (KEEP.has(ws.objectId)) return { archive: false, reason: "in --keep list" };
  if (ARCHIVE_ONLY && !ARCHIVE_ONLY.includes(ws.objectId)) {
    return { archive: false, reason: "not in --archive list" };
  }
  if (ws.archive === true && row.archive === true) {
    return { archive: false, reason: "already archived" };
  }
  if (ws.objectId === orgPrimaryWorkspaceId) {
    return { archive: false, reason: "organization's primary workspace" };
  }
  if ((ws.memberCount ?? 0) > 1) {
    return { archive: false, reason: `has ${ws.memberCount} members` };
  }
  if (ws.user?.objectId !== userId) {
    return { archive: false, reason: "not created by this user" };
  }
  return { archive: true, reason: "duplicate: 1 member, not org primary" };
}

async function main() {
  await app.whenReady();

  const sessionToken = readSessionToken();
  console.log(`Session token: ${sessionToken.slice(0, 6)}… (decrypted)`);

  const me = await graphql(sessionToken, ME, {});
  const userId = me.viewer?.user?.objectId;
  if (!userId) throw new Error("Could not resolve current user from session");
  console.log(`User: ${userId}`);
  console.log(`Mode: ${APPLY ? "APPLY (will write to Parse)" : "DRY RUN"}`);
  console.log(`Keep: ${[...KEEP].join(", ")}`);
  console.log("");

  const data = await graphql(sessionToken, MY_FOLLOWERS, {
    input: {
      user: { have: { objectId: { equalTo: userId } } },
      isMember: { equalTo: true },
    },
  });

  const rows = (data.workspace_followers?.edges ?? [])
    .map((e) => e.node)
    .filter((n) => n?.workspace?.objectId);

  console.log(`Parse returned ${rows.length} membership rows:\n`);

  const targets = [];
  for (const row of rows) {
    const ws = row.workspace;
    const verdict = classify(row, userId);
    if (verdict.archive) targets.push(row);
    console.log(
      `  ${verdict.archive ? "ARCHIVE" : "keep   "}  ${ws.objectId}  ` +
        `${String(ws.workspace_url ?? "-").padEnd(22)} ` +
        `name=${JSON.stringify(ws.workspace_name ?? null).padEnd(14)} ` +
        `members=${String(ws.memberCount ?? "?").padEnd(4)} ` +
        `wsArchive=${String(ws.archive)} folArchive=${String(row.archive)} ` +
        `selected=${String(row.isSelected)}  — ${verdict.reason}`,
    );
  }

  console.log("");
  if (targets.length === 0) {
    console.log("Nothing to archive.");
    return;
  }

  if (!APPLY) {
    console.log(
      `DRY RUN — would archive ${targets.length} workspace(s) and their ` +
        `follower rows. Re-run with --apply to execute.`,
    );
    return;
  }

  for (const row of targets) {
    const ws = row.workspace;
    console.log(`Archiving workspace ${ws.objectId} (${ws.workspace_url})…`);
    await graphql(sessionToken, ARCHIVE_WORKSPACE, { id: ws.objectId });
    console.log(`  workspace archived`);
    await graphql(sessionToken, ARCHIVE_FOLLOWER, { id: row.objectId });
    console.log(`  follower ${row.objectId} archived + deselected`);
  }

  console.log("\nVerifying…");
  const after = await graphql(sessionToken, MY_FOLLOWERS, {
    input: {
      user: { have: { objectId: { equalTo: userId } } },
      isMember: { equalTo: true },
    },
  });
  for (const edge of after.workspace_followers?.edges ?? []) {
    const node = edge.node;
    const ws = node?.workspace;
    if (!ws) continue;
    console.log(
      `  ${ws.objectId}  ${String(ws.workspace_url ?? "-").padEnd(22)} ` +
        `wsArchive=${String(ws.archive)} folArchive=${String(node.archive)} ` +
        `selected=${String(node.isSelected)}`,
    );
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error("\nFAILED:", error.message);
    app.exit(1);
  });
