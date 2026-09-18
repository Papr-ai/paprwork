import { DiagnosticOperation } from "./performanceDiagnostics.js";
import { spawn } from "node:child_process";

/** Async setup with bounded output and cancellation of the whole installer group. */
export function runSetupCommand(
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number;
    encoding?: string; stdio?: string; signal?: AbortSignal; diagnosticName?: "python-check" | "python-venv" | "pip-install" | "npm-install" | "chromium-install" } = {},
): Promise<string> {
  const trace = new DiagnosticOperation("setup", options.diagnosticName ?? "dependency-setup");
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) { const error = new Error("Setup cancelled"); error.name = "AbortError"; reject(error); return; }
    const child = spawn(command, {
      shell: true, detached: process.platform !== "win32",
      cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let failure: Error | undefined;
    const collect = (data: Buffer) => {
      output = (output + data.toString("utf8")).slice(-4 * 1024 * 1024);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    if (options.stdio === "inherit") {
      child.stdout.pipe(process.stdout, { end: false });
      child.stderr.pipe(process.stderr, { end: false });
    }
    const stop = (reason: string) => {
      failure = new Error(reason);
      failure.name = options.signal?.aborted ? "AbortError" : "TimeoutError";
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        killer.on("error", () => child.kill("SIGKILL"));
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }
    };
    const abort = () => stop("Setup cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = options.timeout ? setTimeout(() => stop(`Setup timed out after ${options.timeout}ms`), options.timeout) : undefined;
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Setup exited ${code ?? signal}: ${output.slice(-2000)}`));
      else resolve(output);
    });
  }).then(result => {
    trace.finish("completed");
    return result;
  }, error => {
    trace.error(error);
    trace.finish(options.signal?.aborted ? "cancelled" : "error");
    throw error;
  });
}
