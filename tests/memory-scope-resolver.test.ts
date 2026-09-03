import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMemoryScope } from "../src/gateway/services/storage/IStorageProvider.js";

describe("memoryScopeResolver chat scope", () => {
  const chatScopes = new Map<string, ChatMemoryScope>();

  beforeEach(() => {
    chatScopes.clear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadResolver() {
    vi.doMock("../src/core/utils/paprWorkspace.js", () => ({
      readActiveWorkspacePointer: () => ({
        organizationId: "org-xyz",
        namespaceId: "ns-abc",
      }),
    }));

    vi.doMock("../src/gateway/utils/paprUserId.js", () => ({
      getPaprUserId: () => "user-1",
    }));

    vi.doMock("../src/gateway/services/settingsStore.js", () => ({
      loadSettings: async () => ({
        preferences: { defaultMemoryScope: "user" as const },
      }),
    }));

    vi.doMock("../src/gateway/services/AgentService.js", () => ({
      getAgentService: () => ({
        getStorageManager: () => ({
          getChat: async (chatId: string) =>
            chatScopes.has(chatId)
              ? { memory_scope: chatScopes.get(chatId) }
              : null,
        }),
      }),
    }));

    return import("../src/gateway/utils/memoryScopeResolver.js");
  }

  it("uses chat memory_scope for writes when chatId is provided", async () => {
    chatScopes.set("chat-org", "org");
    const { buildPaprMemoryWriteScope } = await loadResolver();
    const scope = await buildPaprMemoryWriteScope({ chatId: "chat-org" });
    expect(scope.policy?.acl?.read).toContain("organization:org-xyz");
  });

  it("falls back to settings default when chat has no scope", async () => {
    const { buildPaprMemoryWriteScope } = await loadResolver();
    const scope = await buildPaprMemoryWriteScope({ chatId: "chat-no-scope" });
    expect(scope.user_id).toBe("user-1");
    expect(scope.external_user_id).toBe("user-1");
    expect(scope.policy?.acl?.read).toBeUndefined();
  });

  it("explicit read ACL overrides chat scope read principals", async () => {
    chatScopes.set("chat-team", "namespace");
    const { buildPaprMemoryWriteScope } = await loadResolver();
    const scope = await buildPaprMemoryWriteScope({
      chatId: "chat-team",
      explicitReadAcl: {
        shareWithUserIds: ["attendee-1"],
      },
    });
    expect(scope.policy?.acl?.read).toEqual(["user:attendee-1"]);
    expect(scope.policy?.acl?.write).toEqual(["user:user-1"]);
    expect(scope.policy?.acl?.read).not.toContain("namespace:ns-abc");
  });
});

describe("resolveExplicitReadAclFromToolArgs", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when no ACL fields are set", async () => {
    const { resolveExplicitReadAclFromToolArgs } = await import(
      "../src/gateway/utils/memoryScopeResolver.js"
    );
    expect(resolveExplicitReadAclFromToolArgs({})).toBeUndefined();
  });

  it("maps shareWithTeam and shareWithOrganization to namespace/org principals", async () => {
    vi.doMock("../src/core/utils/paprWorkspace.js", () => ({
      readActiveWorkspacePointer: () => ({
        organizationId: "org-xyz",
        namespaceId: "ns-abc",
      }),
    }));
    vi.doMock("../src/gateway/utils/paprUserId.js", () => ({
      getPaprUserId: () => "user-1",
    }));

    const { resolveExplicitReadAclFromToolArgs } = await import(
      "../src/gateway/utils/memoryScopeResolver.js"
    );

    expect(
      resolveExplicitReadAclFromToolArgs({
        shareWithTeam: true,
        shareWithOrganization: true,
      }),
    ).toEqual({
      readAcl: undefined,
      shareWithUserIds: undefined,
      shareWithNamespaceId: "ns-abc",
      shareWithOrganizationId: "org-xyz",
    });
  });
});
