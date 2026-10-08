import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { runSetupCommand } from "../../../../core/utils/runSetupCommand.js";
import { getVenvPaths } from "../../../../core/utils/platform.js";
import {
  MissingDependencyError,
  findMissingTools,
  type MissingDependencyItem,
} from "./missingDependency.js";
import {
  nodeRuntimeKey,
  readJobRuntimeSpec,
  type JobRuntimeSpec,
} from "./jobRuntimeSpec.js";

type SetupRunner = (
  command: string,
  options: Parameters<typeof runSetupCommand>[1],
) => Promise<string>;

export interface EnsureJobRuntimeParams {
  jobDir: string;
  jobType: string;
  /** Env used for setup commands and as the PATH base (e.g. nvm-aware env). */
  baseEnv: NodeJS.ProcessEnv;
  appendLog: (line: string) => Promise<void> | void;
  signal?: AbortSignal;
  /** Resolves the interpreter used to create the venv (handles Windows `python`/`py`). */
  pythonCommand: () => Promise<string>;
  /** Python-type jobs always get a venv, even with no requirements (legacy behaviour). */
  forcePythonVenv?: boolean;
  /** Where hash-keyed shared node runtimes live: <root>/runtimes/node/<hash>. */
  runtimesRoot: string;
  runSetup?: SetupRunner;
}

export interface JobRuntime {
  /** Only the keys the runtime changes (PATH, VIRTUAL_ENV, NODE_PATH). Merge over the job env. */
  env: Record<string, string>;
  spec: JobRuntimeSpec;
}

/**
 * Shared runtimes are machine-local caches, so they live OUTSIDE the synced
 * workspace (git/cloud sync must never carry node_modules). Override with
 * PAPR_RUNTIMES_ROOT for tests and CI.
 */
export function defaultRuntimesRoot(): string {
  return process.env.PAPR_RUNTIMES_ROOT || path.join(homedir(), ".paprwork-v2");
}

function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

function venvBinDir(venvDir: string): string {
  return path.dirname(getVenvPaths(venvDir).python);
}

/**
 * Prepend the job's tool folders to PATH so a bare `python3`, `pip`, `vite`
 * resolves to the declared environment — for shell scripts and for the shell
 * an agent job's bash tool opens alike. No `source activate` wrapping needed.
 */
export function buildRuntimeEnv(
  jobDir: string,
  baseEnv: NodeJS.ProcessEnv,
  nodeRuntimeDir?: string,
): Record<string, string> {
  const key = pathKeyOf(baseEnv);
  const basePath = baseEnv[key] ?? process.env[key] ?? "";
  const prefix: string[] = [];
  const out: Record<string, string> = {};

  const venvDir = path.join(jobDir, ".venv");
  if (existsSync(venvDir)) {
    prefix.push(venvBinDir(venvDir));
    out.VIRTUAL_ENV = venvDir;
  }
  if (nodeRuntimeDir) {
    prefix.push(path.join(nodeRuntimeDir, "node_modules", ".bin"));
    out.NODE_PATH = path.join(nodeRuntimeDir, "node_modules");
  }
  if (prefix.length > 0) out[key] = [...prefix, basePath].filter(Boolean).join(path.delimiter);
  return out;
}

