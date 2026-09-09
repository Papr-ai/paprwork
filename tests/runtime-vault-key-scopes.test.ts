import { describe, expect, it } from "vitest";

import {
  mergeRuntimeVaultKeyNames,
  runtimeVaultKeyLookupScopes,
} from "../src/gateway/services/appRuntime/runtimeVaultKeyScopes.js";

describe("runtimeVaultKeyLookupScopes", () => {
  it("queries user scope when no namespace id", () => {
    expect(runtimeVaultKeyLookupScopes(undefined)).toEqual([
      { scope: "user", query: "scope=user" },
    ]);
  });

  it("queries user and namespace scopes for published apps", () => {
    expect(runtimeVaultKeyLookupScopes("85ZIB7mD1V")).toEqual([
      {
        scope: "user",
        query: "scope=user&namespace_id=85ZIB7mD1V",
      },
      {
        scope: "namespace",
        query: "scope=namespace&namespace_id=85ZIB7mD1V",
      },
    ]);
  });
});

describe("mergeRuntimeVaultKeyNames", () => {
  it("deduplicates names across scopes", () => {
    expect(
      mergeRuntimeVaultKeyNames(
        ["REDDIT_REDDIT_SESSION", "EXA_API_KEY"],
        ["REDDIT_SESSION_COOKIE", "EXA_API_KEY"],
      ),
    ).toEqual(["REDDIT_REDDIT_SESSION", "EXA_API_KEY", "REDDIT_SESSION_COOKIE"]);
  });
});
