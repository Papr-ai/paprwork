import { afterEach, describe, expect, it } from "vitest";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";
import {
  appendOutboxEntry,
  clearDeadLetterOutboxEntries,
  clearSyncOutboxForTests,
  listDeadLetterOutboxEntries,
  listOutboxEntries,
  markOutboxDeadLetter,
  requeueDeadLetterOutboxEntries,
} from "../src/gateway/services/syncV3/SyncOutbox.js";

describe("SyncOutbox dead-letter helpers", () => {
  useIsolatedPaprWorkspace("sync-outbox-dead-letter");

  afterEach(async () => {
    await clearSyncOutboxForTests();
  });

  it("clears dead-letter entries for one app", async () => {
    const entry = await appendOutboxEntry({
      appId: "app-a",
      files: [],
      author: "test",
      message: "sync",
    });
    await markOutboxDeadLetter(entry.id, "fetch failed");

    await appendOutboxEntry({
      appId: "app-b",
      files: [],
      author: "test",
      message: "sync",
    });

    const removed = await clearDeadLetterOutboxEntries("app-a");
    expect(removed).toBe(1);
    expect(await listDeadLetterOutboxEntries("app-a")).toHaveLength(0);
    expect(await listOutboxEntries("app-b")).toHaveLength(1);
  });

  it("requeues dead-letter entries as pending", async () => {
    const entry = await appendOutboxEntry({
      appId: "app-a",
      files: [],
      author: "test",
      message: "sync",
    });
    await markOutboxDeadLetter(entry.id, "fetch failed");

    const requeued = await requeueDeadLetterOutboxEntries("app-a");
    expect(requeued).toBe(1);

    const entries = await listOutboxEntries("app-a");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("pending");
    expect(entries[0]?.attempts).toBe(0);
    expect(entries[0]?.lastError).toBeUndefined();
  });
});
