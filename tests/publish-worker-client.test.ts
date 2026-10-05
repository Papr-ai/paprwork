import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mockRequeue = vi.fn().mockResolvedValue(1);
vi.mock("../src/gateway/services/syncV3/SyncOutbox.js", () => ({
  requeueOrphanedInflightOutboxEntries: (...args: unknown[]) => mockRequeue(...args),
}));

import {
  PublishWorkerClient,
  PublishWorkerRequestError,
} from "../src/gateway/services/publishWorker/PublishWorkerClient.js";

/** Fake worker: a plain node script speaking the line protocol. */
async function fakeWorker(body: string): Promise<{ command: string; args: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pubworker-"));
  const file = path.join(dir, "worker.mjs");
  await fs.writeFile(
    file,
    `
import * as readline from "node:readline";
const emit = (l) => process.stdout.write(JSON.stringify(l) + "\\n");
emit({ ready: true, pid: process.pid });
readline.createInterface({ input: process.stdin }).on("line", async (raw) => {
  const req = JSON.parse(raw);
  ${body}
});
`,
  );
  return { command: process.execPath, args: [file] };
}

const REQ = { appId: "app-1", paprDir: "/tmp/x", apiKey: "k" };
let client: PublishWorkerClient | null = null;

afterEach(() => {
  client?.stop();
  client = null;
  mockRequeue.mockClear();
});

describe("PublishWorkerClient", () => {
  it("streams progress and resolves with synced paths + commit events", async () => {
    const cmd = await fakeWorker(`
      emit({ id: req.id, progress: { label: "Finding changed files…" } });
      emit({ id: req.id, progress: { label: "Uploading 2 files…" } });
      emit({ id: req.id, ok: true, durationMs: 5,
        result: { appId: req.appId, commitSha: "abc", filesSent: 2, skippedUnchanged: 0, outboxReplayed: 0, deferred: 0 },
        syncedPaths: ["apps/app-1/index.html"], ownCommits: ["abc"],
        committed: [{ appId: req.appId, commitSha: "abc", githubOrg: "o", repoName: "r", namespaceId: "n", committedAt: "t" }] });
    `);
    client = new PublishWorkerClient(() => cmd);
    const labels: string[] = [];
    const line = await client.push(REQ, (label) => labels.push(label));
    expect(labels).toEqual(["Finding changed files…", "Uploading 2 files…"]);
    expect(line.result.commitSha).toBe("abc");
    expect(line.syncedPaths).toEqual(["apps/app-1/index.html"]);
    expect(line.committed).toHaveLength(1);
    expect(client.getStatus().recent.at(-1)).toMatchObject({ appId: "app-1", ok: true });
  });

  it("runs several uploads at once in one worker", async () => {
    const cmd = await fakeWorker(`
      setTimeout(() => emit({ id: req.id, ok: true, durationMs: 300,
        result: { appId: req.appId, filesSent: 1, skippedUnchanged: 0, outboxReplayed: 0, deferred: 0 },
        syncedPaths: [], committed: [] }), 300);
    `);
    client = new PublishWorkerClient(() => cmd);
    await client.push({ ...REQ, appId: "warmup" }); // boot outside the timing
    const started = Date.now();
    await Promise.all(["a", "b", "c", "d"].map((appId) => client!.push({ ...REQ, appId })));
    expect(Date.now() - started).toBeLessThan(900); // 4×300ms serial would be 1200ms
  });

  it("rebuilds the worker's error so callers can tell conflicts apart", async () => {
    const cmd = await fakeWorker(`
      emit({ id: req.id, ok: false, durationMs: 1, error: {
        name: "AppOpsConflictError", message: "Writer conflict", appId: req.appId,
        artifacts: [{ path: "index.html", expectedParentHash: "x", actualBlobOid: "y" }] } });
    `);
    client = new PublishWorkerClient(() => cmd);
    const err = await client.push(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(PublishWorkerRequestError);
    expect(err.name).toBe("AppOpsConflictError");
    expect(err.detail.artifacts).toHaveLength(1);
  });

  it("a crash fails only in-flight uploads, requeues their outbox, and respawns", async () => {
    const cmd = await fakeWorker(`
      if (req.appId === "crash") process.exit(9);
      emit({ id: req.id, ok: true, durationMs: 1,
        result: { appId: req.appId, filesSent: 0, skippedUnchanged: 0, outboxReplayed: 0, deferred: 0 },
        syncedPaths: [], committed: [] });
    `);
    client = new PublishWorkerClient(() => cmd);
    const firstPid = (await client.push(REQ), client.getStatus().pid);
    const err = await client.push({ ...REQ, appId: "crash" }).catch((e) => e);
    expect(String(err.message)).toMatch(/Publish worker stopped/);
    await vi.waitFor(() => expect(mockRequeue).toHaveBeenCalledWith(["crash"]));
    expect(client.getStatus()).toMatchObject({ restarts: 1, running: false });

    const after = await client.push(REQ);
    expect(after.result.appId).toBe("app-1");
    expect(client.getStatus().pid).not.toBe(firstPid);
  });
});
