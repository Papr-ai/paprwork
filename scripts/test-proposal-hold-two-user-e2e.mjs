#!/usr/bin/env node
/**
 * Proposal-hold two-user E2E (one API key, two external_user_id values).
 *
 * Teammate (Rony) installs a team app on its shared data, adds a migration
 * (applies locally under a proposal hold), can't publish it, proposes it;
 * the owner (Amir) approves -> teammate settles (rebuild + replay + resume).
 * Second change is rejected -> teammate rolls back + quarantines.
 *
 * Phased so each step can be debugged; state in $E2E_DIR/state.json.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-proposal-hold-two-user-e2e.mjs --phase=install
 * Phases: install, hold, propose, settle, cloudcheck, cleanup
 * Approve/reject happen in between, as the owner (resolve_cloud_app_pr).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const phase = arg("phase", "install");
const namespaceId = arg("namespace", "85ZIB7mD1V");
const slug = arg("slug", "qa-probe-v5");
const teammateUser = arg("teammate-user", "HwRXdaAqMN");
const tag = arg("tag", "a");
const E2E = process.env.E2E_DIR ?? "/tmp/pwh-e2e";
const home = join(E2E, "Papr");
const statePath = join(E2E, "state.json");
const memoryBase = "https://memory.papr.ai";
const apiKey = process.env.PAPR_API_KEY?.trim();
if (!apiKey) throw new Error("PAPR_API_KEY required");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${String(detail).slice(0, 300)}`}`);
};
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const mod = (p) => import(pathToFileURL(join(process.cwd(), "dist/gateway", p)).href);

function env() {
  process.env.PAPR_HOME = home;
  process.env.PAPR_NAMESPACE_ID = namespaceId;
  process.env.PAPR_ORG_ID = process.env.PAPR_ORG_ID ?? "Y8D4H7Yp3Z";
  process.env.PAPRWORK_TELEMETRY_PAPR_USER_ID = teammateUser;
  process.env.PAPR_API_KEY = apiKey;
  process.env.PAPR_MEMORY_SERVER_URL = memoryBase;
  process.env.CLOUD_SYNC_ENABLED = "true";
  process.env.GATEWAY_MODE = "cloud_agent";
}

async function cloudClient() {
  const r = await fetch(`${memoryBase}/v1/cloud/apps/install/db-token`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ namespaceId, slug, database: state.tursoShort, external_user_id: teammateUser }),
  });
  const t = await r.json();
  if (!t.tursoUrl) throw new Error(`db-token ${r.status} ${JSON.stringify(t).slice(0, 200)}`);
  const { createClient } = await import("@libsql/client");
  return createClient({ url: t.tursoUrl.replace("libsql://", "https://"), authToken: t.authToken });
}
async function cloudCols() {
  const c = await cloudClient();
  try { return (await c.execute("SELECT name FROM pragma_table_info('notes')")).rows.map((r) => String(r.name)); }
  finally { c.close(); }
}

async function heldWrite(col) {
  const { paprDbExec } = await mod("services/tursoReplica/PaprDbService.js");
  const hold = await mod("services/tursoReplica/replicaPublishHold.js");
  await paprDbExec({
    dbId: state.dbId,
    sql: `INSERT INTO notes (id, author, body, ${col}) VALUES ('e2e-${tag}', 'e2e', 'held write', 'held-${tag}')`,
  }).then(() => check("held write ok", true), (e) => check("held write ok", false, e.message));
  check("held write journaled", hold.readHoldJournal(state.dbPath).some((j) => j.sql.includes(`held-${tag}`)));
}

async function main() {
  env();
  // Desktop key is legacy-bound (no org/namespace in it): seed it like the gateway does for child processes.
  const { seedPaprApiKeyFromParent } = await mod("utils/keyResolver.js");
  if (!seedPaprApiKeyFromParent(apiKey)) console.log("WARN key seed refused");
  const { initializeTursoSyncBridge } = await mod("services/TursoSyncBridge.js");
  initializeTursoSyncBridge({ jobsRootDir: join(home, "Jobs"), appsRootDir: join(home, "apps"), memoryServerBase: memoryBase });
  if (phase === "install") {
    rmSync(E2E, { recursive: true, force: true });
    for (const d of ["data", "apps", "Jobs"]) mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, "data", "apps.json"), "[]\n");
    writeFileSync(join(home, "data", "jobs.json"), "[]\n");
    writeFileSync(join(home, "data", "databases.json"), JSON.stringify({ version: 1, databases: {} }));
    const { getCloudAppInstallService } = await mod("services/CloudAppInstallService.js");
    const res = await getCloudAppInstallService().installApp({ namespaceId, slug, mode: "track", installDbPolicy: "shared_primary", catalogScope: "namespace", visibility: "team" });
    state.appId = res.app?.id;
    const lineage = JSON.parse(readFileSync(join(home, "apps", state.appId, "papr-cloud-lineage.json"), "utf8"));
    check("installed on team's shared data", lineage.databasePolicy === "shared", lineage.databasePolicy);
    const reg = JSON.parse(readFileSync(join(home, "data", "databases.json"), "utf8")).databases;
    state.dbId = Object.keys(reg)[0];
    state.tursoShort = reg[state.dbId]?.tursoShortName;
    state.dbPath = reg[state.dbId]?.localPath;
    save();
    const { isCollaboratorOnSharedDatabase } = await mod("services/sharedPrimaryTursoResolve.js");
    check("treated as collaborator", isCollaboratorOnSharedDatabase(state.dbId));
    check("cloud reachable as teammate", (await cloudCols()).includes("id"));
  }

  if (phase === "hold") {
    const col = `e2e_${tag}`;
    const before = await cloudCols();
    const { paprDbCreateMigration, paprDbExec } = await mod("services/tursoReplica/PaprDbService.js");
    const created = await paprDbCreateMigration({ dbId: state.dbId, name: `e2e_${tag}`, sql: `ALTER TABLE notes ADD COLUMN ${col} TEXT` });
    state[`mig_${tag}`] = created.migrationId; save();
    check("migration applied (not refused)", created.apply?.applied !== false, JSON.stringify(created.apply ?? created.note));
    const hold = await mod("services/tursoReplica/replicaPublishHold.js");
    const h = hold.getReplicaPublishHold(state.dbPath);
    check("proposal hold created", h && hold.holdPurpose(h) === "proposal", JSON.stringify(h));
    check("hold carries the migration", h?.migrations?.some((m) => m.migrationId === created.migrationId));
    check("not publishable", hold.listPublishableHolds().length === 0);
    check("cloud schema unchanged", !(await cloudCols()).includes(col) && before.length === (await cloudCols()).length);
    await heldWrite(col);
    const { publishHeldDatabase } = await mod("services/tursoReplica/publishHeldDatabases.js");
    const refused = await publishHeldDatabase(h, state.tursoShort, {}).then(() => false, (e) => /proposed schema change/.test(e.message));
    check("publish refuses the proposal hold", refused);
  }

  if (phase === "write") await heldWrite(`e2e_${tag}`);

  if (phase === "propose") {
    const { getCloudAppContributeService } = await mod("services/CloudAppContributeService.js");
    const r = await getCloudAppContributeService().propose({
      sourceNamespaceId: namespaceId, sourceSlug: slug, installedAppId: state.appId,
      title: `[E2E test] proposal hold ${tag} — safe to close`, description: "Automated proposal-hold E2E.",
    });
    state[`req_${tag}`] = r.id; save();
    check("proposal submitted", !!r.id, JSON.stringify(r).slice(0, 200));
    check("proposal carries the held migration", r.stagedPaths.some((p) => p.endsWith(`${state[`mig_${tag}`]}.sql`)), r.stagedPaths.join(","));
    console.log("REQUEST_ID", r.id);
  }

  if (phase === "settle") {
    const expect = arg("expect", "approved");
    const { settleProposalHolds } = await mod("services/tursoReplica/settleProposalHolds.js");
    const results = await settleProposalHolds();
    console.log("settle", JSON.stringify(results));
    check(`outcome ${expect}`, results.some((r) => r.outcome === expect), JSON.stringify(results));
    const hold = await mod("services/tursoReplica/replicaPublishHold.js");
    check("hold released", !hold.isReplicaHeld(state.dbPath));
    const col = `e2e_${tag}`;
    const cols = await cloudCols();
    check(expect === "approved" ? "cloud has the column" : "cloud never got the column", expect === "approved" ? cols.includes(col) : !cols.includes(col), cols.join(","));
    const c = await cloudClient();
    const rows = expect === "approved"
      ? (await c.execute(`SELECT count(*) n FROM notes WHERE ${col} = 'held-${tag}'`)).rows[0].n : null;
    c.close();
    if (expect === "approved") check("held write replayed to cloud", Number(rows) === 1, rows);
    if (expect === "rejected") {
      const q = join(home, "data", "databases"); // migration root lives under the db folder
      const found = JSON.stringify(readdirSync(q, { recursive: true })).includes(`${state[`mig_${tag}`]}.sql.rejected`);
      check("rejected migration quarantined", found);
    }
  }

  if (phase === "cleanup") rmSync(E2E, { recursive: true, force: true });
  console.log(`\n${phase}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("ERROR", e?.stack ?? e); process.exit(2); });
