import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { missingCookieKeyNames } from "../src/gateway/services/platforms/platformCookiePresence.js";

const REPO_ROOT = path.resolve(__dirname, "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/** Strip comments so a static guard cannot be satisfied by prose that names the symbol. */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function requireIndex(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(
    index,
    `expected to find ${JSON.stringify(needle)} — the guard cannot check ordering without it`,
  ).toBeGreaterThan(-1);
  return index;
}

describe("missingCookieKeyNames", () => {
  it("reports every required name when nothing is stored", () => {
    expect(
      missingCookieKeyNames(["LINKEDIN_LI_AT", "LINKEDIN_JSESSIONID"], []),
    ).toEqual(["LINKEDIN_LI_AT", "LINKEDIN_JSESSIONID"]);
  });

  it("reports nothing when every required name is stored", () => {
    expect(
      missingCookieKeyNames(
        ["X_AUTH_TOKEN", "X_CT0"],
        ["PAPR_API_KEY", "X_AUTH_TOKEN", "X_CT0", "NEON_DATABASE_URL"],
      ),
    ).toEqual([]);
  });

  it("reports only the names that are absent", () => {
    expect(
      missingCookieKeyNames(
        ["X_AUTH_TOKEN", "X_CT0"],
        ["X_AUTH_TOKEN"],
      ),
    ).toEqual(["X_CT0"]);
  });

  // The real lookup normalises both sides with trim().toUpperCase(). Comparing raw
  // names would be stricter than the lookup, so a key the lookup finds would be
  // called missing — reporting a connected platform as disconnected.
  it("matches case-insensitively, as the authoritative lookup does", () => {
    expect(
      missingCookieKeyNames(["LINKEDIN_LI_AT"], ["linkedin_li_at"]),
    ).toEqual([]);
  });

  it("ignores surrounding whitespace on a stored name", () => {
    expect(
      missingCookieKeyNames(["LINKEDIN_LI_AT"], ["  LINKEDIN_LI_AT  "]),
    ).toEqual([]);
  });

  it("returns the required name in its original form, not normalised", () => {
    // The caller feeds this straight back into getKeyByName, so the name must come
    // out the way it went in.
    expect(missingCookieKeyNames(["linkedin_li_at"], [])).toEqual([
      "linkedin_li_at",
    ]);
  });

  it("treats a platform with no required cookies as fully present", () => {
    expect(missingCookieKeyNames([], ["ANYTHING"])).toEqual([]);
  });

  it("accepts a Set of stored names as well as an array", () => {
    expect(
      missingCookieKeyNames(["X_CT0"], new Set(["X_AUTH_TOKEN", "X_CT0"])),
    ).toEqual([]);
  });
});

describe("verifyPlatformCookies decides absence before reading a secret", () => {
  const source = stripComments(
    readSource("src/gateway/services/platforms/PlatformSessionService.ts"),
  );

  // Scope every offset check to the method, so a listKeys call elsewhere in this
  // 1900-line file cannot stand in for the one that has to guard the value reads.
  function verifyMethodBody(): string {
    const start = requireIndex(source, "private async verifyPlatformCookies(");
    const rest = source.slice(start);
    const end = rest.indexOf("\n  /**", 1);
    return end > 0 ? rest.slice(0, end) : rest;
  }

  it("consults listKeys before any getKeyByName in the method", () => {
    const body = verifyMethodBody();
    const listIndex = requireIndex(body, "listKeys()");
    const readIndex = requireIndex(body, "getKeyByName(");
    expect(
      listIndex,
      "getKeyByName must not be reached before listKeys has ruled out absence — " +
        "establishing absence by reading a secret costs an IPC timeout per key",
    ).toBeLessThan(readIndex);
  });

  it("gates the value reads on the missing-name check", () => {
    const body = verifyMethodBody();
    const gateIndex = requireIndex(body, "missingCookieKeyNames(");
    const readIndex = requireIndex(body, "getKeyByName(");
    expect(gateIndex).toBeLessThan(readIndex);
  });

  it("returns early when a required name is not stored", () => {
    const body = verifyMethodBody();
    expect(body).toMatch(
      /missingCookieKeyNames\([^)]*\)\.length > 0\s*\)\s*\{\s*return false;/,
    );
  });
});

describe("getAllStatuses stays serial while saveStore is unlocked", () => {
  const source = stripComments(
    readSource("src/gateway/services/platforms/PlatformSessionService.ts"),
  );

  // getStatus mutates this.store and persists it with a bare writeFile. Running the
  // per-platform checks concurrently would interleave read-modify-write on shared
  // state and race the file. The list cache is what makes the serial loop cheap, so
  // these two facts have to change together or not at all.
  it("saveStore is still an unlocked writeFile", () => {
    expect(source).toMatch(
      /private async saveStore\(\): Promise<void> \{\s*await fs\.writeFile\(/,
    );
  });

  it("does not run per-platform status checks concurrently", () => {
    const start = requireIndex(source, "async getAllStatuses(");
    const body = source.slice(start, start + 1200);
    expect(
      /Promise\.(all|allSettled)\s*\(/.test(body),
      "parallelising getAllStatuses races saveStore's unlocked writeFile — " +
        "serialise the store write first if this ever needs to be concurrent",
    ).toBe(false);
  });
});

describe("the REQUEST_KEYS fallback does not re-pay a full timeout", () => {
  const source = stripComments(
    readSource("src/gateway/services/CustomKeysService.ts"),
  );

  it("uses a shorter budget than the primary request", () => {
    const primary = source.match(/IPC_TIMEOUT_MS = ([\d_]+)/);
    const fallback = source.match(/FALLBACK_IPC_TIMEOUT_MS = ([\d_]+)/);
    expect(primary?.[1]).toBeDefined();
    expect(fallback?.[1]).toBeDefined();
    const primaryMs = Number(primary![1].replace(/_/g, ""));
    const fallbackMs = Number(fallback![1].replace(/_/g, ""));
    expect(
      fallbackMs,
      "the fallback reaches main over the same channel the primary just failed on, " +
        "so a second full-length wait only doubles the cost of a miss",
    ).toBeLessThan(primaryMs);
    expect(fallbackMs).toBeGreaterThan(0);
  });

  it("bounds the fallback call against that budget", () => {
    const fallbackIndex = requireIndex(source, "resolveKeysViaIpc([name]");
    const window = source.slice(fallbackIndex - 400, fallbackIndex + 600);
    expect(window).toContain("Promise.race");
    expect(window).toContain("this.FALLBACK_IPC_TIMEOUT_MS");
  });

  it("abandons the fallback rather than treating the budget as a value", () => {
    // Resolving the race with null would be indistinguishable from main answering
    // "no such key", which would poison the value cache with a false absence.
    const fallbackIndex = requireIndex(source, "resolveKeysViaIpc([name]");
    const window = source.slice(fallbackIndex - 400, fallbackIndex + 900);
    expect(window).toContain("BUDGET_EXPIRED");
  });
});