async function ensurePythonEnv(
  p: EnsureJobRuntimeParams,
  spec: JobRuntimeSpec,
  run: SetupRunner,
): Promise<MissingDependencyItem[]> {
  const venvDir = path.join(p.jobDir, ".venv");
  const marker = path.join(venvDir, ".requirements-installed");
  const failed: MissingDependencyItem[] = [];

  if (!existsSync(venvDir)) {
    await p.appendLog("Creating Python virtual environment...");
    try {
      const py = await p.pythonCommand();
      await run(`${py} -m venv .venv`, {
        diagnosticName: "python-venv",
        cwd: p.jobDir,
        signal: p.signal,
        timeout: 60_000,
        env: p.baseEnv,
      });
      await p.appendLog("Virtual environment created.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await p.appendLog(`Failed to create venv: ${message}`);
      return spec.pythonPackages.map((name) => ({
        kind: "python" as const,
        name,
        detail: "could not create a Python environment",
      }));
    }
  }

  if (spec.pythonPackages.length === 0) return failed;
  const merged = spec.pythonPackages.join("\n") + "\n";
  let installed = "";
  try {
    installed = readFileSync(marker, "utf8");
  } catch {
    installed = "";
  }
  if (installed === merged) {
    await p.appendLog("Requirements already installed (unchanged).");
    return failed;
  }

  await p.appendLog("Installing Python requirements...");
  const reqFile = path.join(venvDir, "requirements.merged.txt");
  writeFileSync(reqFile, merged, "utf8");
  try {
    const out = await run(`"${getVenvPaths(venvDir).pip}" install -r "${reqFile}" 2>&1`, {
      diagnosticName: "pip-install",
      cwd: p.jobDir,
      signal: p.signal,
      timeout: 300_000,
      encoding: "utf8",
      env: p.baseEnv,
    });
    await p.appendLog(`pip install output:\n${out.trim().split("\n").slice(-5).join("\n")}`);
    writeFileSync(marker, merged, "utf8");
    await p.appendLog("Requirements installed successfully.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await p.appendLog(`pip install failed: ${message}`);
    const detail = message.trim().split("\n").slice(-2).join(" ").slice(0, 200);
    return spec.pythonPackages.map((name) => ({ kind: "python" as const, name, detail }));
  }
  return failed;
}

/** Shared, content-addressed node install: two jobs declaring the same packages reuse one folder. */
async function ensureNodeRuntime(
  p: EnsureJobRuntimeParams,
  packages: string[],
  run: SetupRunner,
): Promise<{ dir: string; failed: MissingDependencyItem[] }> {
  const dir = path.join(p.runtimesRoot, "runtimes", "node", nodeRuntimeKey(packages));
  const marker = path.join(dir, ".installed");
  if (existsSync(marker)) return { dir, failed: [] };

  await p.appendLog(`Installing Node packages: ${packages.join(", ")}...`);
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(path.join(dir, "package.json"))) {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "papr-job-runtime", private: true }),
      );
    }
    const args = packages.map((x) => `"${x}"`).join(" ");
    await run(`npm install --no-audit --no-fund --silent ${args} 2>&1`, {
      diagnosticName: "npm-install",
      cwd: dir,
      signal: p.signal,
      timeout: 300_000,
      encoding: "utf8",
      env: p.baseEnv,
    });
    writeFileSync(marker, packages.join("\n") + "\n", "utf8");
    await p.appendLog("Node packages installed.");
    return { dir, failed: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await p.appendLog(`npm install failed: ${message}`);
    const detail = message.trim().split("\n").slice(-2).join(" ").slice(0, 200);
    return { dir, failed: packages.map((name) => ({ kind: "node" as const, name, detail })) };
  }
}

/**
 * Make a job's declared runtime real before it launches — for EVERY job type
 * (bash, shell, python, node, agent), not just python/node.
 *
 * Throws MissingDependencyError for tools/packages that cannot be provided,
 * except Python-package install failures on legacy `python` jobs, which keep
 * the old "log and let the job try" behaviour.
 */
export async function ensureJobRuntime(p: EnsureJobRuntimeParams): Promise<JobRuntime> {
  const run = p.runSetup ?? runSetupCommand;
  const spec = readJobRuntimeSpec(p.jobDir);
  const problems: MissingDependencyItem[] = [];

  if (spec.pythonPackages.length > 0 || p.forcePythonVenv) {
    const failed = await ensurePythonEnv(p, spec, run);
    if (p.jobType !== "python") problems.push(...failed);
  }

  let nodeDir: string | undefined;
  if (spec.nodePackages.length > 0) {
    const node = await ensureNodeRuntime(p, spec.nodePackages, run);
    nodeDir = node.dir;
    problems.push(...node.failed);
  }

  const env = buildRuntimeEnv(p.jobDir, p.baseEnv, nodeDir);
  const pathValue = env[pathKeyOf(p.baseEnv)] ?? p.baseEnv[pathKeyOf(p.baseEnv)] ?? "";
  problems.push(...findMissingTools(spec.tools, pathValue));

  if (problems.length > 0) {
    const error = new MissingDependencyError(problems);
    await p.appendLog(error.toLogLine());
    throw error;
  }
  return { env, spec };
}
