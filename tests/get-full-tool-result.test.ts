import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import {
  getAgentService,
  resetAgentServiceSingletonForTests,
} from "../src/gateway/services/AgentService.js";
import {
  getStorageManager,
  resetStorageManagerSingleton,
} from "../src/gateway/services/StorageManager.js";
import { LocalStorageProvider } from "../src/gateway/services/storage/LocalStorageProvider.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

let canUseBetterSqlite = false;
try {
  const probe = new Database(":memory:");
  probe.close();
  canUseBetterSqlite = true;
} catch {
  canUseBetterSqlite = false;
}

describe("StorageManager singleton", () => {
  // Keeps fixtures out of the developer's real ~/Papr workspace.
  useIsolatedPaprWorkspace("get-full-tool-result");

  beforeEach(async () => {
    resetAgentServiceSingletonForTests();
    await resetStorageManagerSingleton();
  });

  afterEach(async () => {
    resetAgentServiceSingletonForTests();
    await resetStorageManagerSingleton();
  });

  test("AgentService uses the same StorageManager instance as getStorageManager()", () => {
    const agentStorage = getAgentService().getStorageManager();
    const singletonStorage = getStorageManager();

    expect(agentStorage).toBe(singletonStorage);
  });

  test.skipIf(!canUseBetterSqlite)(
    "initialize closes the previous local provider before replacing it",
    async () => {
    const sm = getStorageManager();
    const userDataPath = process.env.PAPR_USER_DATA;
    if (!userDataPath) {
      throw new Error("PAPR_USER_DATA must be set by isolated workspace fixture");
    }

    await sm.initialize({ mode: "local", userDataPath });
    const firstProvider = sm.currentProvider;
    expect(firstProvider).toBeInstanceOf(LocalStorageProvider);

    await sm.initialize({ mode: "local", userDataPath });

    await expect(
      firstProvider.saveMessage("chat-test", {
        id: "msg-test",
        chat_id: "chat-test",
        role: "user",
        content: "hello",
        timestamp: new Date().toISOString(),
        sync_status: "local",
      }),
    ).rejects.toThrow(/database connection is not open/i);
    },
  );
});
