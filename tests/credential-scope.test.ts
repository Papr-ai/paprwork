import { describe, expect, it } from "vitest";

import type { RequiredKeySpec } from "../src/core/types/bundles.js";
import {
  appRequiresUserSignIn,
  getMissingUserKeyNames,
  getOwnerCredentialKeys,
  getUserCredentialKeys,
  normalizeCredentialRequirements,
  userCredentialsReady,
} from "../src/core/utils/credentialScope.js";

const sampleRequirements: RequiredKeySpec[] = [
  {
    name: "X_BEARER_TOKEN",
    service: "X",
    category: "messaging",
    description: "Post on your behalf",
    required: true,
    credentialScope: "user",
  },
  {
    name: "OPENAI_API_KEY",
    service: "OpenAI",
    category: "ai",
    description: "Owner LLM key",
    required: true,
    credentialScope: "owner",
  },
  {
    name: "OPTIONAL_KEY",
    service: "Optional",
    category: "other",
    description: "",
    required: false,
    credentialScope: "user",
  },
];

describe("credentialScope", () => {
  it("defaults missing scope to user", () => {
    const normalized = normalizeCredentialRequirements([
      {
        name: "NEON_DB_URL",
        service: "Neon",
        category: "database",
        description: "",
        required: true,
      },
    ]);
    expect(normalized[0]?.credentialScope).toBe("user");
  });

  it("splits owner vs user keys", () => {
    expect(getUserCredentialKeys(sampleRequirements).map((s) => s.name)).toEqual([
      "X_BEARER_TOKEN",
    ]);
    expect(getOwnerCredentialKeys(sampleRequirements).map((s) => s.name)).toEqual([
      "OPENAI_API_KEY",
    ]);
  });

  it("requires sign-in when user keys exist", () => {
    expect(appRequiresUserSignIn(sampleRequirements)).toBe(true);
    expect(
      appRequiresUserSignIn([
        {
          name: "OPENAI_API_KEY",
          service: "OpenAI",
          category: "ai",
          description: "",
          required: true,
          credentialScope: "owner",
        },
      ]),
    ).toBe(false);
  });

  it("detects missing user vault keys", () => {
    const missing = getMissingUserKeyNames(sampleRequirements, ["X_BEARER_TOKEN"]);
    expect(missing).toEqual([]);
    expect(getMissingUserKeyNames(sampleRequirements, [])).toEqual([
      "X_BEARER_TOKEN",
    ]);
    expect(userCredentialsReady(sampleRequirements, ["X_BEARER_TOKEN"])).toBe(true);
  });
});
