import { describe, expect, test } from "vitest";
import {
  isKeysResponseMessage,
  isPermissionResponseMessage,
} from "../src/core/types/gateway-ipc.js";

describe("gateway ipc type guards", () => {
  test("accepts valid KEYS_RESPONSE payload", () => {
    const payload = {
      type: "KEYS_RESPONSE",
      requestId: "keys-1",
      keys: {
        OPENAI_API_KEY: "secret",
      },
    };

    expect(isKeysResponseMessage(payload)).toBe(true);
  });

  test("rejects invalid KEYS_RESPONSE payload", () => {
    const payload = {
      type: "KEYS_RESPONSE",
      requestId: 123,
      keys: "invalid",
    };

    expect(isKeysResponseMessage(payload)).toBe(false);
  });

  test("accepts valid PERMISSION_RESPONSE payload", () => {
    const payload = {
      type: "PERMISSION_RESPONSE",
      requestId: "perm-1",
      response: {
        approved: true,
      },
    };

    expect(isPermissionResponseMessage(payload)).toBe(true);
  });

  test("rejects invalid PERMISSION_RESPONSE payload", () => {
    const payload = {
      type: "PERMISSION_RESPONSE",
      requestId: "perm-1",
      response: null,
    };

    expect(isPermissionResponseMessage(payload)).toBe(false);
  });
});
