/**
 * Content-equality predicates for store writes that would otherwise report a
 * change whenever they are called.
 *
 * Zustand compares with `Object.is`, so a setter handed a freshly-built object
 * always looks like a change — and a subscriber that feeds that setter (through
 * an effect dependency, say) then has no way to stop. That is exactly how the
 * Papr Cloud billing loop ran ~9 times a second for a whole session: the value
 * was rebuilt from unchanged data, so nothing downstream could tell.
 *
 * These are deliberately conservative: where a shape is deeper than the
 * comparison can see, they report "changed". A redundant write costs a render;
 * a suppressed one loses a real update, which is the worse failure.
 */

import type { PaprPlanSummary } from "../../src/core/types/paprBilling";
import type { PaprCloudAccessContext } from "../../src/core/utils/paprCloudFeatureAccess";
import type { CloudMemoryStatus } from "./cloudMemoryStatus";

/** Papr Cloud status chip: three strings, rebuilt on every billing refresh. */
export function sameCloudMemoryStatus(
  a: CloudMemoryStatus | null,
  b: CloudMemoryStatus | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.level === b.level && a.label === b.label && a.detail === b.detail;
}

/** Feature-access context: four booleans, rebuilt on every refresh. */
export function sameCloudAccessContext(
  a: PaprCloudAccessContext | null,
  b: PaprCloudAccessContext | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.isLoggedIn === b.isLoggedIn &&
    a.subscriptionActive === b.subscriptionActive &&
    a.cloudSyncEnabled === b.cloudSyncEnabled &&
    a.memoryPaused === b.memoryPaused
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * True when every field matches, comparing one level into nested objects.
 *
 * `PaprPlanSummary` is flat primitives plus `usage`, `limits` and `warnings`,
 * each itself flat primitives — so depth 2 is exact for the shape as it stands.
 * Anything nested deeper than that reports "changed" rather than being skipped,
 * so adding a deeper field degrades to a redundant write instead of silently
 * swallowing a genuine usage update.
 */
export function samePlanSummary(
  a: PaprPlanSummary | null,
  b: PaprPlanSummary | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return sameAtDepth(
    a as unknown as Record<string, unknown>,
    b as unknown as Record<string, unknown>,
    2,
  );
}

function sameAtDepth(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  depth: number,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    const av = a[key];
    const bv = b[key];
    if (Object.is(av, bv)) continue;

    if (isPlainObject(av) && isPlainObject(bv)) {
      // Out of budget: report a difference rather than guess they match.
      if (depth <= 1) return false;
      if (!sameAtDepth(av, bv, depth - 1)) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** The seven display strings the profile store holds. */
export interface ProfileFields {
  name: string;
  email: string;
  imageUrl: string;
  plan: string;
  organizationName: string;
  namespaceName: string;
  workspaceName: string;
}

export function sameProfileFields(a: ProfileFields, b: ProfileFields): boolean {
  return (
    a.name === b.name &&
    a.email === b.email &&
    a.imageUrl === b.imageUrl &&
    a.plan === b.plan &&
    a.organizationName === b.organizationName &&
    a.namespaceName === b.namespaceName &&
    a.workspaceName === b.workspaceName
  );
}
