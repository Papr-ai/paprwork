/**
 * Share bar v2 (plan step 7): one pill with two views and Settings.
 *
 *   [ Live · Up to date ] [ Preview ● ] | [ Settings ● ]
 *
 * Live is the team's version and keeping this Mac in step with it. Preview is
 * your changes and where they are in review. The open view shows its status
 * in words; the other shows a dot only when it needs a look. Three colours,
 * same as Focus and Notifications: green = all good, blue = needs you (it has
 * a button), grey = nothing to do or waiting on someone. Labels are 1-2 words.
 *
 * Pure: it only re-sorts statuses the bar already computes (the publish chip
 * for owners, resolveCopyBar for copies). No new sync logic lives here.
 */

import type { CopyBar, CopyChipAction } from "./copyState";
import type { PublishBarChipTone } from "./appCloudSyncStatus";

export type PillView = "live" | "preview";
export type PillTone = "ok" | "warn" | "bad" | "info" | "idle";
/** Dots are blue only: a view you're not on gets one when it needs you. */
export type PillDot = "warn" | "bad";

export interface PillStatus {
  label: string;
  tone: PillTone;
  /** Short action shown beside the status on the open view ("Get updates"). */
  verb?: string;
  /** Preview with nothing in it. */
  empty?: boolean;
  /** Longer explanation for the tooltip, when the label alone could mislead. */
  hint?: string;
  /** What the verb runs. Owner chip actions are passed through as-is. go_preview = open Preview (its button). */
  action?: CopyChipAction | "owner_chip" | "go_preview" | null;
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

/** Blue only when there's something to press; in-progress and FYI stay grey. */
function tone(t: PublishBarChipTone, hasVerb: boolean): PillTone {
  if (hasVerb && t !== "ok") return "warn";
  if (t === "busy" || t === "info") return "idle";
  return t === "bad" ? "warn" : t;
}

/** Old chip wording (owner publish chip + copy chip) → the pill's 1-2 words. null = nothing for Live to say. */
const LIVE_WORDS: Array<[RegExp, string | null]> = [
  [/^Last publish failed|^Publish failed/, "Publish failed"],
  [/^Update conflicts/, "Conflicts"],
  [/^Updates paused/, "Updates paused"],
  [/^Publisher has updates|^Newer version on web/, "Update ready"],
  [/^Getting updates/, "Updating…"],
  [/^Publishing/, "Publishing…"],
  [/^Checking/, "Checking…"],
  [/sync off/i, "Sync off"],
  [/^Draft$|^Not on the web yet/, "Local only"],
  [/^Unpublished changes|^Live(,| ·|$)|^Same as the team|^Up to date/, null],
];

export function liveWords(label: string): string | null {
  for (const [re, w] of LIVE_WORDS) if (re.test(label)) return w;
  return label;
}

function liveStatus(label: string, t: PublishBarChipTone, verb: string | undefined, action: PillStatus["action"]): PillStatus | null {
  const words = liveWords(label);
  if (words === null) return null;
  return { label: words, tone: tone(t, !!verb), ...(verb ? { verb } : {}), action, ...(words !== label ? { hint: label } : {}) };
}

/** Copy chip labels in the words the mockup settled on. */
function previewWords(chip: CopyBar["chip"], slug: string): PillStatus {
  switch (chip.action) {
    case "propose":
      return { label: "Not proposed yet", tone: "warn", verb: "Propose", action: "propose" };
    case "publish":
      return { label: "Not published yet", tone: "warn", verb: "Publish", action: "publish" };
    case "view_proposal":
      return { label: `Waiting for ${slug}`, tone: "idle", verb: "View", action: "view_proposal" };
    case "update_and_repropose":
      return { label: "Needs updating", tone: "warn", verb: "Update", action: "update_and_repropose" };
    case "see_decline":
      return { label: "Declined", tone: "warn", verb: "See why", action: "see_decline" };
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
      live = liveStatus(chip.label, chip.tone, chip.verb ?? undefined, chip.action) ?? UP_TO_DATE;
    }
    if (chip.action === "view_proposal" && chip.tone === "ok") {
      preview = NO_CHANGES;
      live = { label: "Change accepted", tone: "ok", hint: "Your change is live for the team." };
    }
  } else {
    // Owner: edits are Preview's ("Not published yet"); Live keeps whatever
    // else the publish chip knew (failed publish, update, conflict, sync off).
    if (input.ownerHasUnpublished) {
      preview = { label: "Not published yet", tone: "warn", verb: "Publish", action: "publish" };
    }
    if (!input.ownerLive) live = { label: "Local only", tone: "idle", hint: "Not on the web yet. Publish to share it." };
    else live = liveStatus(ownerChip.label, ownerChip.tone, undefined, "owner_chip") ?? UP_TO_DATE;
  }

  // Live is in sync with the web, but you have changes that aren't in it yet:
  // "Up to date" would read as "everything you made is live". Say what Live
  // lacks, with a button to Preview; a real Live problem still wins.
  if (live === UP_TO_DATE && !preview.empty) {
    const sent = preview.action === "view_proposal" || preview.action === "see_decline";
    const until = input.copyBar ? (sent ? "it's accepted" : "you propose it and it's accepted") : "you publish";
    live = sent
      ? { label: "Change pending", tone: "idle", hint: `Live matches the team's version. Your change is only in Preview until ${until}.` }
      : {
          label: "Without edits",
          tone: "idle",
          verb: preview.verb,
          action: "go_preview",
          hint: `Live matches the team's version. Your edits are only in Preview until ${until}.`,
        };
  }

  const settingsDot = input.failingJobName
    ? { tone: "bad" as const, target: "jobs" as const, label: `${input.failingJobName} failed` }
    : null;
  return { live, preview, settingsDot };
}

/** A view you're not on only gets a dot when it needs a look. */
export function viewDot(view: PillView, st: PillStatus): PillDot | null {
  // Waiting on someone is grey: nothing for you to press, so no dot.
  if (view === "preview") return !st.empty && st.tone === "warn" ? "warn" : null;
  return st.tone === "warn" || st.tone === "bad" ? "warn" : null;
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
