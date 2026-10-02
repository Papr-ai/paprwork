/**
 * Share sheet v6 — "Share is three questions": who, what they can do, whose keys.
 * Pure logic only, so the sheet, the bar chip and tests read one source.
 * Reference: Share Bar Redesign prototype (v6).
 *
 * Share only exists once an app is live — the bar's Publish is how an app gets
 * there, so this sheet never publishes. Access changes are walked through
 * (who → what → keys) and saved once at the end; see shareEditFlow.
 */

import type { ShareAudience, SharePermission } from "./shareAudienceModel";
import type { RequiredKeySpec } from "../../src/core/types/bundles";

export type ShareStepId = "who" | "what" | "keys";

/** The one vocabulary — sheet, Share button tooltip and catalog badges. */
export const SHARE_AUDIENCE_COPY: Record<
  ShareAudience,
  { label: string; sub: string }
> = {
  private: { label: "Only me", sub: "Nobody else can open it." },
  team: { label: "Workspace", sub: "Everyone in your Papr workspace." },
  people: {
    label: "Specific people",
    sub: "Only people you add. They sign in with Papr.",
  },
  link: {
    label: "Anyone with the link",
    sub: "Unlisted. No Papr account needed.",
  },
  public: {
    label: "Community",
    sub: "Listed in Community Apps for anyone to find.",
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

export function sameSharing(a: SharingDraft, b: SharingDraft): boolean {
  return (
    a.audience === b.audience &&
    a.permission === b.permission &&
    a.requireSignIn === b.requireSignIn &&
    a.perUserIsolation === b.perUserIsolation
  );
}

/**
 * The steps an edit walks through before anything is saved.
 *
 * Changing who can open it changes what they can do and whose keys they run
 * on, so "who" leads into "what" and then "keys" (only if the app has keys).
 * Changing "what" leads into "keys" when there are any. Keys alone is a
 * single step that saves on its own. Only me has nothing after "who".
 */
export function shareEditFlow(
  start: ShareStepId,
  audience: ShareAudience,
  hasKeys: boolean,
): ShareStepId[] {
  if (start === "keys") return ["keys"];
  const steps: ShareStepId[] = start === "who" ? ["who"] : [];
  if (audience === "private") return steps.length ? steps : ["what"];
  steps.push("what");
  if (hasKeys) steps.push("keys");
  return steps;
}

export function summarizeWhat(draft: SharingDraft): string {
  if (draft.audience === "private") return "";
  if (draft.permission === "edit") {
    return draft.audience === "public"
      ? "Install their own copy"
      : "Use it or install a copy";
  }
  const parts = ["Use your app"];
  if (signInIsOptional(draft.audience) && draft.requireSignIn) {
    parts.push("sign-in required");
  }
  if (perUserDataAvailable(draft) && draft.perUserIsolation) {
    parts.push("own data each");
  }
  return parts.join(" · ");
}

export function summarizeKeys(
  specs: RequiredKeySpec[] | null,
  missing: RequiredKeySpec[] = [],
): string {
  if (specs === null) return "Checking…";
  if (specs.length === 0) return "None needed";
  if (missing.length > 0) {
    return `${missing.length} missing on your account`;
  }
  const mine = specs.filter((s) => s.credentialScope === "owner").length;
  const theirs = specs.length - mine;
  return [mine && `${mine} on yours`, theirs && `${theirs} on theirs`]
    .filter(Boolean)
    .join(" · ");
}

/* ── Missing keys: a status on the bar, not a sharing setting ─────────── */

/** Keys set to "Mine" that aren't in the owner's keychain. Visitors hit errors on these. */
export function missingOwnerKeys(
  specs: RequiredKeySpec[],
  ownedKeyNames: Iterable<string>,
): RequiredKeySpec[] {
  const owned = new Set(ownedKeyNames);
  return specs.filter(
    (spec) => spec.credentialScope === "owner" && !owned.has(spec.name),
  );
}

/** Red when the app can't work without one of them; orange when all are optional. */
export function missingKeysTone(
  missing: RequiredKeySpec[],
): "bad" | "warn" | null {
  if (missing.length === 0) return null;
  return missing.some((spec) => spec.required !== false) ? "bad" : "warn";
}

export function missingKeysLabel(missing: RequiredKeySpec[]): string {
  const n = missing.length;
  return `${n} key${n === 1 ? "" : "s"} missing`;
}
