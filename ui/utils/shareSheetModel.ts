/**
 * Share sheet v6 — "Share is three questions": who, what they can do, whose keys.
 * Pure logic only, so the sheet, the bar chip and tests read one source.
 * Reference: Share Bar Redesign prototype (v6).
 *
 * Share only exists once an app is live — the bar's Publish is how an app gets
 * there, so this sheet never publishes.
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

/** How far an audience reaches; used only to tell widening from narrowing. */
const AUDIENCE_REACH: Record<ShareAudience, number> = {
  private: 0,
  people: 1,
  team: 2,
  link: 3,
  public: 4,
};

export interface SharingConfirmPrompt {
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * Narrowing saves instantly. Opening the app up — or changing whose data
 * people see — waits for one explicit confirm, so a stray click on the way to
 * another option never exposes anything. Returns null when no confirm is needed.
 *
 * "Specific people" is exempt: the person list is already an explicit choice.
 */
export function sharingConfirmPrompt(
  saved: SharingDraft,
  next: SharingDraft,
): SharingConfirmPrompt | null {
  const widens =
    AUDIENCE_REACH[next.audience] > AUDIENCE_REACH[saved.audience] &&
    next.audience !== "people";
  if (widens && next.audience === "public") {
    return {
      title: "List it in Community?",
      body: "Anyone can find it in Community Apps and install their own copy.",
      confirmLabel: "List in Community",
    };
  }
  if (widens && next.audience === "link") {
    return {
      title: "Open it to anyone with the link?",
      body: next.requireSignIn
        ? "Anyone who has the link and signs in with Papr can open it."
        : "Anyone who has the link can open it. No account needed.",
      confirmLabel: "Open to link",
    };
  }
  if (widens && next.audience === "team") {
    return {
      title: "Share with your whole workspace?",
      body: "Everyone in your Papr workspace will be able to open it.",
      confirmLabel: "Share with workspace",
    };
  }
  if (
    next.audience === saved.audience &&
    saved.requireSignIn &&
    !next.requireSignIn
  ) {
    return {
      title: "Stop requiring sign-in?",
      body: "Anyone with the link can open it without an account, and everyone shares one database.",
      confirmLabel: "Remove sign-in",
    };
  }
  if (
    next.audience !== "private" &&
    saved.perUserIsolation !== next.perUserIsolation
  ) {
    return next.perUserIsolation
      ? {
          title: "Give each person their own data?",
          body: "Each person starts with an empty private database. What they see today goes away for them; your data stays with you.",
          confirmLabel: "Separate data",
        }
      : {
          title: "Share one database with everyone?",
          body: "Everyone who opens it will see and change the same data. Their separate data stops being used.",
          confirmLabel: "Share one database",
        };
  }
  if (
    saved.permission !== "edit" &&
    next.permission === "edit" &&
    next.audience !== "public"
  ) {
    return {
      title: "Let them install a copy?",
      body: "They can install their own copy of your app's code. Your data isn't included.",
      confirmLabel: "Allow copies",
    };
  }
  return null;
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
