/**
 * Recovery check against a real oversized outbox.
 *
 * The other guardrail tests use synthetic files. This one runs the real read
 * path over a copy of a production queue, because the failure it prevents only
 * showed up at production scale: a 1.6GB outbox whose three largest lines were
 * ~496MB each, read whole with fs.readFile, aborting the gateway on launch.
 *
 * Skipped unless pointed at fixture files, so it is opt-in rather than
 * environment-dependent:
 *
 *   OUTBOX_FIXTURE="/path/to/sync-outbox.jsonl.oversized:/path/to/sync-outbox.jsonl" \
 *     npx vitest run tests/sync-outbox-recovery-fixture.test.ts --project unit-backend
 *
 * Paths are colon-separated and concatenated in order, so a quarantine file and
 * a queue file can be recombined into the original condition. They are only
 * read; all writes land in the isolated workspace.
 */

import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";

import { getPaprRoot } from "../src/core/utils/paprRoot.js";
import { SYNC_OUTBOX_FILENAME } from "../src/core/types/appRepoWriterOps.js";
import {
  listOutboxEntries,
  listPendingOutboxEntries,
} from "../src/gateway/services/syncV3/SyncOutbox.js";
import {
  MAX_OUTBOX_FILE_BYTES,
  MAX_OUTBOX_LINE_BYTES,
} from "../src/gateway/services/syncV3/outboxFile.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const fixtures = (process.env.OUTBOX_FIXTURE ?? "")
  .split(":")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

async function sizeOf(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

describe.skipIf(fixtures.length === 0)("outbox recovery on real data", () => {
  useIsolatedPaprWorkspace("outbox-recovery");

  it("drains an oversized production queue without loading it", async () => {
    const outboxPath = path.join(getPaprRoot(), "data", SYNC_OUTBOX_FILENAME);
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });

    let sourceBytes = 0;
    for (const fixture of fixtures) {
      sourceBytes += await sizeOf(fixture);
      await pipeline(
        createReadStream(fixture),
        createWriteStream(outboxPath, { flags: "a" }),
      );
    }

    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    const entries = await listOutboxEntries();
    const elapsedMs = Date.now() - started;
    const heapGrowth = process.memoryUsage().heapUsed - before;
    const pending = await listPendingOutboxEntries();

    const afterBytes = await sizeOf(outboxPath);
    const quarantineBytes = await sizeOf(`${outboxPath}.oversized`);

    console.log(
      `\n  queue ${mb(sourceBytes)} → ${mb(afterBytes)} ` +
        `(quarantined ${mb(quarantineBytes)}) in ${elapsedMs}ms, ` +
        `heap +${mb(heapGrowth)}\n  ${entries.length} entries kept, ` +
        `${pending.length} pending\n`,
    );

    // The queue is readable and bounded.
    expect(afterBytes).toBeLessThanOrEqual(MAX_OUTBOX_FILE_BYTES);
    expect(entries.length).toBeGreaterThan(0);

    // No payload large enough to abort a read survives in the queue.
    for (const entry of entries) {
      for (const file of entry.files) {
        expect(
          Buffer.byteLength(file.content ?? "", "utf8"),
        ).toBeLessThanOrEqual(MAX_OUTBOX_LINE_BYTES);
      }
    }

    // Oversized payloads are moved aside, not deleted.
    if (sourceBytes > MAX_OUTBOX_LINE_BYTES) {
      expect(quarantineBytes).toBeGreaterThan(0);
    }

    // Reading must not scale with file size — that was the whole failure.
    expect(heapGrowth).toBeLessThan(sourceBytes);
  });
});
