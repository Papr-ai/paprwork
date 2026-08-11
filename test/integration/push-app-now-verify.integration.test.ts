import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CloudSyncService } from "../../src/gateway/services/CloudSyncService.js";

const mockFlushAppNow = vi.fn();

vi.mock("../../src/gateway/services/cloudSync/flushAppNow.js", () => ({
  flushAppNow: (...args: unknown[]) => mockFlushAppNow(...args),
}));

describe("CloudSyncService.pushAppNow", () => {
  let service: CloudSyncService;

  beforeEach(() => {
    service = new CloudSyncService();
    mockFlushAppNow.mockResolvedValue({
      appId: "app-fixture-1",
      localMigrationsApplied: [],
      tursoPushed: true,
      webReady: true,
      published: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to ordered flushAppNow pipeline", async () => {
    await service.pushAppNow("app-fixture-1");

    expect(mockFlushAppNow).toHaveBeenCalledWith(service, "app-fixture-1");
  });

  it("propagates flush failures", async () => {
    mockFlushAppNow.mockRejectedValue(new Error("Turso verify failed"));

    await expect(service.pushAppNow("app-fixture-1")).rejects.toThrow(
      "Turso verify failed",
    );
  });
});
