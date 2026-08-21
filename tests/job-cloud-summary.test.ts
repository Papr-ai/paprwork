import { describe, expect, test, vi } from "vitest";

vi.mock("../src/gateway/utils/cloudApiClient.js", () => ({
  cloudApiFetch: vi.fn(),
}));

vi.mock("../src/gateway/utils/keyResolver.js", () => ({
  getPaprApiKey: vi.fn(),
}));

vi.mock("../src/gateway/utils/cloudSchedulerAuthority.js", () => ({
  isCloudSchedulerAuthoritative: vi.fn().mockResolvedValue(true),
}));

import { cloudApiFetch } from "../src/gateway/utils/cloudApiClient.js";
import { getPaprApiKey } from "../src/gateway/utils/keyResolver.js";
import { fetchCloudJobSummaries } from "../src/gateway/services/jobs/jobCloudSummary.js";

describe("fetchCloudJobSummaries", () => {
  test("returns disconnected report without api key", async () => {
    vi.mocked(getPaprApiKey).mockResolvedValue(null);
    const report = await fetchCloudJobSummaries(["local-a"]);
    expect(report.connected).toBe(false);
    expect(report.summariesById).toEqual({});
    expect(report.cloudOnlyJobIds).toEqual([]);
  });

  test("maps cloud jobs and detects cloud-only entries", async () => {
    vi.mocked(getPaprApiKey).mockResolvedValue("sk-test");
    vi.mocked(cloudApiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        jobs: [
          { id: "local-a", name: "Local A", lastRunAt: "2026-08-01T00:00:00.000Z" },
          { id: "cloud-only-b", name: "Cloud B", lastRunAt: "2026-08-02T00:00:00.000Z" },
        ],
        count: 2,
      }),
    } as Response);

    const report = await fetchCloudJobSummaries(["local-a"]);
    expect(report.connected).toBe(true);
    expect(report.cloudSchedulerActive).toBe(true);
    expect(report.summariesById["local-a"]?.name).toBe("Local A");
    expect(report.cloudOnlyJobIds).toEqual(["cloud-only-b"]);
  });
});
