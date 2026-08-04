import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrichRuntimeAuthWithPaprApiKey,
  fetchNamespaceApiKeyForSession,
  runtimeAuthRequiresPaprApiKey,
} from "../src/gateway/services/appRuntime/resolveCloudSessionPaprApiKey.js";

describe("resolveCloudSessionPaprApiKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns existing paprApiKey without GraphQL lookup", async () => {
    const auth = {
      namespaceId: "ns-1",
      slug: "deck-studio",
      paprApiKey: "sk-existing",
      sessionToken: "sess-abc",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichRuntimeAuthWithPaprApiKey(auth);
    expect(enriched?.paprApiKey).toBe("sk-existing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves namespace API key from Parse session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            aPIKeys: {
              edges: [{ node: { key: "sk-org-ns-abc123" } }],
            },
          },
        }),
      }),
    );

    const key = await fetchNamespaceApiKeyForSession("sess-token-123", "ns-1");
    expect(key).toBe("sk-org-ns-abc123");
  });

  it("enriches runtime auth when only session cookie is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            aPIKeys: {
              edges: [{ node: { key: "sk-from-session" } }],
            },
          },
        }),
      }),
    );

    const enriched = await enrichRuntimeAuthWithPaprApiKey({
      namespaceId: "ns-1",
      slug: "deck-studio",
      sessionToken: "sess-token-456",
    });

    expect(enriched?.paprApiKey).toBe("sk-from-session");
  });

  it("flags auth that still lacks paprApiKey and share token", () => {
    expect(
      runtimeAuthRequiresPaprApiKey({
        namespaceId: "ns-1",
        slug: "deck-studio",
        sessionToken: "sess",
      }),
    ).toBe(true);

    expect(
      runtimeAuthRequiresPaprApiKey({
        namespaceId: "ns-1",
        slug: "deck-studio",
        paprApiKey: "sk-1",
      }),
    ).toBe(false);

    expect(
      runtimeAuthRequiresPaprApiKey({
        namespaceId: "ns-1",
        slug: "deck-studio",
        shareToken: "share-1",
      }),
    ).toBe(false);
  });
});
