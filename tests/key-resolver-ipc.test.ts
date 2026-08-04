import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearKeyCache,
  getApiKeys,
  getPaprApiKey,
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

  beforeEach(() => {
    clearKeyCache();
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPR_API_KEY;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalPaprOrg === undefined) delete process.env.PAPR_ORG_ID;
    else process.env.PAPR_ORG_ID = originalPaprOrg;
    if (originalPaprNamespace === undefined) delete process.env.PAPR_NAMESPACE_ID;
    else process.env.PAPR_NAMESPACE_ID = originalPaprNamespace;
  });

  test("uses process.env in development mode", async () => {
    process.env.NODE_ENV = "development";
    process.env.OPENAI_API_KEY = "env-dev-key";

    const keys = await getApiKeys(["OPENAI_API_KEY"]);

    expect(keys.OPENAI_API_KEY).toBe("env-dev-key");
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
