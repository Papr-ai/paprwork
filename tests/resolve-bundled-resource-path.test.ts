import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGatewayBundledResourcesRoot,
  resolveBundledResourceReadPath,
} from "../src/core/utils/resolveBundledResourcePath.js";

describe("resolveBundledResourceReadPath", () => {
  const previousGatewayMode = process.env.GATEWAY_MODE;

  afterEach(() => {
    if (previousGatewayMode === undefined) {
      delete process.env.GATEWAY_MODE;
    } else {
      process.env.GATEWAY_MODE = previousGatewayMode;
    }
  });

  it("passes through desktop paths when not in cloud_agent mode", () => {
    delete process.env.GATEWAY_MODE;
    const input = "/Users/dev/paprwork-v2/src/resources/agent-docs/PRODUCT_ARCHITECT_GUIDE.md";
    expect(resolveBundledResourceReadPath(input)).toBe(input);
  });

  it("rewrites src/resources to bundled dist/resources in cloud_agent mode", () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    const input = "/app/src/resources/agent-docs/PRODUCT_ARCHITECT_GUIDE.md";
    const resolved = resolveBundledResourceReadPath(input);

    expect(resolved).toBe(
      path.join(
        getGatewayBundledResourcesRoot(),
        "agent-docs/PRODUCT_ARCHITECT_GUIDE.md",
      ),
    );
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it("rewrites Windows-style src/resources paths in cloud_agent mode", () => {
    process.env.GATEWAY_MODE = "cloud_agent";
    const input = "C:\\app\\src\\resources\\agent-docs\\00-START-HERE.md";
    const resolved = resolveBundledResourceReadPath(input);

    expect(resolved).toBe(
      path.join(getGatewayBundledResourcesRoot(), "agent-docs/00-START-HERE.md"),
    );
    expect(fs.existsSync(resolved)).toBe(true);
  });
});
