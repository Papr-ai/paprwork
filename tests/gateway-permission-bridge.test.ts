import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  handlePermissionResponse,
  initializePermissionBridge,
  requestPermissionFromMain,
} from "../src/gateway/permissions/GatewayPermissionBridge.js";
import type {
  RequestPermissionMessage,
  PermissionResponseMessage,
} from "../src/core/types/gateway-ipc.js";
import { EventEmitter } from "events";

class FakePermissionIpc extends EventEmitter {
  public sentMessages: RequestPermissionMessage[] = [];

  send = (message: unknown): void => {
    this.sentMessages.push(message as RequestPermissionMessage);
  };
}

describe("GatewayPermissionBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("auto-approves when IPC is unavailable", async () => {
    const ipcWithoutSend = {
      on: (_event: "message", _listener: (message: unknown) => void): void => {},
    };
    const result = await requestPermissionFromMain({
      keyName: "OPENAI_API_KEY",
      description: "Allow key usage",
      isEnvKey: true,
    }, ipcWithoutSend);

    expect(result).toEqual({ approved: true });
  });

  test("resolves when response is received from main", async () => {
    const fakeIpc = new FakePermissionIpc();

    const promise = requestPermissionFromMain({
      keyName: "OPENAI_API_KEY",
      description: "Allow key usage",
      isEnvKey: true,
    }, fakeIpc);

    expect(fakeIpc.sentMessages).toHaveLength(1);
    expect(fakeIpc.sentMessages[0].type).toBe("REQUEST_PERMISSION");
    expect(fakeIpc.sentMessages[0].request.keyName).toBe("OPENAI_API_KEY");

    handlePermissionResponse(fakeIpc.sentMessages[0].requestId, {
      approved: true,
    });

    await expect(promise).resolves.toEqual({ approved: true });
  });

  test("handles PERMISSION_RESPONSE frame through initialized listener", async () => {
    const fakeIpc = new FakePermissionIpc();
    initializePermissionBridge(fakeIpc);

    const pending = requestPermissionFromMain({
      keyName: "ANTHROPIC_API_KEY",
      description: "Allow key usage",
      isEnvKey: true,
    }, fakeIpc);

    const response: PermissionResponseMessage = {
      type: "PERMISSION_RESPONSE",
      requestId: fakeIpc.sentMessages[0].requestId,
      response: { approved: false },
    };
    fakeIpc.emit("message", response);

    await expect(pending).resolves.toEqual({ approved: false });
  });

  test("rejects on timeout when no response arrives", async () => {
    const fakeIpc = new FakePermissionIpc();

    const pending = requestPermissionFromMain({
      keyName: "CUSTOM_KEY",
      description: "Allow key usage",
      isEnvKey: false,
    }, fakeIpc);

    const rejection = expect(pending).rejects.toThrow(
      "Permission request timed out"
    );
    await vi.advanceTimersByTimeAsync(30001);
    await rejection;
  });
});
