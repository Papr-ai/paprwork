/**
 * Share sheet v6 — "Share is three questions": who, what they can do, whose keys.
 * Pure logic only, so the sheet, the Share button and tests read one source.
 * Reference: Share Bar Redesign prototype (v6).
 */

import type { ShareAudience, SharePermission } from "./shareAudienceModel";
import type { RequiredKeySpec } from "../../src/core/types/bundles";

export type ShareStepId = "who" | "what" | "keys";

/** The one vocabulary — sheet, Share button tooltip and catalog badges. */
export const SHARE_AUDIENCE_COPY: Record<
  ShareAudience,
  { label: string; sub: string; publish: string }
> = {
  private: {
    label: "Only me",
    sub: "Nobody else can open it.",
    publish: "Publish",
  },
  team: {
    label: "Workspace",
    sub: "Everyone in your Papr workspace.",
    publish: "Publish to workspace",
  },
  people: {
    label: "Specific people",
    sub: "Only people you add. They sign in with Papr.",
    publish: "Publish to people",
  },
  link: {
    label: "Anyone with the link",
    sub: "Unlisted. No Papr account needed.",
    publish: "Publish link",
  },
  public: {
    label: "Community",
    sub: "Listed in Community Apps for anyone to find.",
    publish: "Publish to Community",
  },
};

export const SHARE_AUDIENCE_ORDER: ShareAudience[] = [
  "private",
  "team",
  "people",
  "link",
  "public",
];

export const SHARE_STEP_TITLE: Record<ShareStepId, string> = {
  who: "Who can open it",
  what: "What they can do",
  keys: "API keys",
};

/** A private app has nothing to configure past "who". */
export function shareSteps(audience: ShareAudience): ShareStepId[] {
  return audience === "private" ? ["who"] : ["who", "what", "keys"];
}

export interface SharingDraft {
  audience: ShareAudience;
  permission: SharePermission;
  requireSignIn: boolean;
  perUserIsolation: boolean;
}

export type SharingPatch = Partial<SharingDraft>;

/** Sign-in is only a choice for link/Community; workspace and people always sign in. */
export function signInIsOptional(audience: ShareAudience): boolean {
  return audience === "link" || audience === "public";
}

/** Separate databases need to tell visitors apart, so they need sign-in. */
export function perUserDataAvailable(draft: SharingDraft): boolean {
  if (draft.audience === "private") return false;
  return signInIsOptional(draft.audience) ? draft.requireSignIn : true;
}

/**
 * Apply one click to the current answers, with the same defaults the old sheet
 * used when the audience changes (link → sign-in on; Community → install copy).
 */
export function resolveSharingPatch(
  current: SharingDraft,
  patch: SharingPatch,
): SharingDraft {
  const next: SharingDraft = { ...current, ...patch };
  if (patch.audience && patch.audience !== current.audience) {
    if (patch.audience === "private") {
      next.permission = "read";
    } else if (patch.audience === "public") {
      next.permission = "edit";
      next.requireSignIn = false;
      next.perUserIsolation = false;
    } else {
      if (next.permission === "read") next.permission = "write";
      if (patch.audience === "link") {
        next.requireSignIn = true;
        next.perUserIsolation = true;
      }
    }
  }
  if (patch.requireSignIn !== undefined && signInIsOptional(next.audience)) {
    // Turning sign-in off makes per-user data impossible; on restores it.
    next.perUserIsolation = patch.requireSignIn;
  }
  if (!perUserDataAvailable(next)) next.perUserIsolation = false;
  return next;
}

export function summarizeWhat(draft: SharingDraft): string {
  if (draft.audience === "private") return "";
  if (draft.permission === "edit") {
    return draft.audience === "public"
      ? "Install their own copy"
      : "Use it or install a copy";
  }
  const parts = ["Use your app"];
  if (signInIsOptional(draft.audience) && draft.requireSignIn)
    parts.push("sign-in required");
  if (perUserDataAvailable(draft) && draft.perUserIsolation)
    parts.push("own data each");
  return parts.join(" · ");
}

export function summarizeKeys(specs: RequiredKeySpec[] | null): string {
  if (specs === null) return "Checking…";
  if (specs.length === 0) return "None needed";
  const mine = specs.filter((s) => s.credentialScope === "owner").length;
  const theirs = specs.length - mine;
  return [mine && `${mine} on yours`, theirs && `${theirs} on theirs`]
    .filter(Boolean)
    .join(" · ");
}

export function summarizeSharing(draft: SharingDraft): string {
  const who = SHARE_AUDIENCE_COPY[draft.audience].label;
  return draft.audience === "private"
    ? who
    : `${who} · ${summarizeWhat(draft)}`;
}

export function sharePublishLabel(
  audience: ShareAudience,
  peopleCount: number,
  isFork: boolean,
): string {
  if (isFork) return "Publish your copy";
  if (audience === "people" && peopleCount > 0) {
    return `Publish to ${peopleCount} ${peopleCount === 1 ? "person" : "people"}`;
  }
  return SHARE_AUDIENCE_COPY[audience].publish;
}
