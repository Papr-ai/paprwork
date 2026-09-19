import { beforeEach, expect, test } from "vitest";
import { getPerformanceDiagnostics, resetPerformanceDiagnosticsForTests, traceDiagnosticPhase, withDiagnosticContext } from "../src/core/utils/performanceDiagnostics.js";
beforeEach(resetPerformanceDiagnosticsForTests);
test("nested phases retain parents and record scheduling waits", async () => {
 await withDiagnosticContext({parentId:"resume-task"},()=>traceDiagnosticPhase("vault:full-sync",async()=>{
  await traceDiagnosticPhase("vault:wait-for-quiet",async()=>{},true);
 }));
 const records=getPerformanceDiagnostics().recent;
 const full=records.find(r=>r.name==="vault:full-sync")!,wait=records.find(r=>r.name==="vault:wait-for-quiet")!;
 expect(full.parentId).toBe("resume-task");expect(wait.parentId).toBe(full.id);
 expect(wait.waits).toHaveLength(1);expect(wait.waits![0].finishedAt).toBeDefined();
});
test("a tolerated HTTP error remains visible in the phase without retaining its message", async () => {
 await traceDiagnosticPhase("vault:pull-http",async()=>{throw Object.assign(new Error("secret-value"),{status:403});}).catch(()=>{});
 const record=getPerformanceDiagnostics().recent[0];expect(record.status).toBe("error");expect(record.errorType).toBe("http_403");expect(JSON.stringify(record)).not.toContain("secret-value");
});
