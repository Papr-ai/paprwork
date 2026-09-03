import { describe, expect, it } from "vitest";
import {
  buildPaprMemoryUserIdentity,
  mergeUserIdentityIntoMetadata,
  spreadMemoryScopeUserIdentity,
  spreadPaprMemoryUserIdentity,
} from "../src/core/utils/paprMemoryUserIdentity.js";

describe("paprMemoryUserIdentity", () => {
  it("builds dual identity from Parse objectId", () => {
    expect(buildPaprMemoryUserIdentity("WkPutXGdqg")).toEqual({
      user_id: "WkPutXGdqg",
      external_user_id: "WkPutXGdqg",
    });
  });

  it("spreads empty object when user id missing", () => {
    expect(spreadPaprMemoryUserIdentity(undefined)).toEqual({});
    expect(spreadMemoryScopeUserIdentity({})).toEqual({});
  });

  it("merges identity into metadata for single-add auth", () => {
    expect(
      mergeUserIdentityIntoMetadata(
        { role: "user", category: "fact" },
        "WkPutXGdqg",
      ),
    ).toEqual({
      role: "user",
      category: "fact",
      user_id: "WkPutXGdqg",
      external_user_id: "WkPutXGdqg",
    });
  });
});
