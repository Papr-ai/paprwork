import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/settingsStore.js", () => ({
  loadSettings: async () => ({ preferences: { cloudSyncEnabled: false } }),
}));
vi.mock("./keyResolver.js", () => ({ getPaprApiKey: async () => "k" }));
const { checkCloudPublishAvailable } = await import("./cloudPublishGate.js");

describe("cloud publish gate", () => {
  afterEach(() => { delete process.env.GATEWAY_MODE; });
  it("desktop with Cloud Sync off is unavailable", async () => {
    expect((await checkCloudPublishAvailable()).available).toBe(false);
  });
  it("cloud runs never ask the user to enable Cloud Sync", async () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    expect(await checkCloudPublishAvailable()).toEqual({ available: true });
  });
});
