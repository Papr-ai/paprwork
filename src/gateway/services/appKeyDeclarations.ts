/**
 * Declared app keys.
 *
 * Every key a published app asks for has to be declared by someone who knows
 * what it is: the agent (declare_app_keys, or rich requiredKeys on
 * create_job/update_job) or the publisher (Share → API keys). Automation still
 * finds key names in backend/manifest.json and linked jobs, but it only checks
 * that each was declared. It no longer writes guesses into requirements.json.
 *
 * The guesses were the bug: a job parameter like ${TASK} became a "key", every
 * guess got the same placeholder description, and any row that lost its scope
 * fell back to "user", so visitors were asked to paste the owner's secrets.
 */

import type { RequiredKeySpec } from "../../core/types/bundles.js";
import { lookupService } from "../../core/data/knownServices.js";

/** What auto-sync used to write for every detected key. A row with it was never reviewed. */
export const AUTO_DETECTED_KEY_DESCRIPTION =
  "Server-side key for published app (synced from backend manifest, linked jobs, or app chat)";

export type DetectedKeySource = "backend" | "job-requiredKeys" | "job-command";

export interface DetectedKeyRef {
  name: string;
  source: DetectedKeySource;
  jobId?: string;
}

export type UndeclaredReason =
  /** Found in code, no entry in requirements.json. */
  | "not_declared"
  /** In requirements.json, but written by the old auto-sync, never reviewed. */
  | "auto_detected"
  /** Visitors are asked for it, with nothing telling them what it is for. */
  | "missing_description";

export type SuggestedProvider = "owner" | "user" | "not_a_key";

export interface UndeclaredKey {
  name: string;
  reason: UndeclaredReason;
  /** Where the name was found ("requirements.json" when only there). */
  foundIn: string[];
  suggestion?: SuggestedProvider;
  hint: string;
}

/** Names that read as credentials. A ${NAME} that matches none of these is usually a parameter. */
const SECRET_NAME_PATTERN =
  /(API_?KEY|_KEY|_KEY_ID|TOKEN|SECRET|PASSWORD|PASSWD|_PAT|_DSN|_LI_AT|COOKIE|CREDENTIALS?|_DB_URL|DATABASE_URL|_URI|SERVICE_ACCOUNT|_SA|WEBHOOK(_URL)?|SESSION(_?ID)?|JSESSIONID|_AUTH)$/i;
/** Credential words anywhere in the name: JOE_PAPR_API_KEY_V3, GDRIVE_SA_JSON. */
const SECRET_WORD_PATTERN =
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|SERVICE_ACCOUNT|SA|WEBHOOK|CREDENTIALS?|COOKIE|SESSION)(_|$)/i;

export function looksLikeCredentialName(name: string): boolean {
  const trimmed = name.trim();
  return (
    SECRET_NAME_PATTERN.test(trimmed) ||
    SECRET_WORD_PATTERN.test(trimmed) ||
    lookupService(trimmed) !== undefined
  );
}

/** True when a requirements.json row is a real decision someone made, not a leftover guess. */
export function isDeclaredSpec(spec: RequiredKeySpec): boolean {
  // Owner keys are never shown to visitors (they resolve from the publisher's
  // vault), so an old auto-synced owner row is harmless and does not block.
  // Only rows that put a question in front of visitors need a real decision.
  if (spec.credentialScope !== "user") {
    return true;
  }
  const description = spec.description?.trim() ?? "";
  return description.length > 0 && description !== AUTO_DETECTED_KEY_DESCRIPTION;
}

function describeSource(ref: DetectedKeyRef): string {
  switch (ref.source) {
    case "backend":
      return "backend/manifest.json";
    case "job-requiredKeys":
      return `job ${ref.jobId ?? "?"} requiredKeys`;
    case "job-command":
      return `\${${ref.name}} in job ${ref.jobId ?? "?"} command`;
  }
}

