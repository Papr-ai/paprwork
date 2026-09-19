/**
 * Guards for the Papr Cloud billing render loop in the chat renderer.
 *
 * Measured symptom: the renderer held ~120% CPU for a whole session, with RSS
 * climbing 464 -> 730 MB. Profiling put React's synchronous render path at the
 * top, and a commit-hook trace named `usePaprCloudFeatureContext` as the
 * scheduler, running ~9 times a second while completely idle.
 *
 * Four separate properties had to hold for that loop to run, and every one of
 * them is a shape a unit test can pin:
 *
 *  1. `refresh` listed `cloudStatus` as a dependency while itself writing that
 *     very value (through `refreshPaprBillingStatus`). So calling `refresh`
 *     gave `refresh` a new identity, which re-ran the effect that called it.
 *  2. The `visibilitychange` listener was an inline arrow, so the cleanup could
 *     not remove it even in principle. With the effect re-running on a loop,
 *     ~19,000 accumulated — each one firing a billing refresh on window show.
 *  3. The stores wrote unconditionally. Zustand compares with `Object.is`, so a
 *     rebuilt-but-identical object always reports a change, which is what let
 *     the loop propagate to subscribers at all.
 *  4. `MessageItemInner` read the profile store whole. It renders once per
 *     message, so one `plan` write re-rendered the entire transcript — the
 *     amplifier that turned a cheap loop into a pegged core.
 *
 * The predicates in (3) are tested behaviourally below; the wiring is asserted
 * statically, since the failure is a React cycle that a unit test cannot
 * reproduce without mounting the real tree.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  boundByRecency,
  touchNewest,
} from "../ui/utils/boundedRecencyMap";
import {
  sameCloudAccessContext,
  sameCloudMemoryStatus,
  samePlanSummary,
  sameProfileFields,
  type ProfileFields,
} from "../ui/utils/storeWriteGuards";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

/** Strips comments so a guard cannot be satisfied by prose that names a symbol. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("sameCloudMemoryStatus", () => {
  const status = { level: "warning", label: "Paused", detail: "Plan paused" };

  it("treats a rebuilt object with identical fields as unchanged", () => {
    // This is the case that ran ~9 times a second: `deriveCloudMemoryStatus`
    // builds a fresh object from data that has not moved.
    expect(sameCloudMemoryStatus(status as never, { ...status } as never)).toBe(
      true,
    );
  });

  it("reports a change when any field differs", () => {
    expect(
      sameCloudMemoryStatus(status as never, {
        ...status,
        detail: "Plan resumed",
      } as never),
    ).toBe(false);
    expect(
      sameCloudMemoryStatus(status as never, {
        ...status,
        level: "error",
      } as never),
    ).toBe(false);
  });

  it("distinguishes null from a status", () => {
    expect(sameCloudMemoryStatus(null, null)).toBe(true);
    expect(sameCloudMemoryStatus(null, status as never)).toBe(false);
    expect(sameCloudMemoryStatus(status as never, null)).toBe(false);
  });
});

describe("sameCloudAccessContext", () => {
  const context = {
    isLoggedIn: true,
    subscriptionActive: true,
    cloudSyncEnabled: false,
    memoryPaused: false,
  };

  it("treats a rebuilt context with identical flags as unchanged", () => {
    expect(
      sameCloudAccessContext(context as never, { ...context } as never),
    ).toBe(true);
  });

  it("reports a change on each flag", () => {
    for (const key of Object.keys(context) as (keyof typeof context)[]) {
      const flipped = { ...context, [key]: !context[key] };
      expect(
        sameCloudAccessContext(context as never, flipped as never),
      ).toBe(false);
    }
  });
});

describe("samePlanSummary", () => {
  function summary() {
    return {
      planName: "Growth",
      planTier: "growth",
      planFeatures: "everything",
      isTrialPeriod: false,
      isWorkspaceOwner: true,
      isWorkspaceAdmin: true,
      canManageBilling: true,
      isMeteredBillingOn: true,
      usage: {
        memoriesCount: 10,
        storageCount: 20,
        memoryStorageCount: 15,
        appStorageCount: 5,
        miniInteractionCount: 3,
      },
      limits: {
        memoriesLimit: 100,
        miniInteractionLimit: 100,
        premiumInteractionLimit: 10,
        storageLimit: "1GB",
        price: 20,
        seats: 1,
      },
      warnings: {
        memoriesExceeded: false,
        storageExceeded: false,
        operationsExceeded: false,
        memoriesNearLimit: false,
        storageNearLimit: false,
        operationsNearLimit: false,
      },
    };
  }

  it("treats a freshly-fetched identical summary as unchanged", () => {
    // Every poll returns a new object graph over the same numbers.
    expect(samePlanSummary(summary() as never, summary() as never)).toBe(true);
  });

  it("sees a change one level down, where the usage numbers live", () => {
    const moved = summary();
    moved.usage.memoriesCount = 11;
    // A suppressed update here would freeze the usage bar, which is the
    // failure worth caring about — so this must be detected.
    expect(samePlanSummary(summary() as never, moved as never)).toBe(false);
  });

  it("sees a change in each nested group", () => {
    const usage = summary();
    usage.usage.storageCount = 999;
    const limits = summary();
    limits.limits.seats = 5;
    const warnings = summary();
    warnings.warnings.storageExceeded = true;

    for (const changed of [usage, limits, warnings]) {
      expect(samePlanSummary(summary() as never, changed as never)).toBe(false);
    }
  });

  it("reports a change when a key is added or removed", () => {
    const extra = { ...summary(), surpriseField: 1 };
    expect(samePlanSummary(summary() as never, extra as never)).toBe(false);
    expect(samePlanSummary(extra as never, summary() as never)).toBe(false);
  });

  it("reports a change rather than guessing when nesting exceeds its budget", () => {
    // The comparison sees two levels, which is exact for the shape as it
    // stands. If a deeper field is ever added, this must degrade to a
    // redundant write and never to a swallowed update.
    const a = { usage: { nested: { deep: 1 } } };
    const b = { usage: { nested: { deep: 1 } } };
    expect(samePlanSummary(a as never, b as never)).toBe(false);
  });

  it("distinguishes null from a summary", () => {
    expect(samePlanSummary(null, null)).toBe(true);
    expect(samePlanSummary(null, summary() as never)).toBe(false);
  });
});

describe("sameProfileFields", () => {
  const fields: ProfileFields = {
    name: "Ada",
    email: "ada@example.com",
    imageUrl: "https://example.com/a.png",
    plan: "Growth",
    organizationName: "Papr",
    namespaceName: "team",
    workspaceName: "main",
  };

  it("treats a re-asserted identical profile as unchanged", () => {
    // The billing refresh writes `plan` on every poll with the same value.
    expect(sameProfileFields(fields, { ...fields })).toBe(true);
  });

  it("reports a change on every field", () => {
    for (const key of Object.keys(fields) as (keyof ProfileFields)[]) {
      expect(
        sameProfileFields(fields, { ...fields, [key]: "different" }),
      ).toBe(false);
    }
  });
});

describe("bounded per-app cache", () => {
  it("keeps everything while under the bound", () => {
    const entries = { a: 1, b: 2, c: 3 };
    expect(boundByRecency(entries, 12)).toBe(entries);
  });

  it("drops the oldest entries once over the bound", () => {
    const entries: Record<string, number> = {};
    for (let i = 0; i < 15; i += 1) {
      entries[`app-${i}`] = i;
    }
    const bounded = boundByRecency(entries, 12);
    expect(Object.keys(bounded)).toHaveLength(12);
    expect(bounded["app-0"]).toBeUndefined();
    expect(bounded["app-2"]).toBeUndefined();
    expect(bounded["app-3"]).toBe(3);
    expect(bounded["app-14"]).toBe(14);
  });

  it("re-writing an existing key moves it to newest", () => {
    // Without this, an app in constant use keeps its original slot and is
    // evicted as though it were stale — so the bound would throw away exactly
    // the entry most worth keeping.
    const entries = { a: 1, b: 2, c: 3 };
    const touched = touchNewest(entries, "a", 9);
    expect(Object.keys(touched)).toEqual(["b", "c", "a"]);
    expect(boundByRecency(touched, 2)).toEqual({ c: 3, a: 9 });
  });

  it("does not mutate the input", () => {
    const entries = { a: 1, b: 2 };
    touchNewest(entries, "a", 9);
    expect(Object.keys(entries)).toEqual(["a", "b"]);
    expect(entries.a).toBe(1);
  });
});

describe("usePaprCloudFeatureContext — the loop cannot re-form", () => {
  it("does not subscribe to the value its own refresh writes", () => {
    const content = stripComments(
      read("ui/hooks/usePaprCloudFeatureContext.ts"),
    );

    // Subscribing put `cloudStatus` in the dependency list, and
    // `refreshPaprBillingStatus` writes it — so `refresh` got a new identity
    // every time it ran.
    expect(content).not.toMatch(
      /useCloudMemoryStatusStore\(\s*\(state\)\s*=>\s*state\.status\s*\)/,
    );
    // Read at call time instead.
    expect(content).toMatch(
      /useCloudMemoryStatusStore\.getState\(\)\.status/,
    );
  });

  it("depends only on the zustand action, which is stable for the hook's life", () => {
    const content = stripComments(
      read("ui/hooks/usePaprCloudFeatureContext.ts"),
    );

    const refreshStart = content.indexOf("const refresh = useCallback(");
    expect(refreshStart).toBeGreaterThan(-1);
    // The dependency array closing the useCallback.
    const deps = content.slice(refreshStart).match(/\}, \[([^\]]*)\]\)/);
    expect(deps).not.toBeNull();
    expect(deps?.[1].trim()).toBe("setContext");
  });

  it("removes the visibilitychange listener it adds", () => {
    const content = stripComments(
      read("ui/hooks/usePaprCloudFeatureContext.ts"),
    );

    // An inline arrow here is unremovable even in principle. ~19,000 of them
    // accumulated in one session.
    expect(content).not.toMatch(
      /addEventListener\(\s*"visibilitychange",\s*\(\)\s*=>/,
    );
    expect(content).toMatch(
      /addEventListener\(\s*"visibilitychange",\s*visibilityHandler\s*\)/,
    );
    expect(content).toMatch(
      /removeEventListener\(\s*"visibilitychange",\s*visibilityHandler\s*\)/,
    );
  });

  it("removes every listener it adds", () => {
    const content = stripComments(
      read("ui/hooks/usePaprCloudFeatureContext.ts"),
    );

    const added = [...content.matchAll(/\.addEventListener\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    const removed = new Set(
      [...content.matchAll(/\.removeEventListener\(\s*"([^"]+)"/g)].map(
        (m) => m[1],
      ),
    );
    expect(added.length).toBeGreaterThan(0);
    for (const eventName of added) {
      expect(removed.has(eventName)).toBe(true);
    }
  });
});

describe("stores compare content before reporting a change", () => {
  it("the cloud memory status store bails out when nothing moved", () => {
    const content = stripComments(read("ui/stores/cloudMemoryStatusStore.ts"));

    expect(content).toMatch(/sameCloudMemoryStatus\(prev\.status, status\)/);
    expect(content).toMatch(/samePlanSummary\(prev\.planSummary, planSummary\)/);
    expect(content).toMatch(/return prev;/);
    // The unconditional form is what propagated the loop.
    expect(content).not.toMatch(/set\(\{\s*status,\s*planSummary,/);
  });

  it("the cloud feature store bails out when the context is equivalent", () => {
    const content = stripComments(read("ui/stores/paprCloudFeatureStore.ts"));

    expect(content).toMatch(/sameCloudAccessContext\(prev\.context, context\)/);
    expect(content).not.toMatch(/setContext:\s*\(context\)\s*=>\s*set\(\{ context \}\)/);
  });

  it("the profile store skips the write and the storage flush", () => {
    const content = stripComments(read("ui/stores/profileStore.ts"));

    const setProfile = content.slice(content.indexOf("setProfile: (profile)"));
    expect(setProfile).toMatch(/sameProfileFields\(current, next\)/);
    // Returning before both the set and the synchronous localStorage write.
    const guardAt = setProfile.indexOf("sameProfileFields(current, next)");
    const setAt = setProfile.indexOf("set(next)");
    const persistAt = setProfile.indexOf("persistProfileSnapshot(next)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(setAt).toBeGreaterThan(guardAt);
    expect(persistAt).toBeGreaterThan(guardAt);
  });
});

describe("MessageItem does not amplify profile writes", () => {
  it("selects profile fields individually rather than the whole store", () => {
    const content = stripComments(read("ui/components/Chat/MessageItem.tsx"));

    // Rendered once per message, so a bare subscription turned a single `plan`
    // write into a re-render of the entire transcript.
    expect(content).not.toMatch(/=\s*useProfileStore\(\)\s*;/);
    expect(content).toMatch(/useProfileStore\(\(s\) => s\.name\)/);
    expect(content).toMatch(/useProfileStore\(\(s\) => s\.imageUrl\)/);
    expect(content).toMatch(/useProfileStore\(\(s\) => s\.loaded\)/);
  });
});

describe("the cloud sync cache read is cheap enough to call freely", () => {
  it("memoises the parsed snapshot", () => {
    const content = stripComments(read("ui/utils/cloudSyncTabCache.ts"));

    // Measured at 233 MB/s of synchronous parsing on the render path. How
    // often a caller reads is the caller's business; making a read cheap is
    // this module's.
    expect(content).toMatch(/if \(memoLoaded\) \{\s*return memo;/);
    expect(content).toMatch(/memo = JSON\.parse\(raw\)/);
  });

  it("invalidates the memo when another window writes", () => {
    const content = stripComments(read("ui/utils/cloudSyncTabCache.ts"));

    expect(content).toMatch(/addEventListener\("storage"/);
    expect(content).toMatch(/memoLoaded = false/);
  });

  it("bounds the per-app map", () => {
    const content = stripComments(read("ui/utils/cloudSyncTabCache.ts"));

    expect(content).toMatch(/boundByRecency\(/);
    expect(content).toMatch(/touchNewest\(/);
    // The unbounded spread is what grew to 4.3MB.
    expect(content).not.toMatch(
      /syncItemsByAppId:\s*\{\s*\.\.\.\(existing\?\.syncItemsByAppId/,
    );
  });
});
