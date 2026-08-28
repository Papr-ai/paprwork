import { describe, it, expect } from "vitest";
import {
  mergeBrandTokens,
  buildBrandCssVariables,
  buildBrandStyleTag,
  resolveBrandLogoUrls,
} from "../src/gateway/services/BrandService.js";
import type { BrandTokens } from "../src/core/types/brand.js";

describe("BrandService", () => {
  const globalBrand: BrandTokens = {
    name: "Acme Inc.",
    colors: {
      primary: "#2563EB",
      accent: "#F59E0B",
    },
    fonts: {
      heading: "Inter, sans-serif",
    },
    logo: {
      light: "brand/logo.svg",
    },
    sources: [{ date: "2026-06-01", chat: "Setup", note: "Initial brand" }],
  };

  it("merges app brand over global per field", () => {
    const appBrand: BrandTokens = {
      colors: {
        primary: "#FF0000",
      },
      sources: [{ date: "2026-06-10", appId: "app-1", note: "CRM orange" }],
    };

    const merged = mergeBrandTokens(globalBrand, appBrand);

    expect(merged.name).toBe("Acme Inc.");
    expect(merged.colors?.primary).toBe("#FF0000");
    expect(merged.colors?.accent).toBe("#F59E0B");
    expect(merged.sources).toHaveLength(2);
  });

  it("returns global brand when no app override", () => {
    const merged = mergeBrandTokens(globalBrand, null);
    expect(merged.colors?.primary).toBe("#2563EB");
  });

  it("builds CSS variables from brand tokens", () => {
    const vars = buildBrandCssVariables(globalBrand);
    expect(vars["--brand-primary"]).toBe("#2563EB");
    expect(vars["--brand-accent"]).toBe("#F59E0B");
    expect(vars["--brand-font-heading"]).toBe("Inter, sans-serif");
  });

  it("builds empty style tag when no brand variables", () => {
    expect(buildBrandStyleTag({})).toBe("");
  });

  it("builds brand style tag with root variables", () => {
    const tag = buildBrandStyleTag({ "--brand-primary": "#2563EB" });
    expect(tag).toContain("data-paprwork-brand");
    expect(tag).toContain("--brand-primary: #2563EB");
  });

  it("resolves relative logo paths to gateway URLs", () => {
    const resolved = resolveBrandLogoUrls(globalBrand, "app-123");
    expect(resolved.logo?.light).toBe("/api/brand/assets/logo.svg?appId=app-123");
  });

  it("preserves absolute logo URLs", () => {
    const withUrl: BrandTokens = {
      logo: { light: "https://example.com/logo.png" },
    };
    const resolved = resolveBrandLogoUrls(withUrl);
    expect(resolved.logo?.light).toBe("https://example.com/logo.png");
  });

  it("normalizes legacy brand.json when loading from disk shape", async () => {
    const { normalizeBrandTokens } = await import(
      "../src/gateway/services/brandNormalize.js"
    );
    const legacy = {
      companyName: "Papr",
      colors: {
        primary: "#0161E0",
        accent: "#0CCDFF",
        backgroundLight: "#FFFFFF",
        textLight: "#131417",
      },
    };
    const normalized = normalizeBrandTokens(legacy);
    const vars = buildBrandCssVariables(normalized);
    expect(vars["--brand-primary"]).toBe("#0161E0");
    expect(vars["--brand-background"]).toBe("#FFFFFF");
  });
});
