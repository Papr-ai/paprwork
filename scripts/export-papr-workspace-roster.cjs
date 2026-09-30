/**
 * Export full Papr workspace roster with name/email via Parse master key.
 * Classifies rows so you can decide what to keep vs flip to follower-only.
 *
 * Requires PARSE_SERVER_MASTER_KEY (or papr-dev-platform apps/web/.env.local).
 *
 *   node scripts/export-papr-workspace-roster.cjs [workspaceId]
 */

const fs = require("fs");
const path = require("path");

const WORKSPACE_ID =
  process.argv.slice(2).find((a) => !a.startsWith("--")) || "qDgAdi2eMf";

const PARSE_SERVER_URL =
  process.env.PARSE_SERVER_URL || "https://server.papr.ai/parse";
const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL || "https://server.papr.ai/graphql";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

const PAGE = 100;

function loadMasterKey() {
  if (process.env.PARSE_SERVER_MASTER_KEY?.trim()) {
    return process.env.PARSE_SERVER_MASTER_KEY.trim();
  }

  const platformEnv = path.join(
    process.env.HOME || "",
    "Documents/GitHub/papr-dev-platform/apps/web/.env.local",
  );
  if (!fs.existsSync(platformEnv)) {
    throw new Error(
      "Set PARSE_SERVER_MASTER_KEY or add it to papr-dev-platform/apps/web/.env.local",
    );
  }

  for (const line of fs.readFileSync(platformEnv, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== "PARSE_SERVER_MASTER_KEY") continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) return value;
  }

  throw new Error("PARSE_SERVER_MASTER_KEY not found in platform .env.local");
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isAnonIdentity(user) {
  if (!user) return false;
  const email = (user.email || user.username || "").toLowerCase();
  const displayName = (user.displayName || "").toLowerCase();
  const fullname = (user.fullname || "").toLowerCase();
  return (
    email.startsWith("anon") ||
    displayName.startsWith("anon") ||
    fullname.startsWith("anon")
  );
}

function classifyRow(user, inMemberRole) {
  if (!user?.objectId) {
    return {
      accountType: "missing_user",
      recommendation: "REVIEW — follower row with no linked user",
    };
  }

  if (isAnonIdentity(user)) {
    return {
      accountType: "anonymous_api",
      recommendation: "SET isMember=false (API user, not human teammate)",
    };
  }

  const email = (user.email || user.username || "").trim();
  if (!email) {
    return {
      accountType: "no_email",
      recommendation: "REVIEW — real user but no email on record",
    };
  }

  if (email.endsWith("@papr.ai")) {
    return {
      accountType: "papr_team",
      recommendation: inMemberRole
        ? "KEEP — Papr team member"
        : "REVIEW — add to member role if they should have team access",
    };
  }

  return {
    accountType: "named_external",
    recommendation: inMemberRole
      ? "KEEP or REVIEW — external email, confirm intentional"
      : "REVIEW — not in member role",
  };
}

async function graphqlMaster(masterKey, query, variables) {
  const response = await fetch(PARSE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Master-Key": masterKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    throw new Error(
      body.errors?.map((e) => e.message).join(", ") ||
        `GraphQL HTTP ${response.status}`,
    );
  }
  return body.data;
}

