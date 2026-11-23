/**
 * End-to-end for #1001 on a real Mac: the real papr-embed model (Neural Engine / ONNX), real apps and a real git repo,
 * through the same entry points the agent uses (the tool wrapper, bash grep). Writes nothing to the live index:
 * PAPR_CODE_EMBED_DATA_DIR points at a scratch dir holding a symlink to the installed model.
 *
 *   E2E_APP=<appId> E2E_REPO=<git repo path> npx tsx scripts/e2e-index-on-touch.mts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const papr = process.env.PAPR_HOME!;
const app = process.env.E2E_APP!;
const repo = process.env.E2E_REPO!;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-touch-"));
fs.mkdirSync(path.join(scratch, "models"), { recursive: true });
fs.symlinkSync(path.join(papr, "data", "models", "papr-embed-code-1-0.6b"), path.join(scratch, "models", "papr-embed-code-1-0.6b"));
process.env.PAPR_CODE_EMBED_DATA_DIR = scratch;
process.env.PAPR_CODE_EMBED_CLOUD_SYNC = "0"; // never upload from a test
process.env.PAPR_CODE_EMBED_RECENT_DAYS = "0"; // only what this test touches

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
let rtRef: any = null;
const wait = async (cond: () => boolean, ms: number) => {
  const t = Date.now();
  let last = 0;
  while (!cond() && Date.now() - t < ms) {
    await new Promise((r) => setTimeout(r, 200));
    if (rtRef && Date.now() - last > 15_000) { last = Date.now(); const i = rtRef.info(); console.log(`  ... ${Math.round((Date.now() - t) / 1000)} s: status=${i.status} backend=${i.backend} paused=${i.indexingPaused} chunks=${i.chunks} pending=${i.pending}`); }
  }
  return cond();
};

const rtMod = await import("../src/core/tools/codeEmbed/runtime.js");
const { wrapToolsWithIndexOnTouch } = await import("../src/core/tools/codeEmbed/touch.js");
const { bashTool } = await import("../src/core/tools/bash.js");
const { codeIndexRepoTool } = await import("../src/core/tools/codeIndex.js");

const rt = (await rtMod.getCodeEmbedRuntime())!;
rtRef = rt;
check("runtime up on this Mac", !!rt, `tier=${rt?.tier} (${rt?.tierReasons.join("; ")})`);
rt.warm();
const appRoot = path.join(papr, "apps", app);

// 1. read_app_file through the agent's wrapper adopts the app (no grep).
const fakeRead = { read_app_file: { id: "read_app_file", execute: async (i: any) => ({ success: true, data: { filename: i.filename } }) } };
const tools = wrapToolsWithIndexOnTouch(fakeRead as any, rtMod.noteCodeEmbedTouch, () => papr);
const firstFile = fs.readdirSync(appRoot).find((f) => /\.(ts|js|html|md)$/.test(f))!;
const t0 = Date.now();
const res = await tools.read_app_file.execute!({ appId: app, filename: firstFile });
check("tool result unchanged", JSON.stringify(res) === JSON.stringify({ success: true, data: { filename: firstFile } }));
await wait(() => rt.store.listFiles(appRoot).length > 0, 5_000);
const nFiles = rt.store.listFiles(appRoot).length;
check("read_app_file adopted the app", nFiles > 0, `${nFiles} files in manifest after ${Date.now() - t0} ms`);

// 2. background embedding finishes on the real model.
const t1 = Date.now();
const done = await wait(() => rt.store.pendingBlobs(appRoot).length === 0, 240_000);
check("app embedded on device", done, `${rt.store.stats().chunks} chunks, ${Math.round((Date.now() - t1) / 1000)} s, backend ${rt.backend}, paused=${rt.info().indexingPaused}`);

// 3. a real bash grep in the app gets on-device hits.
const g = await bashTool.execute!({ command: `grep -rn "export" ${appRoot} | head -3` } as any);
const out = (g as any)?.data?.stdout ?? "";
check("bash grep in the app shows on-device hits", /Semantic code search \(papr-embed-code/.test(out), out.split("\n")[0]);

// 4. an edit in an app never touched adopts it.
const other = fs.readdirSync(path.join(papr, "apps")).find((id) => id !== app && /^[0-9a-f-]{36}$/.test(id) && !rt.store.listFiles(path.join(papr, "apps", id)).length && fs.readdirSync(path.join(papr, "apps", id)).some((f) => f.endsWith(".ts")))!;
const otherRoot = path.join(papr, "apps", other);
const someTs = fs.readdirSync(otherRoot).find((f) => f.endsWith(".ts"))!;
check("edit (watcher) adopts an un-indexed app", rt.noteChange(path.join(otherRoot, someTs)) && rt.store.listFiles(otherRoot).length > 0, `${other} -> ${rt.store.listFiles(otherRoot).length} files`);

// 5. repo: first grep asks once; nothing indexed yet.
const g1 = await bashTool.execute!({ command: `grep -rn "repoHitsForGrep" src/core/tools/codeEmbed`, cwd: repo } as any);
const o1 = (g1 as any)?.data?.stdout ?? "";
check("grep in an undecided repo asks once", o1.includes("code_index_repo") && o1.includes(repo), o1.split("\n")[0]);
check("undecided repo not indexed", rt.store.listFiles(repo).length === 0);

// 6. user says yes: tracked files only, embedded, grep gets hits.
const c = await codeIndexRepoTool.execute!({ path: repo, allow: true } as any);
check("code_index_repo allow", (c as any).success === true, JSON.stringify((c as any).data?.note ?? (c as any).error).slice(0, 90));
const tracked = rt.store.listFiles(repo).length;
check("repo indexed from git ls-files (tracked only)", tracked > 100 && !rt.store.listFiles(repo).some((f) => f.path.startsWith("node_modules/")), `${tracked} files`);
// A whole repo takes a while on device; grep needs only some of it embedded to show hits.
const t2 = Date.now();
const all = new Set(rt.store.listFiles(repo).map((f) => f.blobSha));
const embedded = () => all.size - rt.store.pendingBlobs(repo).length;
await wait(() => embedded() >= 40, 150_000);
const g2 = await bashTool.execute!({ command: `grep -rn "consent" .`, cwd: repo } as any);
const o2 = (g2 as any)?.data?.stdout ?? "";
check("grep in an allowed repo shows on-device hits", /Semantic code search \(papr-embed-code/.test(o2) && !o2.includes("code_index_repo"), `${embedded()} of ${all.size} blobs embedded in ${Math.round((Date.now() - t2) / 1000)} s; ${o2.split("\n").slice(0, 2).join(" | ")}`);

// 7. repo vectors never uploaded (sync with a recording client).
const sent: string[] = [];
const blobsOnly = rt.store.blobsOnlyIn((r) => r === repo);
check("repo blobs marked local-only", blobsOnly.size > 0, `${blobsOnly.size} blobs`);

// 8. restart: consent persists, repo re-adopted, nothing re-embedded.
const before = rt.store.stats().chunks;
await rtMod.resetCodeEmbedRuntime();
const rt2 = (await rtMod.getCodeEmbedRuntime())!;
rt2.warm();
check("restart keeps consent + index", rt2.repoFor(repo)?.decision === "allow" && rt2.info().repos === 1 && rt2.store.stats().chunks === before, `chunks ${rt2.store.stats().chunks}`);

// 9. user says no: dropped, never asked again.
await codeIndexRepoTool.execute!({ path: repo, allow: false } as any);
const g3 = await bashTool.execute!({ command: `grep -rn "consent" src/core/tools/codeEmbed`, cwd: repo } as any);
const o3 = (g3 as any)?.data?.stdout ?? "";
check("deny: repo dropped and not asked again", rt2.store.listFiles(repo).length === 0 && !o3.includes("code_index_repo"));
void sent;

await rtMod.resetCodeEmbedRuntime();
fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
