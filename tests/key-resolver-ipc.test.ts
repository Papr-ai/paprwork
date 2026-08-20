import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearKeyCache,
  getApiKeys,
  getAuthEpoch,
  getPaprApiKey,
  getProviderAuth,
  preserveEnvKeyBeforeOverwrite,
} from "../src/gateway/utils/keyResolver.js";
import type {
  RequestKeysMessage,
  KeysResponseMessage,
} from "../src/core/types/gateway-ipc.js";
import { EventEmitter } from "events";

class FakeIpcProcess extends EventEmitter {
  public sentMessages: RequestKeysMessage[] = [];

  send = (message: unknown): void => {
    const typedMessage = message as RequestKeysMessage;
    this.sentMessages.push(typedMessage);
    const response: KeysResponseMessage = {
      type: "KEYS_RESPONSE",
      requestId: typedMessage.requestId,
      keys: {
        OPENAI_API_KEY: "ipc-key",
      },
    };
    this.emit("message", response);
  };
}

describe("keyResolver IPC flow", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPaprOrg = process.env.PAPR_ORG_ID;
  const originalPaprNamespace = process.env.PAPR_NAMESPACE_ID;

  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    clearKeyCache();
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPR_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalPaprOrg === undefined) delete process.env.PAPR_ORG_ID;
    else process.env.PAPR_ORG_ID = originalPaprOrg;
    if (originalPaprNamespace === undefined) delete process.env.PAPR_NAMESPACE_ID;
    else process.env.PAPR_NAMESPACE_ID = originalPaprNamespace;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  });

  test("uses process.env in development mode", async () => {
    process.env.NODE_ENV = "development";
    process.env.OPENAI_API_KEY = "env-dev-key";

    const keys = await getApiKeys(["OPENAI_API_KEY"]);

    expect(keys.OPENAI_API_KEY).toBe("env-dev-key");
  });

  test("ignores an OAuth token sitting in a provider's API key env var", async () => {
    // The pi-ai OAuth path assigns the OAuth token to ANTHROPIC_API_KEY, and an
    // OAuth token is never a valid Platform key.
    process.env.NODE_ENV = "development";
    process.env.ANTHROPIC_API_KEY = "sk-ant-oat01-not-a-platform-key";

    const keys = await getApiKeys(["ANTHROPIC_API_KEY"]);

    expect(keys.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("recovers the real API key after the OAuth path overwrites env", async () => {
    process.env.NODE_ENV = "development";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-real-platform-key";

    preserveEnvKeyBeforeOverwrite("ANTHROPIC_API_KEY");
    process.env.ANTHROPIC_API_KEY = "sk-ant-oat01-oauth-token";

    const keys = await getApiKeys(["ANTHROPIC_API_KEY"]);

    expect(keys.ANTHROPIC_API_KEY).toBe("sk-ant-api03-real-platform-key");
  });

  test("requests keys via IPC in production and caches response", async () => {
    process.env.NODE_ENV = "production";
    const fakeIpc = new FakeIpcProcess();
    const first = await getApiKeys(["OPENAI_API_KEY"], fakeIpc);
    const second = await getApiKeys(["OPENAI_API_KEY"], fakeIpc);

    expect(first.OPENAI_API_KEY).toBe("ipc-key");
    expect(second.OPENAI_API_KEY).toBe("ipc-key");
    expect(fakeIpc.sentMessages).toHaveLength(1);
  });

  test("falls back to env vars if IPC is unavailable in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.OPENAI_API_KEY = "env-fallback-key";
    const fakeIpcWithoutSend = {
      on: (_event: "message", _listener: (message: unknown) => void): void => {},
      off: (_event: "message", _listener: (message: unknown) => void): void => {},
    };
    const keys = await getApiKeys(["OPENAI_API_KEY"], fakeIpcWithoutSend);

    expect(keys.OPENAI_API_KEY).toBe("env-fallback-key");
  });

  test("bumps the auth epoch when cached credentials are cleared", () => {
    // Chat sessions keep the credential they resolved at creation, so the epoch is
    // the only signal telling them an auth-mode switch invalidated it.
    const before = getAuthEpoch();

    clearKeyCache("ANTHROPIC_API_KEY");

    expect(getAuthEpoch()).toBeGreaterThan(before);
  });

  test("re-asks main for OAuth tokens even when one is already cached", async () => {
    // Main withholds the OAuth token once the user picks API key, so a cached
    // token must not stop us from re-reading that decision.
    process.env.NODE_ENV = "development";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-real-platform-key";

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let withholdOAuth = false;

    class TogglingOAuthIpc extends EventEmitter {
      public sentMessages: RequestKeysMessage[] = [];

      send = (message: unknown): void => {
        const typedMessage = message as RequestKeysMessage;
        this.sentMessages.push(typedMessage);
        this.emit("message", {
          type: "KEYS_RESPONSE",
          requestId: typedMessage.requestId,
          keys: {},
          oauthTokens: withholdOAuth
            ? {}
            : { anthropic: { accessToken: "sk-ant-oat01-token", expiresAt } },
        } satisfies KeysResponseMessage);
      };
    }

    const fakeIpc = new TogglingOAuthIpc();

    const asOAuth = await getProviderAuth("anthropic", fakeIpc);
    expect(asOAuth).toEqual({ type: "oauth", token: "sk-ant-oat01-token" });

    withholdOAuth = true;
    const asApiKey = await getProviderAuth("anthropic", fakeIpc);

    expect(asApiKey).toEqual({
      type: "apiKey",
      key: "sk-ant-api03-real-platform-key",
    });
    expect(fakeIpc.sentMessages).toHaveLength(2);
  });

  test("getPaprApiKey rejects IPC key scoped to a different namespace", async () => {
    process.env.NODE_ENV = "production";
    process.env.PAPR_ORG_ID = "Y8D4H7Yp3Z";
    process.env.PAPR_NAMESPACE_ID = "85ZIB7mD1V";

    class WrongNamespaceIpc extends EventEmitter {
      public sentMessages: RequestKeysMessage[] = [];

      send = (message: unknown): void => {
        const typedMessage = message as RequestKeysMessage;
        this.sentMessages.push(typedMessage);
        this.emit("message", {
          type: "KEYS_RESPONSE",
          requestId: typedMessage.requestId,
          keys: {
            PAPR_API_KEY:
              "sk-org-T1HzjVDD3R-namespace-aXNvpekYXn-stale-secret",
          },
        } satisfies KeysResponseMessage);
      };
    }

    const fakeIpc = new WrongNamespaceIpc();
    const key = await getPaprApiKey(fakeIpc);

    expect(key).toBeUndefined();
    expect(fakeIpc.sentMessages).toHaveLength(1);
  });
});
