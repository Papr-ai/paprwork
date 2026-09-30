/**
 * Read-only map of the organization/workspace pointer graph for one workspace.
 *
 * Organization carries a `workspace` pointer and WorkSpace carries an
 * `organization` pointer, so the two can disagree and several organizations can
 * claim the same workspace. `resolveNamespaceOrganizationId` decides what the
 * desktop does when they disagree, and that decision picks the namespace the
 * user's data lands in — so it is worth seeing the raw graph.
 *
 *   node_modules/.bin/electron scripts/inspect-papr-org-pointers.cjs [workspaceId]
 *
 * Contains no mutations.
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

const WORKSPACE_ID = process.argv.slice(2).find((a) => !a.startsWith("--")) ||
  "qDgAdi2eMf";

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
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Parse GraphQL ${response.status}: ${text.slice(0, 300)}`);
  }
  const result = JSON.parse(text);
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }
  return result.data ?? {};
}

const ORG_FIELDS = `
  objectId
  name
  plan_tier
  createdAt
  updatedAt
  owner_user_id
  workspace { objectId workspace_url workspace_name memberCount }
  default_namespace { objectId name environment_type }
`;

const WORKSPACE = `
  query Ws($id: ID!) {
    workSpace(id: $id) {
      objectId
      workspace_name
      workspace_url
      memberCount
      archive
      createdAt
      updatedAt
      organization { ${ORG_FIELDS} }
    }
  }
`;

const ORGS_CLAIMING_WORKSPACE = `
  query OrgsForWs($id: ID!) {
    organizations(
      where: { workspace: { have: { objectId: { equalTo: $id } } } }
      order: createdAt_DESC
    ) {
      edges { node { ${ORG_FIELDS} } }
    }
  }
`;

const MY_ORGS = `
  query MyOrgs($userId: ID!) {
    organizations(
      where: { owner: { have: { objectId: { equalTo: $userId } } } }
      order: createdAt_DESC
    ) {
      edges { node { ${ORG_FIELDS} } }
    }
  }
`;

const ORG_NAMESPACES = `
  query OrgNamespaces($orgId: ID!) {
    namespaces(
      where: { organization: { have: { objectId: { equalTo: $orgId } } } }
      order: createdAt_DESC
    ) {
      edges { node { objectId name environment_type is_active } }
    }
  }
`;

const ME = `
  query Me {
    viewer { user { objectId organization_id } }
  }
`;

function printOrg(prefix, org) {
  if (!org) {
    console.log(`${prefix}(none)`);
    return;
  }
  console.log(
    `${prefix}${org.objectId}  name=${JSON.stringify(org.name)}  tier=${org.plan_tier}`,
  );
  console.log(
    `${prefix}  workspace -> ${org.workspace?.objectId ?? "(none)"} ` +
      `(${org.workspace?.workspace_url ?? "-"}, members=${org.workspace?.memberCount ?? "?"})`,
  );
  console.log(
    `${prefix}  default_namespace -> ${org.default_namespace?.objectId ?? "(none)"} ` +
      `(${org.default_namespace?.name ?? "-"}, ${org.default_namespace?.environment_type ?? "-"})`,
  );
  console.log(
    `${prefix}  owner=${org.owner_user_id}  created=${org.createdAt}  updated=${org.updatedAt}`,
  );
}

async function main() {
  await app.whenReady();
  const sessionToken = readSessionToken();

  const me = await graphql(sessionToken, ME, {});
  const userId = me.viewer?.user?.objectId;
  const developerOrgId = me.viewer?.user?.organization_id;

  console.log(`user.objectId        = ${userId}`);
  console.log(`user.organization_id = ${developerOrgId}   (developer org)\n`);

  const wsData = await graphql(sessionToken, WORKSPACE, { id: WORKSPACE_ID });
  const ws = wsData.workSpace;
  console.log(`WORKSPACE ${WORKSPACE_ID}`);
  console.log(`  name=${JSON.stringify(ws?.workspace_name)}  slug=${ws?.workspace_url}`);
  console.log(`  memberCount=${ws?.memberCount}  archive=${ws?.archive}`);
  console.log(`  created=${ws?.createdAt}  updated=${ws?.updatedAt}`);
  console.log(`  workspace.organization  ->`);
  printOrg("      ", ws?.organization);

  console.log(`\nORGANIZATIONS whose \`workspace\` pointer claims ${WORKSPACE_ID}:`);
  const claiming = await graphql(sessionToken, ORGS_CLAIMING_WORKSPACE, {
    id: WORKSPACE_ID,
  });
  const claimingOrgs = (claiming.organizations?.edges ?? []).map((e) => e.node);
  if (claimingOrgs.length === 0) console.log("  (none)");
  for (const org of claimingOrgs) printOrg("  ", org);

  console.log(`\nORGANIZATIONS owned by ${userId}:`);
  const mine = await graphql(sessionToken, MY_ORGS, { userId });
  const myOrgs = (mine.organizations?.edges ?? []).map((e) => e.node);
  if (myOrgs.length === 0) console.log("  (none)");
  for (const org of myOrgs) printOrg("  ", org);

  const orgIds = new Set(
    [
      ws?.organization?.objectId,
      developerOrgId,
      ...claimingOrgs.map((o) => o.objectId),
      ...myOrgs.map((o) => o.objectId),
    ].filter(Boolean),
  );

  for (const orgId of orgIds) {
    const nsData = await graphql(sessionToken, ORG_NAMESPACES, { orgId });
    const namespaces = (nsData.namespaces?.edges ?? []).map((e) => e.node);
    console.log(`\nNAMESPACES in org ${orgId} (${namespaces.length}):`);
    for (const ns of namespaces) {
      console.log(
        `  ${ns.objectId}  ${String(ns.name).padEnd(28)} ` +
          `${String(ns.environment_type ?? "-").padEnd(12)} active=${ns.is_active}`,
      );
    }
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error("\nFAILED:", error.message);
    app.exit(1);
  });
