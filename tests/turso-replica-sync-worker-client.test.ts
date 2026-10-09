import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TursoReplicaSyncWorkerClient,
  writeWorkerStdinLine,
} from "../src/gateway/services/tursoReplica/TursoReplicaSyncWorkerClient.js";
import { isTursoSyncWorkerCrash } from "../src/gateway/services/tursoReplica/tursoReplicaSyncWorkerProtocol.js";

/**
 * Stand-in workers. Each is a one-liner run by the same Node binary as the test, so the
 * client is exercised against a real child process, real pipes and real exit signals —
 * only the sync engine is faked.
 */
function fakeWorker(body: string): () => { command: string; args: string[] } {
  const script = `
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    const reply = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    rl.on("line", (line) => {
      const req = JSON.parse(line);
      reply({ id: req.id, started: true });
      ${body}
    });
    process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
  `;
  return () => ({ command: process.execPath, args: ["-e", script] });
}

let tmpDir: string;
let localPath: string;

const spec = () => ({
  localPath,
  tursoUrl: "libsql://example.turso.io",
  authToken: "token",
  bootstrapIfEmpty: false,
  timeoutMs: 10_000,
});

describe("TursoReplicaSyncWorkerClient", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-worker-client-"));
    localPath = path.join(tmpDir, "data.db");
    fs.writeFileSync(localPath, "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resolves with the worker's pull result", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`reply({ id: req.id, ok: true, result: { pulled: true } });`),
    );
    expect(client.ownsPath(localPath)).toBe(false);
    await expect(client.sync(spec(), "pull")).resolves.toBe(true);
    expect(client.ownsPath(localPath)).toBe(true);
    await client.close(localPath);
    expect(client.ownsPath(localPath)).toBe(false);
    await client.sync(spec(), "pull");
    await client.shutdown();
    expect(client.ownsPath(localPath)).toBe(false);
  });

  it("treats a close that hangs as released: the worker is killed, repair can proceed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const client = new TursoReplicaSyncWorkerClient(
        fakeWorker(`if (req.op !== "close") reply({ id: req.id, ok: true, result: { pulled: true } });`),
      );
      vi.useRealTimers();
      await client.sync(spec(), "pull");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const closing = client.close(localPath);
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(closing).resolves.toBeUndefined();
      expect(client.ownsPath(localPath)).toBe(false);
      vi.useRealTimers();
      await client.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns query rows and write metrics through the typed helpers", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`
        if (req.op === "query") reply({ id: req.id, ok: true, result: { rows: [{ a: 1 }] } });
        else if (req.op === "queryBatch") reply({ id: req.id, ok: true, result: { results: [{ rows: [{ a: 1 }] }, { rows: [{ b: 2 }] }] } });
        else if (req.op === "write") reply({ id: req.id, ok: true, result: { changes: 2, lastInsertRowid: 9 } });
        else reply({ id: req.id, ok: true, result: {} });
      `),
    );
    await expect(client.query({ ...spec(), sql: "select 1" })).resolves.toEqual({
      rows: [{ a: 1 }],
    });
    await expect(
      client.queryBatch({
        ...spec(),
        statements: [{ sql: "select 1" }, { sql: "select 2" }],
      }),
    ).resolves.toEqual({
      results: [{ rows: [{ a: 1 }] }, { rows: [{ b: 2 }] }],
    });
    await expect(
      client.write({ ...spec(), statements: [{ sql: "insert" }] }),
    ).resolves.toEqual({ changes: 2, lastInsertRowid: 9 });
    await client.shutdown();
  });

  it("surfaces a worker-reported failure as a plain error, not a crash", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`reply({ id: req.id, ok: false, error: "remote rejected push" });`),
    );
    // This distinction drives recovery: a returned error must not trigger a sidecar reset.
    await expect(client.sync(spec(), "push")).rejects.toThrow("remote rejected push");
    await expect(client.sync(spec(), "push")).rejects.toSatisfy(
      (error: unknown) => !isTursoSyncWorkerCrash(error),
    );
    await client.shutdown();
  });

  it("recovers from a native abort: resets sidecars, respawns, retries idempotent ops once", async () => {
    // Leave a sidecar behind so we can observe the reset.
    fs.writeFileSync(`${localPath}-wal`, "x");
    let spawnCount = 0;
    const crashOnce = fakeWorker(`process.abort();`);
    const healthy = fakeWorker(`reply({ id: req.id, ok: true, result: { pulled: true } });`);
    const client = new TursoReplicaSyncWorkerClient(() => {
      spawnCount += 1;
      return spawnCount === 1 ? crashOnce() : healthy();
    });
    const crashes: unknown[] = [];
    client.onCrash((e) => crashes.push(e));

    // Caller never sees the crash — the client handled it.
    await expect(client.sync(spec(), "pull")).resolves.toBe(true);
    expect(spawnCount).toBe(2);
    expect(crashes).toHaveLength(1);
    expect(fs.existsSync(`${localPath}-wal`)).toBe(false);
    await client.shutdown();
  });

  it("treats a worker killed during close as a released handle, not an error", async () => {
    // e.g. SIGKILL from outside (a job clearing a lock) landing mid-close. The process that
    // held the file is gone, so the release happened; the caller must not see a crash.
    let spawnCount = 0;
    const client = new TursoReplicaSyncWorkerClient(() => {
      spawnCount += 1;
      return fakeWorker(
        `if (req.op === "close") process.kill(process.pid, "SIGKILL"); ` +
          `else reply({ id: req.id, ok: true, result: { pulled: true } });`,
      )();
    });
    await client.sync(spec(), "pull");
    expect(client.ownsPath(localPath)).toBe(true);
    await expect(client.close(localPath)).resolves.toBeUndefined();
    expect(client.ownsPath(localPath)).toBe(false);
    // The next request respawns a healthy worker rather than being parked.
    await expect(client.sync(spec(), "pull")).resolves.toBe(true);
    expect(spawnCount).toBe(2);
    await client.shutdown();
  });

  it("does not retry non-idempotent ops after a crash", async () => {
    let spawnCount = 0;
    const client = new TursoReplicaSyncWorkerClient(() => {
      spawnCount += 1;
      return fakeWorker(`process.abort();`)();
    });
    const error = await client
      .write({ ...spec(), statements: [{ sql: "insert" }] })
      .catch((e: unknown) => e);
    expect(isTursoSyncWorkerCrash(error)).toBe(true);
    expect((error as Error).message).toContain("crashed during write");
    expect(spawnCount).toBe(1);
    await client.shutdown();
  });

  it("gives up after a second consecutive crash", async () => {
    let spawnCount = 0;
    const client = new TursoReplicaSyncWorkerClient(() => {
      spawnCount += 1;
      return fakeWorker(`process.abort();`)();
    });
    const error = await client.sync(spec(), "pull").catch((e: unknown) => e);
    expect(isTursoSyncWorkerCrash(error)).toBe(true);
    expect(spawnCount).toBe(2);
    await client.shutdown();
  });

  it("rejects stdin write failures (EPIPE) on the pending op, not as uncaught", async () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const stdin = {
      once(event: string, fn: (err: Error) => void) {
        if (event === "error") this.errorListener = fn;
      },
      removeListener() {},
      write(_line: string, cb?: (err?: Error | null) => void) {
        if (typeof cb === "function") {
          cb(epipe);
        }
        return true;
      },
      errorListener: undefined as ((err: Error) => void) | undefined,
    } as unknown as NodeJS.WritableStream;

    await expect(writeWorkerStdinLine(stdin, '{"id":"1"}\n')).rejects.toMatchObject({
      code: "EPIPE",
    });
  });

  it("times out and drops a worker that never replies", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`/* swallow the request */`),
    );
    await expect(
      client.sync({ ...spec(), timeoutMs: 150 }, "pull"),
    ).rejects.toThrow(/timed out after 150ms/);
    // A hung engine must not leave the worker holding the replica forever.
    expect(client.isRunning()).toBe(false);
    await client.shutdown();
  });

  it("a timeout on one database is not counted as a crash on others in flight", async () => {
    // One shared worker serves every replica. When a slow op on database A times out, the
    // client SIGKILLs the worker; a write on database B in flight at that moment used to be
    // reported as an engine abort on B — sidecar reset, streak bump, and after three such
    // timeouts B was parked for the session though nothing was wrong with it.
    const other = path.join(tmpDir, "other.db");
    fs.writeFileSync(other, "");
    fs.writeFileSync(`${other}-wal`, "keep");
    let spawnCount = 0;
    const client = new TursoReplicaSyncWorkerClient(() => {
      spawnCount += 1;
      // A hangs; B never answers either (so it is in flight when A's timer fires).
      return fakeWorker(`if (spawnCount_ok(req)) reply({ id: req.id, ok: true, result: { pulled: true } });`
        .replace("spawnCount_ok(req)", spawnCount > 1 ? "true" : "false"))();
    });
    const crashes: unknown[] = [];
    client.onCrash((e) => crashes.push(e));

    for (let i = 0; i < 3; i += 1) {
      spawnCount = 0;
      const slow = client.sync({ ...spec(), timeoutMs: 150 }, "pull");
      const write = client
        .write({ ...spec(), localPath: other, timeoutMs: 5_000, statements: [{ sql: "insert" }] })
        .catch((e: unknown) => e);
      await expect(slow).rejects.toThrow(/timed out after 150ms/);
      const error = await write;
      expect(isTursoSyncWorkerCrash(error)).toBe(false);
      expect((error as Error).message).toMatch(/restarted during write.*was not at fault/);
    }
    expect(crashes).toHaveLength(0);
    // B's sync state was not reset, and B still opens: no park after three timeouts.
    expect(fs.readFileSync(`${other}-wal`, "utf8")).toBe("keep");
    spawnCount = 1;
    await expect(client.sync({ ...spec(), localPath: other }, "pull")).resolves.toBe(true);
    await client.shutdown();
  });

  it("retries an idempotent op that was collateral of another database's timeout", async () => {
    let spawnCount = 0;
    const client = new TursoReplicaSyncWorkerClient(() => {
      spawnCount += 1;
      return fakeWorker(spawnCount === 1 ? `/* hang */` : `reply({ id: req.id, ok: true, result: { rows: [{ a: 1 }] } });`)();
    });
    const other = path.join(tmpDir, "other.db");
    const slow = client.sync({ ...spec(), timeoutMs: 150 }, "pull").catch((e: unknown) => e);
    const read = client.query({ ...spec(), localPath: other, timeoutMs: 5_000, sql: "select 1" });
    await expect(read).resolves.toEqual({ rows: [{ a: 1 }] });
    expect(String(await slow)).toMatch(/timed out/);
    expect(spawnCount).toBe(2);
    await client.shutdown();
  });

  it("ignores non-protocol stdout instead of desyncing", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`
        process.stdout.write("native engine chatter\\n");
        process.stdout.write("{not json\\n");
        reply({ id: req.id, ok: true, result: { pulled: false } });
      `),
    );
    await expect(client.sync(spec(), "pull")).resolves.toBe(false);
    await client.shutdown();
  });

  it("rejects in-flight requests on shutdown without reporting a crash", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`if (req.op === "connect") reply({ id: req.id, ok: true, result: {} }); /* else hang */`),
    );
    // Boot the worker first so the request is genuinely in flight, not mid-boot.
    await client.connect(spec());
    const inflight = client.sync(spec(), "pull").catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.shutdown();
    const error = await inflight;
    // Shutdown must never masquerade as an engine crash — that would trigger sidecar reset.
    expect(isTursoSyncWorkerCrash(error)).toBe(false);
    expect((error as Error).message).toContain("shutting down");
  });
});
