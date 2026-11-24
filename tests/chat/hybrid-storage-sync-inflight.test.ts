import { describe, expect, it, vi } from "vitest";
import { HybridStorageProvider } from "../../src/gateway/services/storage/HybridStorageProvider.js";
import type { StoredMessage } from "../../src/gateway/services/storage/IStorageProvider.js";

/**
 * Regression: a summary refresh runs bulkSyncToPapr while the turn's normal
 * background save is still waiting on Papr. The message is still sync_pending,
 * so it was sent twice and Papr stored two PostMessages (dev, 2026-10-30:
 * POST /v1/messages at 17:59:47.528 and again at 17:59:47.907 for one message).
 */
function makeProvider() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stores: string[] = [];
  const pending = new Map<string, StoredMessage>();

  const local = {
    saveMessage: vi.fn(async (_c: string, m: StoredMessage) => {
      pending.set(m.id, m);
    }),
    getUnsyncedMessages: vi.fn(async () => [...pending.values()].map((m) => ({ ...m }))),
    markMessageSynced: vi.fn(async (id: string) => {
      pending.delete(id);
    }),
    markSyncFailed: vi.fn(async () => {}),
  };
  const papr = {
    saveMessage: vi.fn(async (_c: string, m: StoredMessage) => {
      stores.push(m.id);
      await gate;
      m.papr_message_id = `papr-${stores.length}`;
    }),
  };

  const provider = Object.create(HybridStorageProvider.prototype) as HybridStorageProvider;
  Object.assign(provider, { local, papr, syncEnabled: true, inFlightSyncs: new Map() });
  return { provider, local, papr, stores, release };
}

const msg = (id: string): StoredMessage =>
  ({ id, chat_id: "c1", role: "user", content: "hi", timestamp: new Date().toISOString(), sync_status: "local" }) as StoredMessage;

describe("HybridStorageProvider Papr sync", () => {
  it("does not resend a message whose save is still in flight", async () => {
    const { provider, stores, release, local } = makeProvider();

    await provider.saveMessage("c1", msg("m1")); // background send starts, blocks on gate
    const bulk = provider.bulkSyncToPapr("c1"); // summary refresh path
    await new Promise((r) => setTimeout(r, 0));
    release();
    const result = await bulk;

    expect(stores).toEqual(["m1"]);
    expect(result).toEqual({ total: 1, synced: 1, failed: 0 });
    expect(local.markMessageSynced).toHaveBeenCalledTimes(1);
  });

  it("sends again once the earlier send has finished (retry still works)", async () => {
    const { provider, stores, release, local } = makeProvider();
    release();
    await provider.saveMessage("c1", msg("m1"));
    await new Promise((r) => setTimeout(r, 0));
    local.markMessageSynced.mockClear();

    // Simulate a later retry of a still-pending row (e.g. after a failure).
    await (provider as unknown as { syncMessageToPapr: (c: string, m: StoredMessage) => Promise<void> }).syncMessageToPapr("c1", msg("m1"));
    expect(stores).toEqual(["m1", "m1"]);
  });
});
