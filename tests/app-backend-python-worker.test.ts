import { afterEach, describe, expect, it } from "vitest";
import {
  isBackendPythonWorkerEnabled,
  resetBackendPythonWorkerForTests,
  runPythonHandlerViaWorker,
} from "../src/gateway/services/appRuntime/appBackendPythonWorker.js";

describe("appBackendPythonWorker", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetBackendPythonWorkerForTests();
  });

  it("enables worker in production by default", () => {
    process.env.NODE_ENV = "production";
    delete process.env.CLOUD_APP_HOST_PYTHON_WORKER;
    expect(isBackendPythonWorkerEnabled()).toBe(true);
  });

  it("can disable worker explicitly", () => {
    process.env.NODE_ENV = "production";
    process.env.CLOUD_APP_HOST_PYTHON_WORKER = "0";
    expect(isBackendPythonWorkerEnabled()).toBe(false);
  });

  it("runs a simple python handler via persistent worker", async () => {
    process.env.CLOUD_APP_HOST_PYTHON_WORKER = "1";
    process.env.NODE_ENV = "test";

    const result = await runPythonHandlerViaWorker({
      handlerSource: 'print("worker-ok")',
      dbHelperSource: "# stub",
      env: {},
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("worker-ok");
  }, 20_000);
});
