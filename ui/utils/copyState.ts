/**
 * v5 share model: one state for an installed copy, one function for its bar.
 *
 * Every install is the user's own copy, linked to the original until they
 * detach. Three independent axes describe it; everything the publish bar
 * shows (chip, primary button, origin badge, menu rows) is derived here and
 * nowhere else, so two code paths can't disagree about the same app.
 *
 *   link      linked | detached     Detach is one-way.
 *   dataMode  own | team            Team only for team apps with a shared DB.
 *   origin    community | team      Fixed at install.
 *
 * Rule: Publish when the data is yours, Propose when it's the team's.
 */

import {
  assertValidCopyState,
  copyAxesFromLineage,
  type CopyDataMode,
  type CopyLink,
  type CopyOrigin,
} from "../../src/core/utils/copyAxes";

export {
  assertValidCopyState,
  copyAxesFromLineage,
  InvalidCopyStateError,
  isOnTeamData,
  usesSharedData,
  type CopyDataMode,
  type CopyLink,
  type CopyOrigin,
} from "../../src/core/utils/copyAxes";
export type CopyProposalStatus = "none" | "pending" | "approved" | "rejected" | "needs_update";
export type CopyTone = "ok" | "warn" | "bad" | "info" | "idle" | "busy";

export interface CopyFacts {
  /** This copy is on the web at its own link. */
  live: boolean;
  /** Local code differs from the last sync. null = unknown (older installs). */
  hasLocalEdits: boolean | null;
  /** Local edits not yet sent in a proposal. null = unknown. */
  hasUnproposedEdits: boolean | null;
  /** Local edits not yet published to this copy's own link. */
  hasUnpublishedEdits: boolean;
  publisherAhead: boolean;
  pullState: "idle" | "pulling" | "conflict";
  lastPublishFailed: boolean;
  proposal: CopyProposalStatus;
  busy: boolean;
  /** Owner turned proposals off (server flag). */
  proposalsClosed?: boolean;
}

export interface CopyState extends CopyFacts {
  link: CopyLink;
  dataMode: CopyDataMode;
  origin: CopyOrigin;
  sourceSlug: string;
}

export type CopyChipAction =
  | "review_conflicts"
  | "retry_publish"
  | "get_updates"
  | "update_and_repropose"
  | "see_decline"
  | "view_proposal"
  | "propose"
  | "publish";

export interface CopyBar {
  chip: { label: string; tone: CopyTone; action: CopyChipAction | null; verb: string | null };
  primary: { kind: "publish" | "propose"; label: string; disabled: boolean; title: string };
  badge: { kind: "origin"; icon: "person" | "globe"; dot: boolean } | { kind: "fork_mark" };
  /** Rows in the origin-badge menu (empty when detached). */
  menu: Array<"updates" | "propose" | "data" | "detach">;
  /** Where the URL row points. */
  link: "team_app" | "own_copy" | "not_on_web";
}

export function deriveCopyState(
  lineage: Parameters<typeof copyAxesFromLineage>[0] & { sourceSlug?: string; source?: { slug: string } },
  facts: CopyFacts,
): CopyState {
  const axes = copyAxesFromLineage(lineage);
  assertValidCopyState(axes);
  return {
    ...facts,
    ...axes,
    sourceSlug: lineage.sourceSlug ?? lineage.source?.slug ?? "the publisher",
  };
}

const chip = (
  label: string,
  tone: CopyTone,
  action: CopyChipAction | null = null,
  verb: string | null = null,
): CopyBar["chip"] => ({ label, tone, action, verb });

/** One priority order for every copy: whatever blocks you first wins. */
function resolveChip(s: CopyState): CopyBar["chip"] {
  const linked = s.link === "linked";
  const onTeam = s.dataMode === "team";
  if (s.pullState === "pulling") return chip("Getting updates…", "busy");
  if (s.pullState === "conflict") return chip("Update conflicts", "bad", "review_conflicts", "Review");
  if (s.lastPublishFailed && !onTeam) return chip("Last publish failed", "bad", "retry_publish", "Retry");
  if (linked && s.proposal === "needs_update")
    return chip("Proposal needs update", "warn", "update_and_repropose", "Update & re-propose");
  if (linked && s.publisherAhead) return chip("Publisher has updates", "info", "get_updates", "Get updates");
  if (linked && s.proposal === "rejected") return chip("Proposal declined", "bad", "see_decline", "See why");
  if (linked && s.proposal === "approved") return chip("Proposal accepted", "ok", "view_proposal", "View");
  if (onTeam && s.hasUnproposedEdits !== false && s.hasLocalEdits === true)
    return chip("Edits not proposed", "warn", "propose", "Propose");
  if (!onTeam && s.live && s.hasUnpublishedEdits) return chip("Edits not published", "warn", "publish", "Publish");
  if (linked && s.proposal === "pending") return chip("Proposal sent", "idle", "view_proposal", "View");
  if (!onTeam && !s.live) return chip("Not on the web yet", "idle");
  return chip(onTeam ? "Same as the team's app" : "Up to date", "ok");
}

function resolvePrimary(s: CopyState): CopyBar["primary"] {
  const blocked = s.busy || s.pullState !== "idle";
  if (s.dataMode === "team") {
    const nothing = s.hasLocalEdits === false || s.hasUnproposedEdits === false;
    const title = s.pullState === "conflict"
      ? "Finish or cancel the update first"
      : s.proposalsClosed
        ? `${s.sourceSlug} isn't accepting proposals`
        : nothing
          ? s.proposal === "pending"
            ? `Your proposal is waiting on ${s.sourceSlug}`
            : "No code edits to propose"
          : `Choose which edits to send to ${s.sourceSlug}`;
    return {
      kind: "propose",
      label: "Propose",
      disabled: blocked || nothing || Boolean(s.proposalsClosed),
      title,
    };
  }
  const canPublish = !s.live || s.hasUnpublishedEdits || s.lastPublishFailed;
  return {
    kind: "publish",
    label: "Publish",
    disabled: blocked || !canPublish,
    title: s.pullState === "conflict"
      ? "Finish or cancel the update first"
      : !s.live
        ? "Put your copy on the web at its own link"
        : canPublish
          ? `Publish your edits to your copy. ${s.sourceSlug}'s app is not touched.`
          : "Your copy on the web is up to date",
  };
}

export function resolveCopyBar(s: CopyState): CopyBar {
  assertValidCopyState(s);
  const linked = s.link === "linked";
  const menu: CopyBar["menu"] = [];
  if (linked) {
    menu.push("updates");
    if (!s.proposalsClosed) menu.push("propose");
    if (s.origin === "team") menu.push("data");
    menu.push("detach");
  }
  return {
    chip: resolveChip(s),
    primary: resolvePrimary(s),
    badge: linked
      ? { kind: "origin", icon: s.origin === "team" ? "person" : "globe", dot: s.publisherAhead }
      : { kind: "fork_mark" },
    menu,
    link: s.dataMode === "team" ? "team_app" : s.live ? "own_copy" : "not_on_web",
  };
}
