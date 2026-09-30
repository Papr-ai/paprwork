/**
 * Inspect a workspace's Parse _Role and who is inside it.
 *
 * The Organization ACL grants read to `role:member-<workspaceId>`, so a user can
 * only see their team's org if they are actually a member of that _Role. Adding a
 * workspace_follower row is a separate write, so the two can disagree.
 *
 *   node_modules/.bin/electron scripts/check-papr-role-membership.cjs [workspaceId] [userId...]
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

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const WORKSPACE_ID = args[0] || "qDgAdi2eMf";
const USER_IDS = args.length > 1 ? args.slice(1) : ["9TXbNLCGtE", "mkcNHhG5KP"];

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

function relatedToUsers(roleId) {
  return {
    $relatedTo: {
      object: { __type: "Pointer", className: "_Role", objectId: roleId },
      key: "users",
    },
  };
}

async function main() {
  await app.whenReady();
  const sessionToken = readSessionToken();

  const roleNames = [`member-${WORKSPACE_ID}`, `Follower-${WORKSPACE_ID}`];
  console.log(`Looking for roles ${roleNames.join(", ")} on ${PARSE_SERVER_URL}\n`);

  const roles = await restGet(sessionToken, "/roles", {
    where: JSON.stringify({ name: { $in: roleNames } }),
    limit: "10",
  });

  if (!roles.results.length) {
    console.log(`No roles named ${roleNames.join(" or ")} exist.`);
    console.log(
      "That alone would make the Organization unreadable to every member.",
    );
    return;
  }

  for (const role of roles.results) {
    console.log(
      `_Role ${role.objectId}  name="${role.name}"  created=${role.createdAt}  updated=${role.updatedAt}`,
    );

    const count = await restGet(sessionToken, "/users", {
      where: JSON.stringify(relatedToUsers(role.objectId)),
      count: "1",
      limit: "0",
    });
    console.log(`  users in role: ${count.count}`);

    for (const userId of USER_IDS) {
      const hit = await restGet(sessionToken, "/users", {
        where: JSON.stringify({
          ...relatedToUsers(role.objectId),
          objectId: userId,
        }),
        keys: "objectId,email,displayName",
        limit: "1",
      });
      const found = hit.results[0];
      console.log(
        `  ${userId}: ${found ? `IN ROLE (${found.email ?? found.displayName ?? "?"})` : "NOT in role"}`,
      );
    }
  }

  console.log("\nFollower rows on this workspace for the same users:");
  for (const userId of USER_IDS) {
    const followers = await restGet(sessionToken, "/classes/workspace_follower", {
      where: JSON.stringify({
        user: { __type: "Pointer", className: "_User", objectId: userId },
        workspace: {
          __type: "Pointer",
          className: "WorkSpace",
          objectId: WORKSPACE_ID,
        },
      }),
      keys: "objectId,isMember,isFollower,archive,createdAt",
      limit: "5",
    });
    const row = followers.results[0];
    console.log(
      `  ${userId}: ${
        row
          ? `follower ${row.objectId} isMember=${row.isMember} archive=${row.archive} created=${row.createdAt}`
          : "no follower row"
      }`,
    );
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error("\nFAILED:", error.message);
    app.exit(1);
  });
