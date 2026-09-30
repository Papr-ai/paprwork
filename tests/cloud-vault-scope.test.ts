/**
 * Vault scope mapping for memory server sync payloads.
 */

import { describe, expect, it } from "vitest";

import {
  buildCloudVaultRequestBody,
  mapCustomKeyMetadataToVaultEntry,
} from "../src/core/utils/cloudReposScope.js";

describe("mapCustomKeyMetadataToVaultEntry", () => {
  it("maps audience Only me → shareScope user", () => {
    const entry = mapCustomKeyMetadataToVaultEntry({
      meta: {
        name: "EXA_API_KEY",
        vaultAudience: "user",
        permission: "always",
        clientAccess: "server",
      },
      value: "secret",
      source: "manual",
    });
    expect(entry.shareScope).toBe("user");
    expect(entry.permission).toBe("always_allow");
  });

  it("maps audience Team → shareScope namespace", () => {
    const entry = mapCustomKeyMetadataToVaultEntry({
      meta: {
        name: "NEON_HOST",
        vaultAudience: "namespace",
      },
      value: "secret",
      source: "manual",
    });
    expect(entry.shareScope).toBe("namespace");
  });

  it("maps audience Organization → shareScope org", () => {
    const entry = mapCustomKeyMetadataToVaultEntry({
      meta: {
        name: "ANTHROPIC_API_KEY",
        vaultAudience: "org",
        source: "oauth",
      },
      value: "sk-ant-test",
      source: "oauth",
    });
    expect(entry.shareScope).toBe("org");
    expect(entry.source).toBe("oauth");
  });

  it("includes targetOrgId for specific organization scope", () => {
    const entry = mapCustomKeyMetadataToVaultEntry({
      meta: {
        name: "PAPRWORK_PUBLICREPOS",
        vaultAudience: "org",
        orgScope: "organization",
        organizationId: "Y8D4H7Yp3Z",
      },
      value: "token",
      source: "manual",
    });
    expect(entry.targetOrgId).toBe("Y8D4H7Yp3Z");
  });
});

describe("buildCloudVaultRequestBody", () => {
  it("includes per-key shareScope in sync payload", () => {
    const body = buildCloudVaultRequestBody(
      [
        {
          name: "ANTHROPIC_API_KEY",
          value: "x",
          shareScope: "org",
          clientAccess: "server",
        },
        {
          name: "REDDIT_SESSION_COOKIE",
          value: "y",
          shareScope: "user",
        },
      ],
      "user",
    );
    expect(body.scope).toBe("user");
    expect(body.keys).toHaveLength(2);
    expect(body.keys[0]?.shareScope).toBe("org");
    expect(body.keys[1]?.shareScope).toBe("user");
  });
});
