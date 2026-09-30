import { describe, expect, it } from "vitest";
import {
  buildMemberLookupByUserId,
  enrichChangeRequestContributorRow,
  extractChangeRequestProposerUserId,
} from "../src/core/utils/changeRequestContributorEnrich.js";
import {
  changeRequestProposedByLine,
  normalizeCloudChangeRequest,
} from "../ui/utils/cloudChangeRequestsApi.js";

describe("changeRequestContributorEnrich", () => {
  it("resolves display name from proposerUserId via workspace roster", () => {
    const members = buildMemberLookupByUserId([
      {
        userId: "user-alex",
        displayName: "Alex Kim",
        email: "alex@example.com",
      },
    ]);
    const enriched = enrichChangeRequestContributorRow(
      {
        id: "1",
        sourceAppId: "src",
        installedAppId: "fork",
        title: "t",
        description: "d",
        status: "pending",
        proposer_user_id: "user-alex",
      },
      members,
    );
    expect(enriched.proposerDisplayName).toBe("Alex Kim");
    const normalized = normalizeCloudChangeRequest(
      enriched as Parameters<typeof normalizeCloudChangeRequest>[0],
    );
    expect(changeRequestProposedByLine(normalized, "team")).toBe(
      "Proposed by teammate Alex Kim",
    );
  });

  it("reads nested proposer object from memory server payloads", () => {
    const enriched = enrichChangeRequestContributorRow(
      {
        id: "1",
        sourceAppId: "src",
        installedAppId: "fork",
        status: "pending",
        proposer: {
          object_id: "user-jordan",
          display_name: "Jordan Lee",
        },
      },
      new Map(),
    );
    expect(enriched.proposerDisplayName).toBe("Jordan Lee");
    expect(extractChangeRequestProposerUserId(enriched)).toBe("user-jordan");
  });
});
