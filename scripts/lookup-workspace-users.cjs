/**
 * Look up specific users on a workspace and compare with dashboard members API.
 * Read-only.
 *
 *   node_modules/.bin/electron scripts/lookup-workspace-users.cjs [workspaceId]
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
const PAPR_PLATFORM_URL = (
  process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai"
).replace(/\/$/, "");

const WORKSPACE_ID =
  process.argv.slice(2).find((a) => !a.startsWith("--")) || "qDgAdi2eMf";

const SEARCH = [
  "wasseem",
  "waseem",
  "ryan",
  "hassan",
  "corey",
  "badcock",
  "shawkat",
  "amir",
  "rferzli",
  "eval",
];

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

  console.log(`Workspace ${WORKSPACE_ID}\n`);

  const users = await restGet(sessionToken, "/users", {
    where: JSON.stringify({
      $or: SEARCH.flatMap((term) => [
        { email: { $regex: term, $options: "i" } },
        { username: { $regex: term, $options: "i" } },
        { displayName: { $regex: term, $options: "i" } },
        { fullname: { $regex: term, $options: "i" } },
      ]),
    }),
    limit: "100",
  });

  console.log(`Matched ${users.results.length} Parse users:\n`);

  for (const user of users.results) {
    const label =
      user.displayName ||
      user.fullname ||
      user.email ||
      user.username ||
      user.objectId;
    console.log(`${label}`);
    console.log(`  userId: ${user.objectId}`);
    console.log(`  email: ${user.email || user.username || "(none)"}`);

    const followers = await restGet(sessionToken, "/classes/workspace_follower", {
      where: JSON.stringify({
        workspace: {
          __type: "Pointer",
          className: "WorkSpace",
          objectId: WORKSPACE_ID,
        },
        user: {
          __type: "Pointer",
          className: "_User",
          objectId: user.objectId,
        },
      }),
      limit: "5",
    });

    if (followers.results.length === 0) {
      console.log("  workspace_follower on Papr workspace: NONE");
    } else {
      for (const follower of followers.results) {
        console.log(
          `  workspace_follower: isMember=${follower.isMember} archive=${follower.archive === true} isFollower=${follower.isFollower}`,
        );
      }
    }
    console.log("");
  }

  const url = new URL(`${PAPR_PLATFORM_URL}/api/workspace/members`);
  url.searchParams.set("workspaceId", WORKSPACE_ID);
  const response = await fetch(url.toString(), {
    headers: { "X-Parse-Session-Token": sessionToken },
  });
  const body = await response.json();
  const members = body.members ?? [];

  console.log(`Dashboard /api/workspace/members returned ${members.length}:\n`);
  for (const member of members) {
    const user = member.user ?? {};
    console.log(
      `  ${user.displayName || user.fullname || "?"} | ${user.email || "?"} | role=${user.role?.name ?? user.role ?? "?"}`,
    );
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error("\nFAILED:", error.message);
    app.exit(1);
  });
