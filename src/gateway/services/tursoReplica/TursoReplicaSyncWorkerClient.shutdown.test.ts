import { describe, expect, it } from "vitest";
import { TursoReplicaSyncWorkerClient } from "./TursoReplicaSyncWorkerClient.js";

/**
 * Stand-in for a worker wedged in a native `SyncEngine.close`: it boots, then ignores
 * SIGTERM forever. Its replica files stay locked until the process is gone.
 */
const WEDGED_WORKER = `
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const r = JSON.parse(l);
  process.stdout.write(JSON.stringify({ id: r.id, ok: true, result: { cdcOperations: process.pid } }) + "\\n");
});
setInterval(() => {}, 1 << 30);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function client(): TursoReplicaSyncWorkerClient {
  return new TursoReplicaSyncWorkerClient(() => ({
    command: process.execPath,
    args: ["-e", WEDGED_WORKER],
  }));
}

const spec = { localPath: "/tmp/x/data.db", tursoUrl: "", authToken: "", bootstrapIfEmpty: false, timeoutMs: 5_000 };

describe("TursoReplicaSyncWorkerClient shutdown", () => {
  it("SIGKILLs a worker that ignores SIGTERM, so it cannot keep replica locks", async () => {
    const c = client();
    const pid = await c.stats(spec);
    expect(isAlive(pid)).toBe(true);

    await c.shutdown();

    expect(isAlive(pid)).toBe(false);
  }, 15_000);

  it("a retired worker's exit does not disturb its replacement", async () => {
    const c = client();
    const first = await c.stats(spec);
    await c.shutdown();
    const second = await c.stats(spec);

    expect(second).not.toBe(first);
    expect(c.isRunning()).toBe(true);
    expect(await c.stats(spec)).toBe(second);
    await c.shutdown();
    expect(isAlive(second)).toBe(false);
  }, 20_000);
});
