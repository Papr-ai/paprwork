/**
 * Demote anon / missing-user workspace_follower rows from team member to follower-only.
 *
 * Uses Parse REST saves (not a bulk GraphQL mutation) so beforeSave hooks run:
 *   - WorkSpace.memberCount decrements
 *   - member-{workspaceId} role is removed (follower role kept)
 *
 * Always writes a per-person audit CSV (ids, before/after state, action).
 * Dry-run by default. Pass --apply to write changes to Parse.
 *
 *   node scripts/demote-non-team-workspace-followers.cjs qDgAdi2eMf
 *   node scripts/demote-non-team-workspace-followers.cjs qDgAdi2eMf --apply
 *   node scripts/demote-non-team-workspace-followers.cjs qDgAdi2eMf --output ./my-audit.csv
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const outputFlagIndex = args.indexOf("--output");
const OUTPUT_PATH =
  outputFlagIndex >= 0
    ? args[outputFlagIndex + 1]
    : null;
const WORKSPACE_ID =
  args.find(
    (a, index) =>
      !a.startsWith("--") &&
      a !== OUTPUT_PATH &&
      (outputFlagIndex < 0 || index !== outputFlagIndex + 1),
  ) || "qDgAdi2eMf";

const PARSE_SERVER_URL =
  process.env.PARSE_SERVER_URL || "https://server.papr.ai/parse";
const PARSE_GRAPHQL_URL =
  process.env.PARSE_GRAPHQL_URL || "https://server.papr.ai/graphql";
const PARSE_APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";

const PAGE = 100;

const AUDIT_COLUMNS = [
  "followerId",
  "userId",
  "displayName",
  "email",
  "accountType",
  "action",
  "before_isMember",
  "before_isFollower",
  "before_archive",
  "after_isMember",
  "after_isFollower",
  "after_archive",
  "changeDescription",
  "createdAt",
  "applyStatus",
];

const LIST_QUERY = `
  query ListMemberFollowers($workspaceId: ID!, $first: Int!, $after: String) {
    workspace_followers(
      first: $first
      after: $after
      where: {
        AND: [
          { workspace: { have: { objectId: { equalTo: $workspaceId } } } }
          { isMember: { equalTo: true } }
          { archive: { notEqualTo: true } }
        ]
      }
      order: createdAt_ASC
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
          archive
          createdAt
          isDeveloperUser
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

function writeAuditCsv(auditPath, records) {
  const lines = [AUDIT_COLUMNS.join(",")];
  for (const record of records) {
    lines.push(AUDIT_COLUMNS.map((column) => csvCell(record[column])).join(","));
  }
  fs.writeFileSync(auditPath, `${lines.join("\n")}\n`, "utf8");
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

function classifyAccountType(user) {
  if (!user?.objectId) {
    return "missing_user";
  }
  if (isAnonIdentity(user)) {
    return "anonymous_api";
  }
  const email = (user.email || user.username || "").trim();
  if (!email) {
    return "no_email";
  }
  if (email.endsWith("@papr.ai")) {
    return "papr_team";
  }
  return "named_external";
}

function displayNameFor(user) {
  if (!user) return "(no user)";
  const email = (user.email || user.username || "").trim();
  return (
    user.displayName?.trim() ||
    user.fullname?.trim() ||
    (email ? email.split("@")[0] : "") ||
    user.objectId ||
    "(unknown)"
  );
}

function planChange(row) {
  const user = row.user;
  const accountType = classifyAccountType(user);
  const before = {
    isMember: row.isMember === true,
    isFollower: row.isFollower === true,
    archive: row.archive === true,
  };

  if (accountType === "missing_user") {
    return {
      accountType,
      action: "ARCHIVE",
      after: { isMember: false, isFollower: false, archive: true },
      changeDescription:
        "orphan workspace_follower (no linked _User) → archive row, remove member+follower flags",
    };
  }

  if (accountType === "anonymous_api") {
    return {
      accountType,
      action: "DEMOTE",
      after: { isMember: false, isFollower: true, archive: false },
      changeDescription:
        "Memory API end-user incorrectly marked team member → follower-only (keeps memory scoping)",
    };
  }

  return {
    accountType,
    action: "KEEP",
    after: { ...before },
    changeDescription: "real teammate — no change",
  };
}

function buildAuditRecord(row, applyStatus) {
  const user = row.user;
  const plan = planChange(row);
  const email = (user?.email || user?.username || "").trim();

  return {
    followerId: row.objectId,
    userId: user?.objectId || "",
    displayName: displayNameFor(user),
    email,
    accountType: plan.accountType,
    action: plan.action,
    before_isMember: row.isMember === true,
    before_isFollower: row.isFollower === true,
    before_archive: row.archive === true,
    after_isMember: plan.after.isMember,
    after_isFollower: plan.after.isFollower,
    after_archive: plan.after.archive,
    changeDescription: plan.changeDescription,
    createdAt: row.createdAt || "",
    applyStatus,
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

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(
      payload.errors?.map((e) => e.message).join("; ") ||
        `GraphQL failed (${response.status})`,
    );
  }
  return payload.data;
}

async function demoteFollower(masterKey, followerId) {
  const response = await fetch(
    `${PARSE_SERVER_URL}/classes/workspace_follower/${followerId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Parse-Application-Id": PARSE_APP_ID,
        "X-Parse-Master-Key": masterKey,
      },
      body: JSON.stringify({
        isMember: false,
        isFollower: true,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PUT ${followerId} failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function archiveFollower(masterKey, followerId) {
  const response = await fetch(
    `${PARSE_SERVER_URL}/classes/workspace_follower/${followerId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Parse-Application-Id": PARSE_APP_ID,
        "X-Parse-Master-Key": masterKey,
      },
      body: JSON.stringify({
        archive: true,
        isMember: false,
        isFollower: false,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `archive ${followerId} failed (${response.status}): ${body}`,
    );
  }

  return response.json();
}

async function listAllMemberFollowers(masterKey, workspaceId) {
  const rows = [];
  let after = null;

  for (;;) {
    const data = await graphqlMaster(masterKey, LIST_QUERY, {
      workspaceId,
      first: PAGE,
      after,
    });
    const connection = data.workspace_followers;
    for (const edge of connection?.edges ?? []) {
      rows.push(edge.node);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  return rows;
}

function printSummary(auditRecords) {
  const counts = { DEMOTE: 0, ARCHIVE: 0, KEEP: 0 };
  for (const record of auditRecords) {
    counts[record.action] = (counts[record.action] || 0) + 1;
  }

  console.log(`Will demote (anon API): ${counts.DEMOTE}`);
  console.log(`Will archive (missing user): ${counts.ARCHIVE}`);
  console.log(`Will keep (real teammates): ${counts.KEEP}\n`);

  console.log("Real teammates (KEEP):");
  for (const record of auditRecords) {
    if (record.action !== "KEEP") continue;
    console.log(
      `  ${record.displayName}  ${record.email || "(no email)"}  follower=${record.followerId}  user=${record.userId}`,
    );
  }

  console.log("\nSample DEMOTE rows (first 5):");
  for (const record of auditRecords.filter((r) => r.action === "DEMOTE").slice(0, 5)) {
    console.log(
      `  ${record.followerId}  user=${record.userId}  ${record.email}  → isMember=false, isFollower=true`,
    );
  }
}

async function main() {
  const masterKey = loadMasterKey();
  const auditPath =
    OUTPUT_PATH ||
    path.join(process.cwd(), `papr-demote-audit-${WORKSPACE_ID}.csv`);

  console.log(
    `${APPLY ? "APPLY" : "DRY-RUN"} — workspace ${WORKSPACE_ID}\n`,
  );

  const rows = await listAllMemberFollowers(masterKey, WORKSPACE_ID);
  console.log(`Found ${rows.length} isMember=true, archive=false rows\n`);

  const auditRecords = rows.map((row) =>
    buildAuditRecord(row, APPLY ? "PENDING" : "DRY_RUN"),
  );

  printSummary(auditRecords);
  writeAuditCsv(auditPath, auditRecords);
  console.log(`\nAudit CSV written: ${auditPath}`);

  if (!APPLY) {
    console.log("\nReview the CSV, then re-run with --apply to save through Parse hooks.");
    return;
  }

  let demoted = 0;
  let archived = 0;
  let kept = 0;
  let failed = 0;

  for (const record of auditRecords) {
    if (record.action === "KEEP") {
      record.applyStatus = "SKIPPED";
      kept += 1;
      continue;
    }

    try {
      if (record.action === "ARCHIVE") {
        await archiveFollower(masterKey, record.followerId);
        record.applyStatus = "APPLIED";
        archived += 1;
      } else if (record.action === "DEMOTE") {
        await demoteFollower(masterKey, record.followerId);
        record.applyStatus = "APPLIED";
        demoted += 1;
      }
    } catch (error) {
      record.applyStatus = "FAILED";
      failed += 1;
      console.error(`FAIL ${record.followerId} (${record.action}):`, error.message);
    }

    if ((demoted + archived + failed) % 50 === 0 && demoted + archived + failed > 0) {
      writeAuditCsv(auditPath, auditRecords);
      console.log(
        `Progress: demoted=${demoted} archived=${archived} failed=${failed} (audit saved)`,
      );
    }
  }

  writeAuditCsv(auditPath, auditRecords);

  console.log(
    `\nDone. demoted=${demoted} archived=${archived} kept=${kept} failed=${failed}`,
  );
  console.log(`Final audit CSV: ${auditPath}`);
  console.log(
    "Verify WorkSpace.memberCount in dashboard Settings or re-export roster.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
