import { describe, expect, it } from "vitest";
import { TursoReplicaSyncWorkerClient } from "../src/gateway/services/tursoReplica/TursoReplicaSyncWorkerClient.js";
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
      ${body}
    });
    process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
  `;
  return () => ({ command: process.execPath, args: ["-e", script] });
}

const REQUEST = {
  op: "pull" as const,
  localPath: "/tmp/does-not-need-to-exist/data.db",
  tursoUrl: "libsql://example.turso.io",
  authToken: "token",
  bootstrapIfEmpty: false,
  timeoutMs: 10_000,
};

describe("TursoReplicaSyncWorkerClient", () => {
  it("resolves with the worker's pull result", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`reply({ id: req.id, ok: true, pulled: true });`),
    );

    await expect(client.runSync(REQUEST)).resolves.toBe(true);
    await client.shutdown();
  });

  it("surfaces a worker-reported failure as a plain error, not a crash", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`reply({ id: req.id, ok: false, error: "remote rejected push" });`),
    );

    // This distinction drives recovery: a returned error must not trigger a sidecar reset.
    await expect(client.runSync(REQUEST)).rejects.toThrow("remote rejected push");
    await expect(client.runSync(REQUEST)).rejects.toSatisfy(
      (error: unknown) => !isTursoSyncWorkerCrash(error),
    );
    await client.shutdown();
  });

  it("reports a native abort as a crash rather than hanging", async () => {
    // process.abort() raises SIGABRT — the same way a Rust panic in the engine ends up.
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`process.abort();`),
    );

    const error = await client.runSync(REQUEST).catch((e: unknown) => e);

    expect(isTursoSyncWorkerCrash(error)).toBe(true);
    expect((error as Error).message).toContain("crashed during pull");
    await client.shutdown();
  });

  it("recovers by spawning a fresh worker after a crash", async () => {
    let spawnCount = 0;
    const crashOnce = fakeWorker(`process.abort();`);
    const healthy = fakeWorker(`reply({ id: req.id, ok: true, pulled: true });`);

    const client = new TursoReplicaSyncWorkerClient(() => {
      spawnCount += 1;
      return spawnCount === 1 ? crashOnce() : healthy();
    });

    await expect(client.runSync(REQUEST)).rejects.toThrow(/crashed/);
    // The retry must not be stuck talking to the dead child.
    await expect(client.runSync(REQUEST)).resolves.toBe(true);
    expect(spawnCount).toBe(2);

    await client.shutdown();
  });

  it("times out and drops a worker that never replies", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`/* swallow the request */`),
    );

    await expect(
      client.runSync({ ...REQUEST, timeoutMs: 150 }),
    ).rejects.toThrow(/timed out after 150ms/);

    // A hung engine must not leave the worker holding the replica forever.
    expect(client.isRunning()).toBe(false);
    await client.shutdown();
  });

  it("ignores non-protocol stdout instead of desyncing", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`
        process.stdout.write("native engine chatter\\n");
        process.stdout.write("{not json\\n");
        reply({ id: req.id, ok: true, pulled: false });
      `),
    );

    await expect(client.runSync(REQUEST)).resolves.toBe(false);
    await client.shutdown();
  });

  it("rejects in-flight requests on shutdown without reporting a crash", async () => {
    const client = new TursoReplicaSyncWorkerClient(
      fakeWorker(`/* never replies */`),
    );

    const inflight = client.runSync(REQUEST).catch((e: unknown) => e);
    // Let the request reach the worker before tearing it down.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.shutdown();

    const error = await inflight;
    expect(isTursoSyncWorkerCrash(error)).toBe(false);
    expect((error as Error).message).toContain("shutting down");
  });
});
