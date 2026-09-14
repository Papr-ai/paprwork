import { afterEach, describe, expect, test } from "vitest";
import {
  resolveCodeIndexIoPoolSize,
  resolveDbQueryPoolSize,
  resolveGatewayBackgroundMaxConcurrency,
  isGatewayBackgroundProcessEnabled,
} from "../src/gateway/services/gatewayBackgroundConcurrency.js";

describe("gatewayBackgroundConcurrency", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test("resolveGatewayBackgroundMaxConcurrency clamps override", () => {
    process.env.GATEWAY_BG_MAX_CONCURRENCY = "99";
    expect(resolveGatewayBackgroundMaxConcurrency()).toBe(4);
    process.env.GATEWAY_BG_MAX_CONCURRENCY = "0";
    expect(resolveGatewayBackgroundMaxConcurrency()).toBe(1);
  });

  test("pool sizes follow concurrency when unset", () => {
    delete process.env.GATEWAY_BG_MAX_CONCURRENCY;
    delete process.env.DB_QUERY_POOL_SIZE;
    delete process.env.CODE_INDEX_IO_POOL_SIZE;
    const bg = resolveGatewayBackgroundMaxConcurrency();
    expect(resolveDbQueryPoolSize()).toBe(Math.min(4, Math.max(1, bg)));
    expect(resolveCodeIndexIoPoolSize()).toBe(Math.min(4, Math.max(1, bg)));
  });

  test("background process disabled under vitest", () => {
    process.env.VITEST = "true";
    expect(isGatewayBackgroundProcessEnabled()).toBe(false);
  });
});
