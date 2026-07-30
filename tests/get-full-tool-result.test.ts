import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getAgentService,
  resetAgentServiceSingletonForTests,
} from "../src/gateway/services/AgentService.js";
import {
  getStorageManager,
  resetStorageManagerSingleton,
} from "../src/gateway/services/StorageManager.js";

describe("StorageManager singleton", () => {
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
});
