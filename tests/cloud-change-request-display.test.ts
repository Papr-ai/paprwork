import { describe, expect, it } from "vitest";
import { contributorLabelForChangeRequest } from "../ui/utils/cloudChangeRequestsApi.js";

describe("contributorLabelForChangeRequest", () => {
  it("prefers display name fields from the memory server", () => {
    expect(
      contributorLabelForChangeRequest({
        id: "1",
        sourceAppId: "a",
        installedAppId: "b",
        title: "t",
        description: "d",
        status: "pending",
        contributorDisplayName: "Alex Kim",
      }),
    ).toBe("Alex Kim");
  });

  it("falls back to email then fork id", () => {
    expect(
      contributorLabelForChangeRequest({
        id: "1",
        sourceAppId: "a",
        installedAppId: "abcdef12-0000-4000-8000-000000000001",
        title: "t",
        description: "d",
        status: "pending",
        contributorEmail: "dev@example.com",
      }),
    ).toBe("dev@example.com");
  });
});
