/**
 * Storage and resolution for scoped share links.
 *
 * Two JSON files live beside the app source, so they version with the app
 * and travel through Cloud Sync like any other app metadata:
 *
 *   __papr__/share-policy.json      scope name -> tables/columns/predicates
 *   __papr__/share-recipients.json  slug -> label, passcode, scopes, vars
 *
 * Kept as files rather than rows because policy is code-shaped: it is
 * reviewed, diffed, and deployed with the app, and a database that the app
 * itself can write must never be the source of truth for who may read it.
 *
 * This module is deliberately I/O-only plus caching. All access decisions
 * live in core/utils/shareScope.ts so they can be unit tested without a
 * filesystem.
 */

import fs from "node:fs";
import path from "node:path";

import {
  passcodeMatches,
  resolveScopeContext,
  ScopeViolationError,
  type ScopeContext,
  type SharePolicy,
  type ShareRecipient,
} from "../../../core/utils/shareScope.js";

export const SHARE_POLICY_FILE = "share-policy.json";
export const SHARE_RECIPIENTS_FILE = "share-recipients.json";
const META_DIR = "__papr__";

/** Cookie carrying a verified recipient slug for an app. */
export const SCOPED_RECIPIENT_COOKIE = "papr_recipient";

interface CacheEntry {
  policy: SharePolicy;
  recipients: Record<string, ShareRecipient>;
  /** mtimeMs of both files, so edits are picked up without a restart. */
  stamp: string;
}

const cache = new Map<string, CacheEntry>();

function metaPath(appDir: string, file: string): string {
  return path.join(appDir, META_DIR, file);
}

function statStamp(filePath: string): string {
  try {
    const s = fs.statSync(filePath);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    // A malformed policy must not be treated as "no policy" — that would
    // turn a typo into an open door. Surface it instead.
    throw new Error(
      `Invalid ${path.basename(filePath)}: ${(err as Error).message}`,
    );
  }
}

/**
 * Load policy + recipients for an app, honouring on-disk edits.
 * Returns null when the app has no scoped sharing configured at all.
 */
export function loadShareConfig(
  appId: string,
  appDir: string,
): { policy: SharePolicy; recipients: Record<string, ShareRecipient> } | null {
  const policyPath = metaPath(appDir, SHARE_POLICY_FILE);
  const recipientsPath = metaPath(appDir, SHARE_RECIPIENTS_FILE);
  const stamp = `${statStamp(policyPath)}|${statStamp(recipientsPath)}`;

  const cached = cache.get(appId);
  if (cached && cached.stamp === stamp) {
    return { policy: cached.policy, recipients: cached.recipients };
  }

  if (stamp === "absent|absent") {
    cache.delete(appId);
    return null;
  }

  const policy = readJson<SharePolicy>(policyPath, { scopes: {} });
  const recipientList = readJson<ShareRecipient[]>(recipientsPath, []);

  const recipients: Record<string, ShareRecipient> = {};
  for (const r of recipientList) {
    if (!r?.slug) continue;
    recipients[r.slug.toLowerCase()] = { ...r, appId };
  }

  cache.set(appId, { policy, recipients, stamp });
  return { policy, recipients };
}

export function hasScopedSharing(appId: string, appDir: string): boolean {
  return loadShareConfig(appId, appDir) !== null;
}

export interface ResolvedRecipient {
  recipient: ShareRecipient;
  scope: ScopeContext;
  policy: SharePolicy;
}

/**
 * Resolve a slug to an authorized recipient.
 *
 * `providedPasscode` is only required when the recipient has one. Throws
 * ScopeViolationError for unknown slugs, revoked links, and bad passcodes —
 * all with the same shape, so the response cannot be used to enumerate
 * which slugs exist.
 */
export function resolveRecipient(
  appId: string,
  appDir: string,
  slug: string,
  providedPasscode?: string,
): ResolvedRecipient {
  const config = loadShareConfig(appId, appDir);
  if (!config) throw new ScopeViolationError("Invalid or expired link");

  const recipient = config.recipients[slug.trim().toLowerCase()];
  if (!recipient) throw new ScopeViolationError("Invalid or expired link");
  if (recipient.revokedAt) throw new ScopeViolationError("Invalid or expired link");
  if (!passcodeMatches(recipient.passcode, providedPasscode)) {
    throw new ScopeViolationError("Invalid or expired link");
  }

  const scope = resolveScopeContext(recipient, config.policy);
  return { recipient, scope, policy: config.policy };
}

/** Drop cached config for an app (used after the UI edits recipients). */
export function invalidateShareConfig(appId: string): void {
  cache.delete(appId);
}

export function writeRecipients(
  appId: string,
  appDir: string,
  recipients: ShareRecipient[],
): void {
  const dir = path.join(appDir, META_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, SHARE_RECIPIENTS_FILE),
    `${JSON.stringify(recipients, null, 2)}\n`,
    "utf-8",
  );
  invalidateShareConfig(appId);
}

export function writePolicy(
  appId: string,
  appDir: string,
  policy: SharePolicy,
): void {
  const dir = path.join(appDir, META_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, SHARE_POLICY_FILE),
    `${JSON.stringify(policy, null, 2)}\n`,
    "utf-8",
  );
  invalidateShareConfig(appId);
}
