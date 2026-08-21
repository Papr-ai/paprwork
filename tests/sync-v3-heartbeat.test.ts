import { afterEach, describe, expect, test } from "vitest";
import { buildDesktopHeartbeatBody } from "../src/gateway/services/syncV3/buildDesktopHeartbeatBody.js";
import {
  getDesktopSyncProtocol,
  getEnabledSyncV3Capabilities,
  isSyncV3FlagEnabled,
} from "../src/gateway/services/syncV3/syncV3Flags.js";
import {
  getSyncV3Metric,
  incrementSyncV3Metric,
  resetSyncV3MetricsForTests,
} from "../src/gateway/services/syncV3/syncV3Metrics.js";

const NAMESPACE_ENV = "PAPR_NAMESPACE_ID";

describe("sync V3 heartbeat body", () => {
  let previousNamespace: string | undefined;

  afterEach(() => {
    if (previousNamespace === undefined) {
      delete process.env[NAMESPACE_ENV];
    } else {
      process.env[NAMESPACE_ENV] = previousNamespace;
    }
    resetSyncV3MetricsForTests();
  });

  test("always reports syncProtocol v3 with implemented capabilities", () => {
    previousNamespace = process.env[NAMESPACE_ENV];
    delete process.env[NAMESPACE_ENV];

    expect(getDesktopSyncProtocol()).toBe("v3");
    expect(isSyncV3FlagEnabled("SYNC_V3_WRITER_OPS")).toBe(true);
    expect(isSyncV3FlagEnabled("SYNC_V3_PER_APP_REPOS")).toBe(true);
    expect(isSyncV3FlagEnabled("SYNC_V3_LOG_ROWS")).toBe(true);
    expect(isSyncV3FlagEnabled("SYNC_V3_DISPATCH_PUSH")).toBe(true);
    expect(isSyncV3FlagEnabled("SYNC_V3_SCHEMA_LOG")).toBe(true);
    expect(getEnabledSyncV3Capabilities()).toEqual([
      "SYNC_V3_PER_APP_REPOS",
      "SYNC_V3_WRITER_OPS",
      "SYNC_V3_LOG_ROWS",
      "SYNC_V3_SCHEMA_LOG",
      "SYNC_V3_DISPATCH_PUSH",
    ]);

    const body = buildDesktopHeartbeatBody("2.3.6");
    expect(body.syncProtocol).toBe("v3");
    expect(body.appVersion).toBe("2.3.6");
    expect(body.syncV3Capabilities).toContain("SYNC_V3_WRITER_OPS");
  });

  test("includes namespaceId when configured", () => {
    previousNamespace = process.env[NAMESPACE_ENV];
    process.env[NAMESPACE_ENV] = "ns-dogfood";

    const body = buildDesktopHeartbeatBody();
    expect(body.namespaceId).toBe("ns-dogfood");
  });

  test("increments V3 metric counters", () => {
    expect(getSyncV3Metric("v3_op_count")).toBe(0);
    incrementSyncV3Metric("v3_op_count");
    incrementSyncV3Metric("v3_op_count", 2);
    expect(getSyncV3Metric("v3_op_count")).toBe(3);
  });
});
