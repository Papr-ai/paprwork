import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { readJobRuntimeSpec, nodeRuntimeKey } from "../src/gateway/services/jobs/runtime/jobRuntimeSpec.js";
import {
  MissingDependencyError,
  findMissingTools,
  findOnPath,
} from "../src/gateway/services/jobs/runtime/missingDependency.js";
import { buildRuntimeEnv, ensureJobRuntime } from "../src/gateway/services/jobs/runtime/jobRuntime.js";
import { classifyError } from "../src/gateway/services/jobs/errorClassifier.js";

let jobDir: string;
let root: string;
const logs: string[] = [];
const appendLog = (l: string) => void logs.push(l);

/** Fake installer: records commands and fabricates the venv layout. */
function fakeSetup(opts: { failPip?: boolean; failNpm?: boolean } = {}) {
  const calls: string[] = [];
  const run = async (cmd: string, o?: { cwd?: string }) => {
    calls.push(cmd);
    if (cmd.includes("-m venv")) {
      mkdirSync(path.join(o!.cwd!, ".venv", process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
    }
    if (cmd.includes("pip") && opts.failPip) throw new Error("ERROR: No matching distribution found for numpy");
    if (cmd.startsWith("npm") && opts.failNpm) throw new Error("npm ERR! 404");
    return "ok";
  };
  return { run, calls };
}

const base = (extra: Record<string, unknown> = {}) => ({
  jobDir,
  jobType: "bash",
  baseEnv: { PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv,
  appendLog,
  pythonCommand: async () => "python3",
  runtimesRoot: root,
  ...extra,
});

beforeEach(() => {
  jobDir = mkdtempSync(path.join(tmpdir(), "job-rt-"));
  root = mkdtempSync(path.join(tmpdir(), "rt-root-"));
  logs.length = 0;
});
afterEach(() => {
  rmSync(jobDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("readJobRuntimeSpec", () => {
  it("merges requirements.txt and runtime.json, ignoring comments and duplicates", () => {
    writeFileSync(path.join(jobDir, "requirements.txt"), "numpy\n# note\npillow  # img\n\nnumpy\n");
    writeFileSync(
      path.join(jobDir, "runtime.json"),
      JSON.stringify({ python: ["requests"], node: ["vite@5"], tools: ["ffmpeg"] }),
    );
    expect(readJobRuntimeSpec(jobDir)).toEqual({
      pythonPackages: ["numpy", "pillow", "requests"],
      nodePackages: ["vite@5"],
      tools: ["ffmpeg"],
    });
  });

  it("treats a malformed runtime.json as empty instead of bricking the job", () => {
    writeFileSync(path.join(jobDir, "runtime.json"), "{not json");
    expect(readJobRuntimeSpec(jobDir)).toEqual({ pythonPackages: [], nodePackages: [], tools: [] });
  });

  it("node runtime key is order-independent (shared across jobs)", () => {
    expect(nodeRuntimeKey(["a", "b"])).toBe(nodeRuntimeKey(["b", "a"]));
    expect(nodeRuntimeKey(["a"])).not.toBe(nodeRuntimeKey(["b"]));
  });
});

describe("tool detection", () => {
  it("finds node on the real PATH and reports unknown tools with no hint", () => {
    expect(findOnPath("node", process.env.PATH ?? "")).toBeTruthy();
    const [m] = findMissingTools(["definitely-not-a-real-tool-xyz"], process.env.PATH ?? "");
    expect(m).toMatchObject({ kind: "tool", name: "definitely-not-a-real-tool-xyz" });
    expect(m.installHint).toBeUndefined();
  });

  it("gives an install hint for known tools", () => {
    const [m] = findMissingTools(["ffmpeg"], "");
    expect(m.name).toBe("ffmpeg");
    if (["darwin", "win32", "linux"].includes(process.platform)) expect(m.installHint).toMatch(/ffmpeg|FFmpeg/);
  });
});

describe("ensureJobRuntime", () => {
  it("does nothing for a job that declares nothing", async () => {
    const s = fakeSetup();
    const rt = await ensureJobRuntime({ ...base(), runSetup: s.run as never });
    expect(s.calls).toEqual([]);
    expect(rt.env).toEqual({});
  });

  it("builds a venv + installs for a BASH job (previously ignored) and puts it first on PATH", async () => {
    writeFileSync(path.join(jobDir, "requirements.txt"), "numpy\npillow\n");
    const s = fakeSetup();
    const rt = await ensureJobRuntime({ ...base(), runSetup: s.run as never });
    expect(s.calls.some((c) => c.includes("-m venv"))).toBe(true);
    expect(s.calls.some((c) => c.includes("pip") && c.includes("install"))).toBe(true);
    expect(rt.env.VIRTUAL_ENV).toBe(path.join(jobDir, ".venv"));
    expect(rt.env.PATH.startsWith(path.join(jobDir, ".venv"))).toBe(true);
    expect(rt.env.PATH).toContain(process.env.PATH!);
  });

  it("does not reinstall when requirements are unchanged, and reinstalls when they change", async () => {
    writeFileSync(path.join(jobDir, "requirements.txt"), "numpy\n");
    const first = fakeSetup();
    await ensureJobRuntime({ ...base(), runSetup: first.run as never });
    const second = fakeSetup();
    await ensureJobRuntime({ ...base(), runSetup: second.run as never });
    expect(second.calls).toEqual([]);

    writeFileSync(path.join(jobDir, "requirements.txt"), "numpy\npillow\n");
    const third = fakeSetup();
    await ensureJobRuntime({ ...base(), runSetup: third.run as never });
    expect(third.calls.filter((c) => c.includes("pip"))).toHaveLength(1);
  });

  it("fails a bash job with a structured missing_dependency when pip fails", async () => {
    writeFileSync(path.join(jobDir, "requirements.txt"), "numpy\n");
    const s = fakeSetup({ failPip: true });
    const err = await ensureJobRuntime({ ...base(), runSetup: s.run as never }).catch((e) => e);
    expect(err).toBeInstanceOf(MissingDependencyError);
    expect(err.code).toBe("missing_dependency");
    expect(err.items[0]).toMatchObject({ kind: "python", name: "numpy" });
    expect(logs.some((l) => l.startsWith("PAPR_ERROR ") && l.includes("missing_dependency"))).toBe(true);
    expect(classifyError(err)).toBe("permanent");
  });

  it("keeps legacy behaviour for python jobs: pip failure is logged, job still launches", async () => {
    writeFileSync(path.join(jobDir, "requirements.txt"), "numpy\n");
    const s = fakeSetup({ failPip: true });
    await expect(
      ensureJobRuntime({ ...base({ jobType: "python", forcePythonVenv: true }), runSetup: s.run as never }),
    ).resolves.toBeTruthy();
    expect(logs.some((l) => l.includes("pip install failed"))).toBe(true);
  });

  it("fails fast on a declared tool that is not installed, with an install hint", async () => {
    writeFileSync(path.join(jobDir, "runtime.json"), JSON.stringify({ tools: ["ffmpeg"] }));
    const err = await ensureJobRuntime({
      ...base({ baseEnv: { PATH: "" } }),
      runSetup: fakeSetup().run as never,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MissingDependencyError);
    expect(err.message).toContain("ffmpeg");
    expect(err.items[0].kind).toBe("tool");
  });

  it("installs declared node packages into a shared, hash-keyed runtime outside the job", async () => {
    writeFileSync(path.join(jobDir, "runtime.json"), JSON.stringify({ node: ["vite@5"] }));
    const s = fakeSetup();
    const rt = await ensureJobRuntime({ ...base(), runSetup: s.run as never });
    const dir = path.join(root, "runtimes", "node", nodeRuntimeKey(["vite@5"]));
    expect(s.calls.some((c) => c.startsWith("npm install") && c.includes("vite@5"))).toBe(true);
    expect(rt.env.NODE_PATH).toBe(path.join(dir, "node_modules"));
    expect(rt.env.PATH.startsWith(path.join(dir, "node_modules", ".bin"))).toBe(true);
    expect(readFileSync(path.join(dir, ".installed"), "utf8")).toContain("vite@5");

    const again = fakeSetup();
    await ensureJobRuntime({ ...base(), runSetup: again.run as never });
    expect(again.calls).toEqual([]); // second job/run reuses it
  });
});

describe("buildRuntimeEnv", () => {
  it("returns nothing when there is no venv or node runtime", () => {
    expect(buildRuntimeEnv(jobDir, { PATH: "/usr/bin" })).toEqual({});
  });
});
