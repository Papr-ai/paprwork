/**
 * Owner-facing copy for incoming code proposals — team vs community vs link.
 */

import type { ShareAudience } from "./shareAudienceModel";
import { shouldListInCommunity } from "./shareAudienceModel";

export type ContributionAudienceKind = "team" | "community" | "link";

export interface ContributionPanelCopy {
  title: string;
  description: string;
  emptyPending: string;
  loading: string;
  showPastProposals: (count: number) => string;
  hidePastProposals: string;
  pastProposalsHeading: string;
}

export function contributionAudienceKind(
  audience: ShareAudience,
  published: boolean,
): ContributionAudienceKind {
  if (audience === "team") {
    return "team";
  }
  if (shouldListInCommunity(audience, published)) {
    return "community";
  }
  return "link";
}

export function contributionPanelCopy(
  kind: ContributionAudienceKind,
): ContributionPanelCopy {
  switch (kind) {
    case "team":
      return {
        title: "Team proposals",
        description:
          "Teammates who install or track this app can send changes for your review. Accept merges into your app; decline closes the proposal without changing their copy.",
        emptyPending: "No pending team proposals.",
        loading: "Loading team proposals…",
        showPastProposals: (n) =>
          `Show past team proposals (${n})`,
        hidePastProposals: "Hide past team proposals",
        pastProposalsHeading: "Past team proposals",
      };
    case "community":
      return {
        title: "Community proposals",
        description:
          "People who installed your app from Community can send changes back for review. Accept merges their work into your app; decline closes the proposal without affecting their copy.",
        emptyPending: "No pending community proposals.",
        loading: "Loading community proposals…",
        showPastProposals: (n) =>
          `Show past community proposals (${n})`,
        hidePastProposals: "Hide past community proposals",
        pastProposalsHeading: "Past community proposals",
      };
    case "link":
      return {
        title: "Collaboration proposals",
        description:
          "People with your install link who forked the app can propose changes. Accept merges into your app; decline closes the proposal without affecting their copy.",
        emptyPending: "No pending proposals.",
        loading: "Loading proposals…",
        showPastProposals: (n) => `Show past proposals (${n})`,
        hidePastProposals: "Hide past proposals",
        pastProposalsHeading: "Past proposals",
      };
  }
}

export function contributorFallbackLabel(
  kind: ContributionAudienceKind,
  installedAppId: string,
): string | null {
  const forkId = installedAppId.trim();
  if (forkId.length < 8) {
    return null;
  }
  const short = `${forkId.slice(0, 8)}…`;
  switch (kind) {
    case "team":
      return `Teammate (copy ${short})`;
    case "community":
      return `Contributor (fork ${short})`;
    case "link":
      return `Collaborator (fork ${short})`;
  }
}
