/**
 * List every workspace_follower with isMember=true on a workspace, with the
 * user's email, and flag whether they are actually inside member-<workspaceId>.
 *
 * Read-only. Writes a CSV next to the repo for manual review; the terminal
 * output is a compact version of the same rows.
 *
 *   node_modules/.bin/electron scripts/list-papr-workspace-members.cjs [workspaceId]
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

const PAGE = 500;

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

async function fetchAll(sessionToken, urlPath, params) {
  const out = [];
  for (let skip = 0; ; skip += PAGE) {
    const page = await restGet(sessionToken, urlPath, {
      ...params,
      limit: String(PAGE),
      skip: String(skip),
    });
    out.push(...page.results);
    if (page.results.length < PAGE) return out;
  }
}

/** objectIds of users inside a named _Role. */
async function roleUserIds(sessionToken, roleName) {
  const roles = await restGet(sessionToken, "/roles", {
    where: JSON.stringify({ name: roleName }),
    limit: "1",
  });
  const role = roles.results[0];
  if (!role) return null;

  const users = await fetchAll(sessionToken, "/users", {
    where: JSON.stringify({
      $relatedTo: {
        object: { __type: "Pointer", className: "_Role", objectId: role.id ?? role.objectId },
        key: "users",
      },
    }),
    keys: "objectId",
  });
  return new Set(users.map((u) => u.objectId));
}

/**
 * Display names by user id, via the dashboard endpoint Paprwork's Team panel
 * uses. Parse hides other users' fields from a normal session token; that route
 * reads with the master key, so it is the only way to see the whole roster.
 */
async function dashboardUsers(sessionToken) {
  const platform = (
    process.env.PAPR_PLATFORM_URL || "https://dashboard.papr.ai"
  ).replace(/\/$/, "");
  const url = new URL(`${platform}/api/workspace/members`);
  url.searchParams.set("workspaceId", WORKSPACE_ID);

  const response = await fetch(url.toString(), {
    headers: { "X-Parse-Session-Token": sessionToken },
  });
  if (!response.ok) {
    console.log(`  (dashboard members endpoint returned ${response.status})`);
    return new Map();
  }
  const body = await response.json();
  const map = new Map();
  for (const member of body.members ?? []) {
    const user = member.user ?? {};
    if (user.objectId) {
      map.set(user.objectId, {
        name: user.displayName ?? user.fullname ?? "",
        role: user.role?.name ?? "",
      });
    }
  }
  return map;
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  await app.whenReady();
  const sessionToken = readSessionToken();

  console.log(`Workspace ${WORKSPACE_ID} on ${PARSE_SERVER_URL}\n`);

  const workspace = await restGet(
    sessionToken,
    `/classes/WorkSpace/${WORKSPACE_ID}`,
    { keys: "objectId,workspace_name,workspace_url,memberCount,followerCount" },
  );
  console.log(
    `${workspace.workspace_name} (${workspace.workspace_url})  ` +
      `memberCount=${workspace.memberCount} followerCount=${workspace.followerCount}`,
  );

  const inMemberRole = await roleUserIds(sessionToken, `member-${WORKSPACE_ID}`);
  console.log(
    `member-${WORKSPACE_ID} role holds ${inMemberRole ? inMemberRole.size : "no role found"} users\n`,
  );

  const followers = await fetchAll(sessionToken, "/classes/workspace_follower", {
    where: JSON.stringify({
      workspace: {
        __type: "Pointer",
        className: "WorkSpace",
        objectId: WORKSPACE_ID,
      },
      isMember: true,
    }),
    // Dot-notation keys are required for included pointers; without them Parse
    // returns the user object stripped down to objectId.
    keys:
      "objectId,isMember,isFollower,isDeveloperUser,archive,createdAt,updatedAt," +
      "user,user.objectId,user.username,user.displayName,user.fullname",
    include: "user",
    order: "createdAt",
  });

  console.log("Fetching display names from the dashboard members endpoint...");
  const directory = await dashboardUsers(sessionToken);
  console.log(`  resolved ${directory.size} names\n`);

  const rows = followers.map((follower) => {
    const user = follower.user ?? {};
    const fromDashboard = directory.get(user.objectId) ?? {};
    // Parse usernames are email addresses here, so they never reach the output.
    // Only display names are reported.
    const localPart = (user.username || "").split("@")[0];
    return {
      followerId: follower.objectId,
      userId: user.objectId ?? "",
      name: user.displayName || user.fullname || fromDashboard.name || localPart || "",
      isAnon: localPart.toLowerCase().startsWith("anon"),
      readable: Boolean(user.objectId),
      workspaceRole: fromDashboard.role ?? "",
      archive: follower.archive === true,
      isDeveloperUser: follower.isDeveloperUser === true,
      inRole: inMemberRole ? inMemberRole.has(user.objectId) : null,
      createdAt: follower.createdAt,
    };
  });

  const active = rows.filter((r) => !r.archive);
  console.log(
    `workspace_follower rows with isMember=true: ${rows.length} ` +
      `(${active.length} not archived, ${rows.length - active.length} archived)`,
  );
  console.log(
    `  in member role: ${active.filter((r) => r.inRole).length}   ` +
      `missing role: ${active.filter((r) => r.inRole === false).length}`,
  );

  const readable = active.filter((row) => row.readable);
  const hidden = active.filter((row) => !row.readable);
  const anon = readable.filter((row) => row.isAnon);
  const named = readable.filter((row) => !row.isAnon);

  console.log(
    `  identifiable: ${readable.length} (${named.length} named, ${anon.length} anonymous)`,
  );
  console.log(
    `  hidden by ACL (user object unreadable with this session): ${hidden.length}\n`,
  );

  console.log(`Named accounts (${named.length}), oldest first:`);
  console.log("role  created     display name");
  for (const row of named) {
    console.log(
      `${row.inRole ? " ok " : "MISS"}  ${row.createdAt.slice(0, 10)}  ` +
        `${row.name || `(no display name) ${row.userId}`}`,
    );
  }
  console.log("");

  const csvPath = path.join(process.cwd(), `papr-members-${WORKSPACE_ID}.csv`);
  const header = [
    "displayName",
    "accountType",
    "userId",
    "followerId",
    "inMemberRole",
    "isDeveloperUser",
    "createdAt",
    "keepAsMember",
  ];
  const accountType = (row) => {
    if (!row.readable) return "hidden";
    return row.isAnon ? "anonymous" : "named";
  };
  const csv = [
    header.join(","),
    ...active.map((row) =>
      [
        row.name,
        accountType(row),
        row.userId,
        row.followerId,
        row.inRole,
        row.isDeveloperUser,
        row.createdAt,
        "",
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");
  fs.writeFileSync(csvPath, csv + "\n", "utf8");
  console.log(`CSV written to ${csvPath}`);
  console.log("Mark keepAsMember=no on the rows you want flipped to isMember=false.");
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error("\nFAILED:", error.message);
    app.exit(1);
  });
