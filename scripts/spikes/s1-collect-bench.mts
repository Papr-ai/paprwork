import { monitorEventLoopDelay } from "node:perf_hooks";
import * as path from "path";
import * as os from "os";
(async () => {
const paprDir = path.join(os.homedir(), "Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V");
process.env.PAPR_HOME = paprDir;
const { collectAppOpFiles } = await import(path.resolve("src/gateway/services/syncV3/collectAppOpFiles.ts"));
for (const appId of ["7d31c757-faac-46af-8047-1d9503f45070","6b0a8fa3-3a04-4b8b-a0b3-5d86f52b093f","b07325f7-9320-4f7a-acc7-601ac29ec158"]) {
  const h = monitorEventLoopDelay({ resolution: 1 }); h.enable();
  const t = performance.now();
  let n = -1, err = "";
  try { const r = await collectAppOpFiles(paprDir, appId); n = r.files.length; } catch (e) { err = String(e).slice(0,120); }
  const ms = performance.now() - t; h.disable();
  console.log(appId.slice(0,8), `wall ${ms.toFixed(0)}ms changed=${n} loopMax ${(h.max/1e6).toFixed(1)}ms p99 ${(h.percentile(99)/1e6).toFixed(1)}ms`, err);
}

})();
