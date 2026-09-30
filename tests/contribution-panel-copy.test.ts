import { describe, expect, it } from "vitest";
import {
  contributionAudienceKind,
  contributionPanelCopy,
  contributorFallbackLabel,
} from "../ui/utils/contributionPanelCopy";
import { contributorLabelForChangeRequest } from "../ui/utils/cloudChangeRequestsApi";

describe("contributionPanelCopy", () => {
  it("maps team audience to team kind", () => {
    expect(contributionAudienceKind("team", true)).toBe("team");
    expect(contributionPanelCopy("team").title).toBe("Team proposals");
  });

  it("maps public published apps to community kind", () => {
    expect(contributionAudienceKind("public", true)).toBe("community");
    expect(contributionPanelCopy("community").title).toBe("Community proposals");
  });

  it("maps link sharing to link kind", () => {
    expect(contributionAudienceKind("link", true)).toBe("link");
    expect(contributionPanelCopy("link").title).toBe("Collaboration proposals");
  });

  it("uses audience-specific fallback contributor labels", () => {
    const fork = "b973ace9-0000-4000-8000-000000000001";
    expect(contributorFallbackLabel("team", fork)).toContain("Teammate");
    expect(contributorFallbackLabel("community", fork)).toContain("Contributor");
    expect(contributorFallbackLabel("link", fork)).toContain("Collaborator");
    expect(
      contributorLabelForChangeRequest(
        { id: "1", sourceAppId: "a", installedAppId: fork, title: "t", description: "d", status: "pending" },
        "team",
      ),
    ).toContain("Teammate");
  });
});
