import { describe, expect, it, vi } from "vitest";
import {
  bumpSyncIndexEntry,
  readSyncIndexVersion,
} from "../src/gateway/services/tursoSyncIndex.js";

describe("tursoSyncIndex", () => {
  it("bumpSyncIndexEntry increments version", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ version: 2 }] });
    const client = { execute, close: vi.fn() };

    await expect(bumpSyncIndexEntry(client as never, "j-jobabc")).resolves.toBe(2);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("readSyncIndexVersion returns parsed number", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [{ version: 5 }] }),
      close: vi.fn(),
    };
    await expect(readSyncIndexVersion(client as never, "d-deadbeef")).resolves.toBe(5);
  });
});
