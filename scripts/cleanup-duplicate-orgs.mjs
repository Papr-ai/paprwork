/**
 * Delete duplicate empty Parse Organization rows for one workspace.
 *
 * Dry run by default. Uses Parse REST with master key from env:
 *   PARSE_APP_ID, PARSE_MASTER_KEY, PARSE_SERVER_URL (default https://server.papr.ai/parse)
 *
 *   node scripts/cleanup-duplicate-orgs.mjs --workspace=PNklc5rRxH
 *   node scripts/cleanup-duplicate-orgs.mjs --workspace=PNklc5rRxH --apply
 *   node scripts/cleanup-duplicate-orgs.mjs --workspace=PNklc5rRxH --apply --set-primary=GBpVyJSDeI
 */

const APP_ID =
  process.env.PARSE_APP_ID || "671e705a-f735-4ec0-8474-15899a475440";
const MASTER = process.env.PARSE_MASTER_KEY;
const BASE = (process.env.PARSE_SERVER_URL || "https://server.papr.ai/parse").replace(
  /\/$/,
  "",
);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const workspaceId = args.find((a) => a.startsWith("--workspace="))?.split("=")[1];
const setPrimary = args.find((a) => a.startsWith("--set-primary="))?.split("=")[1];
const keepArg = args.find((a) => a.startsWith("--keep="))?.split("=")[1];
const KEEP = new Set(
  (keepArg ? keepArg.split(",") : ["GBpVyJSDeI", "s1RFaOs032"]).map((s) => s.trim()),
);

if (!MASTER) {
  console.error("Set PARSE_MASTER_KEY");
  process.exit(1);
}
if (!workspaceId) {
  console.error("Usage: --workspace=WORKSPACE_ID [--apply] [--set-primary=ORG_ID] [--keep=id1,id2]");
  process.exit(1);
}

async function listOrgs() {
  const where = {
    workspace: {
      __type: "Pointer",
      className: "WorkSpace",
      objectId: workspaceId,
    },
  };
  const params = new URLSearchParams({
    where: JSON.stringify(where),
    keys: "objectId,name,default_namespace",
    limit: "200",
    order: "createdAt",
  });
  const res = await fetch(`${BASE}/classes/Organization?${params}`, {
    headers: {
      "X-Parse-Application-Id": APP_ID,
      "X-Parse-Master-Key": MASTER,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  const body = await res.json();
  return body.results ?? [];
}

async function countNamespaces(orgId) {
  const where = {
    organization: {
      __type: "Pointer",
      className: "Organization",
      objectId: orgId,
    },
  };
  const params = new URLSearchParams({
    where: JSON.stringify(where),
    keys: "objectId",
    limit: "1",
    count: "1",
  });
  const res = await fetch(`${BASE}/classes/Namespace?${params}`, {
    headers: {
      "X-Parse-Application-Id": APP_ID,
      "X-Parse-Master-Key": MASTER,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  const body = await res.json();
  return body.count ?? 0;
}

async function deleteOrg(orgId) {
  const res = await fetch(`${BASE}/classes/Organization/${orgId}`, {
    method: "DELETE",
    headers: {
      "X-Parse-Application-Id": APP_ID,
      "X-Parse-Master-Key": MASTER,
    },
  });
  if (!res.ok) throw new Error(`delete ${orgId}: ${await res.text()}`);
}

async function setWorkspacePrimaryOrg(orgId) {
  const res = await fetch(`${BASE}/classes/WorkSpace/${workspaceId}`, {
    method: "PUT",
    headers: {
      "X-Parse-Application-Id": APP_ID,
      "X-Parse-Master-Key": MASTER,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      organization: {
        __type: "Pointer",
        className: "Organization",
        objectId: orgId,
      },
    }),
  });
  if (!res.ok) throw new Error(`set primary: ${await res.text()}`);
}

(async () => {
  const orgs = await listOrgs();
  console.log(`Workspace ${workspaceId}: ${orgs.length} organization row(s)\n`);

  const toDelete = [];
  for (const org of orgs) {
    const nsCount = await countNamespaces(org.objectId);
    const keep = KEEP.has(org.objectId);
    const empty = nsCount === 0 && !org.default_namespace;
    const markDelete = empty && !keep;
    console.log(
      `${markDelete ? "DELETE" : keep ? "KEEP  " : "SKIP  "} ${org.objectId} | ${org.name} | namespaces=${nsCount}`,
    );
    if (markDelete) toDelete.push(org.objectId);
  }

  console.log(`\nPlan: delete ${toDelete.length}, keep ${KEEP.size} explicit + any with namespaces`);

  if (setPrimary) {
    console.log(`\nSet workspace primary org → ${setPrimary}`);
    if (APPLY) {
      await setWorkspacePrimaryOrg(setPrimary);
      console.log("Primary org updated.");
    }
  }

  if (!APPLY) {
    console.log("\nDry run — pass --apply to execute.");
    return;
  }

  for (const orgId of toDelete) {
    await deleteOrg(orgId);
    console.log(`Deleted ${orgId}`);
  }
  console.log("Done.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
