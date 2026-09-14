import { afterEach, describe, expect, it } from "vitest";
import { shouldLogMiniAppStaticServe } from "../src/gateway/utils/miniAppStaticServeLog.js";

describe("shouldLogMiniAppStaticServe", () => {
  const env = process.env;

  afterEach(() => {
    process.env = { ...env };
  });

  it("always logs index.html and dist/app.js", () => {
    delete process.env.MINI_APP_STATIC_TRACE;
    delete process.env.MINI_APP_STATIC_SLOW_MS;
    expect(shouldLogMiniAppStaticServe("index.html", 1)).toBe(true);
    expect(shouldLogMiniAppStaticServe("dist/app.js", 1)).toBe(true);
  });

  it("logs other paths only when slow", () => {
    delete process.env.MINI_APP_STATIC_TRACE;
    process.env.MINI_APP_STATIC_SLOW_MS = "500";
    expect(shouldLogMiniAppStaticServe("assets/logo.png", 100)).toBe(false);
    expect(shouldLogMiniAppStaticServe("assets/logo.png", 600)).toBe(true);
  });

  it("logs all paths when MINI_APP_STATIC_TRACE=1", () => {
    process.env.MINI_APP_STATIC_TRACE = "1";
    expect(shouldLogMiniAppStaticServe("foo/bar.css", 1)).toBe(true);
  });
});
