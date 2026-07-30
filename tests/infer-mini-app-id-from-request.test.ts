import { describe, expect, test } from "vitest";
import {
  inferMiniAppIdFromUrl,
  resolveMiniAppIdFromRequest,
} from "../src/gateway/utils/inferMiniAppIdFromRequest.js";

const APP_A = "6564707e-c810-47ef-b9ce-c8a83c0cd16c";
const APP_B = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";

describe("inferMiniAppIdFromUrl", () => {
  test("extracts uuid from /apps/{id}/index.html", () => {
    expect(
      inferMiniAppIdFromUrl(
        `http://localhost:18789/apps/${APP_A}/index.html`,
      ),
    ).toBe(APP_A);
  });

  test("returns undefined for unrelated paths", () => {
    expect(inferMiniAppIdFromUrl("http://localhost:18789/api/db/query")).toBe(
      undefined,
    );
  });
});

describe("resolveMiniAppIdFromRequest", () => {
  test("uses explicit appId when referer is absent", () => {
    const result = resolveMiniAppIdFromRequest(APP_A, {});
    expect(result.appId).toBe(APP_A);
    expect(result.error).toBeUndefined();
  });

  test("infers appId from referer when explicit is omitted", () => {
    const result = resolveMiniAppIdFromRequest(undefined, {
      referer: `http://localhost:18789/apps/${APP_A}/index.html`,
    });
    expect(result.appId).toBe(APP_A);
  });

  test("rejects mismatched explicit appId and referer", () => {
    const result = resolveMiniAppIdFromRequest(APP_B, {
      referer: `http://localhost:18789/apps/${APP_A}/index.html`,
    });
    expect(result.appId).toBeUndefined();
    expect(result.status).toBe(403);
  });

  test("requires appId when neither explicit nor referer", () => {
    const result = resolveMiniAppIdFromRequest(undefined, {});
    expect(result.appId).toBeUndefined();
    expect(result.status).toBe(400);
  });
});
