import { describe, expect, it, vi } from "vitest";
vi.mock("../src/core/tools/bash.js", () => ({ invalidateCustomKeysCache: vi.fn() }));
import { CustomKeysService } from "../src/gateway/services/CustomKeysService.js";
describe("custom key change events", () => {
  it("cache refreshes do not schedule uploads; explicit edits do", () => {
    const prior = new Set(process.listeners("message"));
    try {
      const service = new CustomKeysService(); const listener = vi.fn(); service.onKeyChange(listener);
      service.invalidateCache(); service.invalidateCache("key"); expect(listener).not.toHaveBeenCalled();
      service.notifyKeyChanged("key"); expect(listener).toHaveBeenCalledWith("key");
    } finally { for (const listener of process.listeners("message")) if (!prior.has(listener)) process.removeListener("message", listener); }
  });
  it("IPC cache-only messages stay silent and actual edits notify once", async () => {
    const prior = new Set(process.listeners("message"));
    try {
      const service = new CustomKeysService(); const listener = vi.fn(); service.onKeyChange(listener);
      await service.initialize();
      const dispatch = process.listeners("message").find(fn => !prior.has(fn))!;
      dispatch({ type: "INVALIDATE_KEY_CACHE", keyName: "key" }, undefined);
      expect(listener).not.toHaveBeenCalled();
      dispatch({ type: "INVALIDATE_KEY_CACHE", keyName: "key", keysChanged: true }, undefined);
      expect(listener).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledWith("key");
    } finally { for (const listener of process.listeners("message")) if (!prior.has(listener)) process.removeListener("message", listener); }
  });
});
