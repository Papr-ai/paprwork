import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jobWriteDatabaseEnv } from "../../src/gateway/services/jobAppDatabase.js";

const SDK = path.resolve(__dirname, "../../src/resources/job-sdk");

/** Run papr_db._resolve(name) in a real Python process with the job env. */
function resolveInPython(env: Record<string, string>, name: string) {
  const code = `import papr_db\ntry:\n  print("OK", papr_db._resolve(${JSON.stringify(name)})[2])\nexcept Exception as e:\n  print("ERR", e)`;
  const r = spawnSync("python3", ["-c", code], {
    env: { PATH: process.env.PATH ?? "", PYTHONPATH: SDK, ...env },
    encoding: "utf8",
  });
  return (r.stdout || r.stderr).trim();
}

const target = {
  dbId: "db-dd324c54",
  alias: "Perf 459",
  dbPath: "/tmp/perf-459/data.db",
  envKey: "PERF_459",
  syncMode: "replica" as const,
  appAliases: ["perf"],
};

describe("job database names", () => {
  it("exports the app's alias next to the registry label", () => {
    const env = jobWriteDatabaseEnv([target], "app-1");
    expect(env.PAPR_DB_PERF_459_ALIAS).toBe("Perf 459");
    expect(env.PAPR_DB_PERF_459_ID).toBe("db-dd324c54");
    expect(env.PAPR_DB_PERF_459_APP_ALIASES).toBe("perf");
  });

  it("omits the app alias var when the app uses the label", () => {
    const env = jobWriteDatabaseEnv([{ ...target, appAliases: undefined }], "app-1");
    expect(env.PAPR_DB_PERF_459_APP_ALIASES).toBeUndefined();
  });

  it("papr_db resolves the label, the dbId and the app alias to the same database", () => {
    const env = jobWriteDatabaseEnv([target], "app-1");
    for (const name of ["Perf 459", "db-dd324c54", "perf"]) {
      // The gateway proxy is always sent the registry label.
      expect(resolveInPython(env, name)).toBe("OK Perf 459");
    }
    expect(resolveInPython(env, "nope")).toMatch(/^ERR No linked database with alias "nope"\. Linked: Perf 459, perf$/);
  });
});
