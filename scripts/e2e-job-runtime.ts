/**
 * Manual end-to-end check for declared job runtimes (real venv, real pip, real PATH).
 *
 *   npx tsx scripts/e2e-job-runtime.ts [path/to/a/job/folder]
 *
 * Copies the given job folder (default: any folder with requirements.txt) to a temp dir, drives the REAL
 * CommandJobExecutor against it as a `bash` job and asserts that:
 *   1. numpy/pillow declared in requirements.txt are importable by a bare `python3`
 *   2. tools declared in runtime.json (ffmpeg, node) are resolved
 *   3. an unchanged second run does not reinstall
 *   4. a missing tool / unresolvable package fails with a structured missing_dependency
 */
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { ChildProcess } from "child_process";
import { CommandJobExecutor } from "../src/gateway/services/jobs/executors/CommandJobExecutor.js";
import type { JobRecord } from "../src/gateway/services/jobs/types.js";

const source = process.argv[2];
if (!source || !existsSync(path.join(source, "requirements.txt"))) {
  console.error("usage: tsx scripts/e2e-job-runtime.ts <job folder containing requirements.txt>");
  process.exit(2);
}
const work = mkdtempSync(path.join(tmpdir(), "e2e-rt-"));
process.env.PAPR_RUNTIMES_ROOT = path.join(work, "runtimes-root");
const jobDir = path.join(work, "job");
cpSync(source, jobDir, { recursive: true, filter: (s) => !/[\\/](\.venv|node_modules|logs|data)([\\/]|$)/.test(s) });

const CHECK =
  `python3 -c "import sys,numpy,PIL; print('PY', sys.executable); print('NUMPY', numpy.__version__); print('PIL', PIL.__version__)" ` +
  `&& ffmpeg -version | head -1 && node --version`;

async function run(command: string): Promise<{ code: number | null; out: string; logs: string[]; error?: Error }> {
  const logs: string[] = [];
  const job = { id: "e2e-job-runtime", name: "e2e", type: "bash", status: "pending", appIds: [], command } as unknown as JobRecord;
  try {
    const res = await new CommandJobExecutor(["bash"]).launch({
      runId: "e2e", job, jobDir, defaultCommandByType: {} as never, appendLog: async (l) => void logs.push(l),
    });
    const child = res.process as ChildProcess;
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    return { code, out, logs };
  } catch (error) {
    return { code: null, out: "", logs, error: error as Error };
  }
}

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failed++;
};

async function main() {
  writeFileSync(path.join(jobDir, "runtime.json"), JSON.stringify({ tools: ["ffmpeg", "node"] }));

  let t = Date.now();
  const first = await run(CHECK);
  const firstMs = Date.now() - t;
  console.log(first.out.trim());
  check("1. bare python3 imports numpy + pillow from the job venv", first.code === 0 && first.out.includes(path.join(jobDir, ".venv")), `${firstMs}ms`);
  check("2. declared tools (ffmpeg, node) resolved", /ffmpeg version/.test(first.out) && /v\d+\./.test(first.out));

  t = Date.now();
  const second = await run(CHECK);
  check("3. unchanged second run does not reinstall", second.code === 0 && !second.logs.some((l) => l.includes("Installing Python requirements")), `${Date.now() - t}ms`);

  writeFileSync(path.join(jobDir, "runtime.json"), JSON.stringify({ tools: ["papr-definitely-missing-tool"] }));
  const missingTool = await run("true");
  check("4a. missing tool -> structured missing_dependency", (missingTool.error as { code?: string })?.code === "missing_dependency" && missingTool.logs.some((l) => l.startsWith("PAPR_ERROR ")), missingTool.error?.message.split("\n")[1]?.trim());

  writeFileSync(path.join(jobDir, "runtime.json"), JSON.stringify({ python: ["papr-no-such-package-zzz-123"] }));
  const badPkg = await run("true");
  check("4b. unresolvable python package -> structured missing_dependency", (badPkg.error as { code?: string })?.code === "missing_dependency");
}

main().catch((e) => { console.error(e); failed++; }).finally(() => {
  rmSync(work, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
});
