import { describe, expect, test } from "vitest";

import {
  AppOpsClientError,
  AppOpsConflictError,
} from "../src/gateway/services/syncV3/AppOpsClient.js";
import {
  isPermanentWriterClientError,
  isWriterConflictError,
} from "../src/gateway/services/syncV3/writerOutboxErrors.js";

describe("writerOutboxErrors", () => {
  test("409 conflict is permanent", () => {
    const err = new AppOpsConflictError("app-1", {
      conflict: true,
      artifacts: [
        { path: "index.html", expectedParentHash: "a", actualBlobOid: "b" },
      ],
    });
    expect(isWriterConflictError(err)).toBe(true);
    expect(isPermanentWriterClientError(err)).toBe(true);
  });

  test("400 client error is permanent", () => {
    const err = new AppOpsClientError("app-1", 400, "abuse filter");
    expect(isPermanentWriterClientError(err)).toBe(true);
  });

  test("503 server error is retryable", () => {
    const err = new AppOpsClientError("app-1", 503, "unavailable");
    expect(isPermanentWriterClientError(err)).toBe(false);
  });
});
