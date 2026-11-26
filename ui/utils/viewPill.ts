/**
 * Share bar v2 (plan step 7): one pill with two views and Settings.
 *
 *   [ Live · Up to date ] [ Preview ● ] | [ Settings ● ]
 *
 * Live is the team's version and keeping this Mac in step with it. Preview is
 * your changes and where they are in review. The open view shows its status
 * in words; the other shows a dot only when it needs a look. Dot colours are
 * the notification marks: green = FYI, amber = needs you, red = urgent.
 *
 * Pure: it only re-sorts statuses the bar already computes (the publish chip
 * for owners, resolveCopyBar for copies). No new sync logic lives here.
 */

import type { CopyBar, CopyChipAction } from "./copyState";
import type { PublishBarChipTone } from "./appCloudSyncStatus";

export type PillView = "live" | "preview";
export type PillTone = "ok" | "warn" | "bad" | "info" | "idle";
export type PillDot = "info" | "warn" | "bad";

export interface PillStatus {
  label: string;
  tone: PillTone;
  /** Short action shown beside the status on the open view ("Get updates"). */
  verb?: string;
  /** Preview with nothing in it. */
  empty?: boolean;
  /** What the verb runs. Owner chip actions are passed through as-is. */
  action?: CopyChipAction | "owner_chip" | null;
}

export interface ViewPillModel {
  live: PillStatus;
  preview: PillStatus;
  /** Most urgent thing inside Settings, and where its dot leads. */
  settingsDot: { tone: PillDot; target: "jobs" | "code" | "data"; label: string } | null;
}

/** Copy actions that are about your own changes, so they belong to Preview. */
const PREVIEW_ACTIONS: ReadonlySet<CopyChipAction> = new Set<CopyChipAction>([
  "propose",
  "publish",
  "view_proposal",
  "update_and_repropose",
  "see_decline",
]);

const NO_CHANGES: PillStatus = { label: "No changes", tone: "idle", empty: true };
const UP_TO_DATE: PillStatus = { label: "Up to date", tone: "ok" };

function tone(t: PublishBarChipTone): PillTone {
  return t === "busy" ? "info" : t;
}

/** Copy chip labels in the words the mockup settled on. */
function previewWords(chip: CopyBar["chip"], slug: string): PillStatus {
  switch (chip.action) {
    case "propose":
      return { label: "Not proposed yet", tone: "warn", verb: "Propose", action: "propose" };
    case "publish":
      return { label: "Not published yet", tone: "warn", verb: "Publish", action: "publish" };
    case "view_proposal":
      return { label: `Waiting for ${slug}`, tone: "idle", action: "view_proposal" };
    case "update_and_repropose":
      return { label: "Needs updating", tone: "warn", verb: "Update", action: "update_and_repropose" };
    case "see_decline":
      return { label: "Declined", tone: "bad", verb: "See why", action: "see_decline" };
    default:
      return NO_CHANGES;
  }
}

export interface ViewPillInput {
  /** resolveCopyBar result for an installed copy; null for the owner's own app. */
  copyBar: CopyBar | null;
  /** Owner's chip (resolvePublishBarChipLabel), used when copyBar is null. */
  ownerChip: { label: string; tone: PublishBarChipTone };
  ownerHasUnpublished: boolean;
  ownerLive: boolean;
  publisherSlug?: string;
  failingJobName?: string | null;
}

export function resolveViewPill(input: ViewPillInput): ViewPillModel {
  const { copyBar, ownerChip } = input;
  let live: PillStatus = UP_TO_DATE;
  let preview: PillStatus = NO_CHANGES;

  if (copyBar) {
    const { chip } = copyBar;
    if (chip.action && PREVIEW_ACTIONS.has(chip.action)) {
      preview = previewWords(chip, input.publisherSlug ?? "the owner");
    } else if (chip.tone !== "ok") {
      live = { label: chip.label, tone: tone(chip.tone), verb: chip.verb ?? undefined, action: chip.action };
    } else if (chip.action === "view_proposal") {
      live = { label: "Your change is live", tone: "ok", action: "view_proposal" };
    }
  } else if (input.ownerHasUnpublished) {
    // Owner with edits: those are Preview's ("Not published yet"); Live keeps
    // whatever else the chip knew (failed publish, update, conflict).
    preview = { label: "Not published yet", tone: "warn", verb: "Publish", action: "publish" };
    if (ownerChip.tone === "bad" || ownerChip.tone === "info" || ownerChip.tone === "busy") {
      live = { label: ownerChip.label, tone: tone(ownerChip.tone), action: "owner_chip" };
    }
  } else if (!input.ownerLive) {
    live = { label: "Not on the web yet", tone: "idle" };
  } else if (ownerChip.tone !== "ok") {
    live = { label: ownerChip.label, tone: tone(ownerChip.tone), action: "owner_chip" };
  }

  const settingsDot = input.failingJobName
    ? { tone: "bad" as const, target: "jobs" as const, label: `${input.failingJobName} failed` }
    : null;
  return { live, preview, settingsDot };
}

/** A view you're not on only gets a dot when it needs a look. */
export function viewDot(view: PillView, st: PillStatus): PillDot | null {
  if (view === "preview") return st.empty ? null : st.tone === "bad" ? "bad" : "warn";
  return st.tone === "warn" || st.tone === "bad" || st.tone === "info" ? st.tone : null;
}

/** The view to open on: Live, unless you have changes (decision 4). */
export function defaultView(model: ViewPillModel): PillView {
  return model.preview.empty ? "live" : "preview";
}

/** Behind a flag until Preview shows real changes (step 8). */
export function shareBarV2Enabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("papr.shareBarV2") === "1";
  } catch {
    return false;
  }
}
