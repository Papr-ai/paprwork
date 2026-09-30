import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  decodeCustomSiteHostname,
  isBuiltinPlatformId,
  resolvePlatformConnectDisplay,
} from "../ui/utils/platformConnectDisplay.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("resolvePlatformConnectDisplay", () => {
  it("returns built-in branding for linkedin", () => {
    const display = resolvePlatformConnectDisplay("linkedin");
    expect(display.isBuiltin).toBe(true);
    expect(display.name).toBe("LinkedIn");
    expect(display.color).toBe("#0A66C2");
    expect(display.description.length).toBeGreaterThan(10);
  });

  it("never returns undefined fields for custom site ids", () => {
    const display = resolvePlatformConnectDisplay("site-mail-google-com");
    expect(display.isBuiltin).toBe(false);
    expect(display.name).toBe("mail.google.com");
    expect(display.color).toBeTruthy();
    expect(display.description).toContain("mail.google.com");
  });

  it("falls back safely for unknown ids", () => {
    const display = resolvePlatformConnectDisplay("gmail");
    expect(display.name).toBe("gmail");
    expect(display.color).toBeTruthy();
  });
});

describe("decodeCustomSiteHostname", () => {
  it("decodes site-notion-so", () => {
    expect(decodeCustomSiteHostname("site-notion-so")).toBe("notion.so");
  });

  it("returns null for built-in ids", () => {
    expect(decodeCustomSiteHostname("linkedin")).toBeNull();
  });
});

describe("isBuiltinPlatformId", () => {
  it("recognizes twitter", () => {
    expect(isBuiltinPlatformId("twitter")).toBe(true);
  });

  it("rejects custom site ids", () => {
    expect(isBuiltinPlatformId("site-mail-google-com")).toBe(false);
  });
});

describe("PlatformConnectModal wiring", () => {
  it("resolves display via helper instead of indexing built-in map only", () => {
    const source = readModalSource();
    expect(source).toContain("resolvePlatformConnectDisplay(activeRequest.platform)");
    expect(source).not.toMatch(/PLATFORM_INFO\[activeRequest\.platform\]/);
    expect(source).toContain("PlatformConnectErrorBoundary");
  });
});

function readModalSource(): string {
  return fs.readFileSync(
    path.join(ROOT, "ui/components/Platforms/PlatformConnectModal.tsx"),
    "utf-8",
  );
}
