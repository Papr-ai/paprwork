import { describe, expect, it } from "vitest";
import {
  gcsObjectPrefixForApp,
  gcsObjectPrefixForNamespace,
} from "../src/gateway/services/appRuntime/gcsSharedCache.js";

describe("gcs shared cache object prefixes", () => {
  it("scopes delete prefix to one published app", () => {
    expect(gcsObjectPrefixForApp("ns-abc", "leadership-sync")).toBe(
      "repo-files/ns-abc%3Aleadership-sync%3A",
    );
  });

  it("scopes delete prefix to a namespace without matching sibling namespaces", () => {
    const ns1 = gcsObjectPrefixForNamespace("ns-1");
    const ns10 = gcsObjectPrefixForNamespace("ns-10");
    expect(ns1).toBe("repo-files/ns-1%3A");
    expect(ns10).toBe("repo-files/ns-10%3A");
    expect("repo-files/ns-10%3Arev%3Aindex.html".startsWith(ns1)).toBe(false);
  });
});