async function restMaster(masterKey, urlPath, params) {
  const url = new URL(`${PARSE_SERVER_URL}${urlPath}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: {
      "X-Parse-Application-Id": PARSE_APP_ID,
      "X-Parse-Master-Key": masterKey,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Parse REST ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function fetchAllFollowers(masterKey) {
  const rows = [];
  let after = null;

  const query = `
    query ExportWorkspaceMembers($workspaceId: ID!, $first: Int!, $after: String) {
      workspace_followers(
        where: {
          AND: [
            { workspace: { have: { objectId: { equalTo: $workspaceId } } } }
            { isMember: { equalTo: true } }
            { archive: { notEqualTo: true } }
          ]
        }
        order: createdAt_ASC
        first: $first
        after: $after
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            objectId
            isMember
            isFollower
            isDeveloperUser
            createdAt
            user {
              objectId
              email
              username
              displayName
              fullname
            }
          }
        }
      }
    }
  `;

  for (;;) {
    const data = await graphqlMaster(masterKey, query, {
      workspaceId: WORKSPACE_ID,
      first: PAGE,
      after,
    });
    const connection = data.workspace_followers;
    for (const edge of connection.edges) {
      rows.push(edge.node);
    }
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  return rows;
}

async function roleUserIds(masterKey, roleName) {
  const roles = await restMaster(masterKey, "/roles", {
    where: JSON.stringify({ name: roleName }),
    limit: "1",
  });
  const role = roles.results[0];
  if (!role) return new Set();

  const users = [];
  for (let skip = 0; ; skip += 1000) {
    const page = await restMaster(masterKey, "/users", {
      where: JSON.stringify({
        $relatedTo: {
          object: {
            __type: "Pointer",
            className: "_Role",
            objectId: role.id ?? role.objectId,
          },
          key: "users",
        },
      }),
      keys: "objectId",
      limit: "1000",
      skip: String(skip),
    });
    users.push(...page.results);
    if (page.results.length < 1000) break;
  }

  return new Set(users.map((u) => u.objectId));
}

async function main() {
  const masterKey = loadMasterKey();
  console.log(`Exporting isMember=true roster for workspace ${WORKSPACE_ID}...\n`);

  const memberRoleUsers = await roleUserIds(
    masterKey,
    `member-${WORKSPACE_ID}`,
  );
  const followers = await fetchAllFollowers(masterKey);

  const rows = followers.map((follower) => {
    const user = follower.user;
    const userId = user?.objectId || "";
    const email = (user?.email || user?.username || "").trim();
    const displayName =
      user?.displayName?.trim() ||
      user?.fullname?.trim() ||
      (email ? email.split("@")[0] : "") ||
      (userId ? `(user ${userId})` : "(no user)");
    const inMemberRole = userId ? memberRoleUsers.has(userId) : false;
    const { accountType, recommendation } = classifyRow(user, inMemberRole);

    return {
      displayName,
      email,
      accountType,
      recommendation,
      userId,
      followerId: follower.objectId,
      inMemberRole,
      isDeveloperUser: follower.isDeveloperUser === true,
      createdAt: follower.createdAt,
    };
  });

  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const counts = {};
  for (const row of rows) {
    counts[row.accountType] = (counts[row.accountType] || 0) + 1;
  }

  console.log(`Total isMember=true rows: ${rows.length}`);
  for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  console.log("\nLikely real teammates (papr_team + named_external, non-anon):");
  for (const row of rows) {
    if (row.accountType === "papr_team" || row.accountType === "named_external") {
      console.log(
        `  ${row.createdAt.slice(0, 10)}  ${row.displayName}  ${row.email || "(no email)"}  [${row.accountType}]`,
      );
    }
  }

  const outPath = path.join(
    process.cwd(),
    `papr-roster-full-${WORKSPACE_ID}.csv`,
  );
  const header = [
    "displayName",
    "email",
    "accountType",
    "recommendation",
    "userId",
    "followerId",
    "inMemberRole",
    "isDeveloperUser",
    "createdAt",
    "action",
  ];
  const csv = [
    header.join(","),
    ...rows.map((row) =>
      [
        row.displayName,
        row.email,
        row.accountType,
        row.recommendation,
        row.userId,
        row.followerId,
        row.inMemberRole,
        row.isDeveloperUser,
        row.createdAt,
        "",
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");
  fs.writeFileSync(outPath, csv + "\n", "utf8");
  console.log(`\nFull CSV written to ${outPath}`);
  console.log("Add your decision in the action column (KEEP / SET isMember=false).");
}

main().catch((error) => {
  console.error("\nFAILED:", error.message);
  process.exit(1);
});