function suggestFor(
  name: string,
  reason: UndeclaredReason,
  ownerVaultKeyNames: ReadonlySet<string>,
): { suggestion?: SuggestedProvider; hint: string } {
  if (reason === "missing_description") {
    return {
      suggestion: "user",
      hint: "Each visitor is asked for this. Add a one-line purpose they will read, or make it yours (owner).",
    };
  }
  const inVault = ownerVaultKeyNames.has(name);
  const credentialLike = looksLikeCredentialName(name);
  if (inVault) {
    return {
      suggestion: "owner",
      hint: "It is in your vault, so it is a real key. Usually yours (owner); use user only if each visitor must use their own account.",
    };
  }
  if (!credentialLike) {
    return {
      suggestion: "not_a_key",
      hint: "Not in your vault and not named like a credential, so it is probably a job parameter. If so, list it in notKeys.",
    };
  }
  return {
    hint: "Named like a credential but not in your vault. Decide: you provide it (owner, then add it in Settings) or each visitor brings their own (user).",
  };
}

/**
 * Keys that block a publish until someone declares them.
 * Pure: callers pass the owner's vault key names (names only) for the hints.
 */
export function findUndeclaredKeys(params: {
  saved: RequiredKeySpec[];
  detected: DetectedKeyRef[];
  notKeys: readonly string[];
  ownerVaultKeyNames?: ReadonlySet<string> | readonly string[];
}): UndeclaredKey[] {
  const notKeys = new Set(params.notKeys.map((name) => name.trim()));
  const vault =
    params.ownerVaultKeyNames instanceof Set
      ? params.ownerVaultKeyNames
      : new Set(params.ownerVaultKeyNames ?? []);
  const savedByName = new Map(params.saved.map((spec) => [spec.name, spec]));

  const foundIn = new Map<string, string[]>();
  for (const ref of params.detected) {
    const name = ref.name.trim();
    if (!name || notKeys.has(name)) continue;
    const where = foundIn.get(name) ?? [];
    const label = describeSource(ref);
    if (!where.includes(label)) where.push(label);
    foundIn.set(name, where);
  }

  const result: UndeclaredKey[] = [];
  const add = (name: string, reason: UndeclaredReason) => {
    result.push({
      name,
      reason,
      foundIn: foundIn.get(name) ?? ["requirements.json"],
      ...suggestFor(name, reason, vault),
    });
  };

  for (const name of foundIn.keys()) {
    if (!savedByName.has(name)) add(name, "not_declared");
  }
  for (const spec of params.saved) {
    if (notKeys.has(spec.name) || isDeclaredSpec(spec)) continue;
    const description = spec.description?.trim() ?? "";
    add(
      spec.name,
      description === AUTO_DETECTED_KEY_DESCRIPTION ? "auto_detected" : "missing_description",
    );
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function formatUndeclaredKeysMessage(
  appId: string,
  undeclared: UndeclaredKey[],
): string {
  const lines = undeclared.map((key) => {
    const suggestion = key.suggestion ? ` Suggested: ${key.suggestion}.` : "";
    return `- ${key.name} (${key.foundIn.join(", ")}): ${key.hint}${suggestion}`;
  });
  return (
    `Publish blocked: ${undeclared.length} key${undeclared.length === 1 ? "" : "s"} not declared for app ${appId}. ` +
    `Visitors would see these with no explanation, so say what each one is first.\n` +
    `${lines.join("\n")}\n` +
    `Fix: declare_app_keys({ appId: "${appId}", keys: [{ name, purpose, provider: "owner" | "user", required }], notKeys: [...] }) ` +
    `(or Share → API keys), then publish again. Ask the user only when it is unclear who should pay for a paid API.`
  );
}

export class AppKeysUndeclaredError extends Error {
  readonly code = "app_keys_undeclared";
  constructor(
    readonly appId: string,
    readonly detail: UndeclaredKey[],
  ) {
    super(formatUndeclaredKeysMessage(appId, detail));
    this.name = "AppKeysUndeclaredError";
  }
}
