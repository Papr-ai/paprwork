/**
 * Guardrails that keep the writer outbox drainable.
 *
 * A 1.6GB outbox aborted the gateway on every launch: entries carry file
 * contents inline, one line had grown to ~520MB, and the queue was read whole
 * with fs.readFile. These tests pin the three properties that prevent it —
 * bounded reads, a cap at enqueue, and attempts that advance even when a push
 * never returns.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getPaprRoot } from "../src/core/utils/paprRoot.js";
import { SYNC_OUTBOX_FILENAME } from "../src/core/types/appRepoWriterOps.js";
import {
  appendOutboxEntry,
  clearSyncOutboxForTests,
  listOutboxEntries,
  listPendingOutboxEntries,
  markOutboxDeadLetter,
  markOutboxInflight,
  OutboxEntryTooLargeError,
} from "../src/gateway/services/syncV3/SyncOutbox.js";
import {
  compactJsonlDroppingOversized,
  MAX_OUTBOX_LINE_BYTES,
  readJsonlBounded,
} from "../src/gateway/services/syncV3/outboxFile.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

function outboxPath(): string {
  return path.join(getPaprRoot(), "data", SYNC_OUTBOX_FILENAME);
}

async function writeOutboxLines(lines: string[]): Promise<void> {
  const filePath = outboxPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((line) => `${line}\n`).join(""));
}

describe("readJsonlBounded", () => {
  useIsolatedPaprWorkspace("outbox-bounded-read");

  afterEach(async () => {
    await clearSyncOutboxForTests();
  });

  it("returns lines under the cap and reports oversized ones", async () => {
    const small = JSON.stringify({ id: "a" });
    const huge = JSON.stringify({ id: "b", blob: "x".repeat(4096) });
    await writeOutboxLines([small, huge, small]);

    const { lines, oversized } = await readJsonlBounded(outboxPath(), 1024);

    expect(lines).toEqual([small, small]);
    expect(oversized).toHaveLength(1);
    expect(oversized[0].lineNumber).toBe(2);
    expect(oversized[0].byteLength).toBeGreaterThan(1024);
  });

  it("reads a line that spans many stream chunks", async () => {
    // Larger than the 64KB default read chunk, so line assembly is exercised.
    const long = JSON.stringify({ id: "a", blob: "y".repeat(200_000) });
    await writeOutboxLines([long]);

    const { lines, oversized } = await readJsonlBounded(outboxPath());

    expect(oversized).toEqual([]);
    expect(JSON.parse(lines[0])).toEqual(JSON.parse(long));
  });

  it("handles multi-byte characters split across chunks", async () => {
    const line = JSON.stringify({ id: "a", blob: "é".repeat(100_000) });
    await writeOutboxLines([line]);

    const { lines } = await readJsonlBounded(outboxPath());

    expect(JSON.parse(lines[0])).toEqual(JSON.parse(line));
  });

  it("returns nothing for a missing file", async () => {
    const result = await readJsonlBounded(
      path.join(getPaprRoot(), "data", "does-not-exist.jsonl"),
    );
    expect(result).toEqual({ lines: [], oversized: [] });
  });

  it("tolerates a final line without a trailing newline", async () => {
    const filePath = outboxPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify({ id: "a" })}`);

    const { lines } = await readJsonlBounded(filePath);
    expect(lines).toHaveLength(1);
  });
});

describe("compactJsonlDroppingOversized", () => {
  useIsolatedPaprWorkspace("outbox-compaction");

  afterEach(async () => {
    await clearSyncOutboxForTests();
  });

  it("keeps small lines, moves oversized bytes to quarantine", async () => {
    const keep = JSON.stringify({ id: "keep" });
    const drop = JSON.stringify({ id: "drop", blob: "z".repeat(8192) });
    await writeOutboxLines([keep, drop, keep]);
    const quarantine = `${outboxPath()}.oversized`;

    const result = await compactJsonlDroppingOversized(outboxPath(), {
      maxLineBytes: 1024,
      quarantinePath: quarantine,
    });

    expect(result.keptLines).toBe(2);
    expect(result.quarantinedLines).toBe(1);

    const remaining = await fs.readFile(outboxPath(), "utf8");
    expect(remaining.trim().split("\n")).toEqual([keep, keep]);

    // The payload is preserved on disk rather than discarded.
    const quarantined = await fs.readFile(quarantine, "utf8");
    expect(JSON.parse(quarantined.trim())).toEqual(JSON.parse(drop));
  });

  it("leaves the file untouched when nothing is oversized", async () => {
    const keep = JSON.stringify({ id: "keep" });
    await writeOutboxLines([keep]);
    const before = await fs.readFile(outboxPath(), "utf8");

    const result = await compactJsonlDroppingOversized(outboxPath(), {
      maxLineBytes: MAX_OUTBOX_LINE_BYTES,
      quarantinePath: `${outboxPath()}.oversized`,
    });

    expect(result.quarantinedLines).toBe(0);
    expect(await fs.readFile(outboxPath(), "utf8")).toBe(before);
  });
});

describe("SyncOutbox guardrails", () => {
  useIsolatedPaprWorkspace("outbox-guardrails");

  afterEach(async () => {
    await clearSyncOutboxForTests();
  });

  it("refuses an op too large to push instead of queueing it", async () => {
    const oversized = "a".repeat(MAX_OUTBOX_LINE_BYTES + 1);

    await expect(
      appendOutboxEntry({
        appId: "app-1",
        files: [{ path: "big.bin", content: oversized, parentHash: "" }],
        author: "test",
        message: "too big",
      }),
    ).rejects.toThrow(OutboxEntryTooLargeError);

    // Nothing was written, so nothing can be retried forever.
    expect(await listOutboxEntries("app-1")).toEqual([]);
  });

  it("counts a claimed push as an attempt", async () => {
    const entry = await appendOutboxEntry({
      appId: "app-1",
      files: [{ path: "a.txt", content: "hello", parentHash: "" }],
      author: "test",
      message: "first",
    });
    expect(entry.attempts).toBe(0);

    // Simulates a push that never returns: the process dies while inflight.
    await markOutboxInflight(entry.id);
    await markOutboxInflight(entry.id);

    const [stored] = await listOutboxEntries("app-1");
    expect(stored.attempts).toBe(2);
  });

  it("drops the payload when dead-lettering but keeps the paths", async () => {
    const entry = await appendOutboxEntry({
      appId: "app-1",
      files: [
        { path: "a.txt", content: "x".repeat(50_000), parentHash: "" },
        { path: "b.txt", content: "y".repeat(50_000), parentHash: "" },
      ],
      author: "test",
      message: "doomed",
    });

    await markOutboxDeadLetter(entry.id, "rejected by writer");

    const [stored] = await listOutboxEntries("app-1");
    expect(stored.status).toBe("dead_letter");
    expect(stored.files).toEqual([]);
    expect(stored.droppedFileCount).toBe(2);
    expect(stored.droppedFilePaths).toEqual(["a.txt", "b.txt"]);

    // A dead letter must not keep occupying the queue's byte budget.
    const bytes = (await fs.stat(outboxPath())).size;
    expect(bytes).toBeLessThan(2_000);
  });

  it("replaces a pending entry the new one supersedes", async () => {
    const files = [{ path: "a.txt", content: "v1", parentHash: "" }];
    const first = await appendOutboxEntry({
      appId: "app-1",
      files,
      author: "test",
      message: "flush 1",
    });
    const second = await appendOutboxEntry({
      appId: "app-1",
      files: [{ path: "a.txt", content: "v2", parentHash: "" }],
      author: "test",
      message: "flush 2",
    });

    const pending = await listPendingOutboxEntries("app-1");
    expect(pending.map((entry) => entry.id)).toEqual([second.id]);
    expect(pending[0].files[0].content).toBe("v2");
    expect(pending.map((entry) => entry.id)).not.toContain(first.id);
  });

  it("keeps a pending entry covering paths the new one does not", async () => {
    const first = await appendOutboxEntry({
      appId: "app-1",
      files: [{ path: "a.txt", content: "v1", parentHash: "" }],
      author: "test",
      message: "flush 1",
    });
    const second = await appendOutboxEntry({
      appId: "app-1",
      files: [{ path: "b.txt", content: "v1", parentHash: "" }],
      author: "test",
      message: "flush 2",
    });

    const pending = await listPendingOutboxEntries("app-1");
    expect(pending.map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("does not supersede entries belonging to another app", async () => {
    const other = await appendOutboxEntry({
      appId: "app-2",
      files: [{ path: "a.txt", content: "v1", parentHash: "" }],
      author: "test",
      message: "other app",
    });
    await appendOutboxEntry({
      appId: "app-1",
      files: [{ path: "a.txt", content: "v2", parentHash: "" }],
      author: "test",
      message: "this app",
    });

    expect((await listPendingOutboxEntries("app-2")).map((e) => e.id)).toEqual([
      other.id,
    ]);
  });

  it("does not supersede an entry already inflight", async () => {
    const inflight = await appendOutboxEntry({
      appId: "app-1",
      files: [{ path: "a.txt", content: "v1", parentHash: "" }],
      author: "test",
      message: "inflight",
    });
    await markOutboxInflight(inflight.id);

    await appendOutboxEntry({
      appId: "app-1",
      files: [{ path: "a.txt", content: "v2", parentHash: "" }],
      author: "test",
      message: "next",
    });

    const all = await listOutboxEntries("app-1");
    expect(all).toHaveLength(2);
    expect(all.find((entry) => entry.id === inflight.id)?.status).toBe(
      "inflight",
    );
  });

  it("quarantines an oversized line already on disk so the queue drains", async () => {
    const good = await appendOutboxEntry({
      appId: "app-1",
      files: [{ path: "a.txt", content: "hello", parentHash: "" }],
      author: "test",
      message: "good",
    });

    // An entry written before the cap existed — the shape that jammed the queue.
    const poison = JSON.stringify({
      id: "poison",
      appId: "app-1",
      idempotencyKey: "k",
      files: [
        {
          path: "huge.pdf",
          content: "p".repeat(MAX_OUTBOX_LINE_BYTES + 1),
          parentHash: "",
        },
      ],
      author: "test",
      message: "poison",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      attempts: 0,
    });
    await fs.appendFile(outboxPath(), `${poison}\n`);

    const pending = await listPendingOutboxEntries("app-1");

    expect(pending.map((entry) => entry.id)).toEqual([good.id]);
    // Compacted out of the queue, retained on disk for inspection.
    const quarantined = await fs.stat(`${outboxPath()}.oversized`);
    expect(quarantined.size).toBeGreaterThan(MAX_OUTBOX_LINE_BYTES);
    expect((await fs.stat(outboxPath())).size).toBeLessThan(2_000);
  });
});
