import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  CATALOG_ICON_MAX_CHARS,
  prepareCatalogIconForPublish,
} from "../src/gateway/utils/catalogIconForPublish.js";

describe("prepareCatalogIconForPublish", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-icon-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes through icons within the limit", async () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M3 3"/></svg>';
    const result = await prepareCatalogIconForPublish({ icon: svg });
    expect(result.icon).toBe(svg);
    expect(result.note).toBeUndefined();
  });

  it("uses logo.svg from app dir when PNG data URI exceeds limit", async () => {
    const hugePng = `data:image/png;base64,${"A".repeat(CATALOG_ICON_MAX_CHARS + 100)}`;
    const appSvg =
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor"/></svg>';
    await fs.writeFile(path.join(tmpDir, "logo.svg"), appSvg, "utf8");

    const result = await prepareCatalogIconForPublish({
      icon: hugePng,
      appDir: tmpDir,
    });

    expect(result.icon).toContain("<svg");
    expect(result.note).toContain("fallback");
  });

  it("compresses real PNG data URIs to fit the catalog limit", async () => {
    let sharp: typeof import("sharp").default;
    try {
      sharp = (await import("sharp")).default;
    } catch {
      return;
    }

    const pngBuffer = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: { r: 80, g: 120, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const hugePng = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    expect(hugePng.length).toBeGreaterThan(CATALOG_ICON_MAX_CHARS);

    const result = await prepareCatalogIconForPublish({ icon: hugePng });
    expect(result.icon).toBeDefined();
    expect(result.icon!.length).toBeLessThanOrEqual(CATALOG_ICON_MAX_CHARS);
    expect(result.icon!.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(result.note).toContain("compressed");
  });
});
