import { describe, expect, it } from "vitest";
import {
  brandJsonNeedsNormalization,
  normalizeBrandTokens,
} from "../src/gateway/services/brandNormalize.js";

describe("brandNormalize", () => {
  it("maps legacy companyName/typography/backgroundLight to canonical BrandTokens", () => {
    const normalized = normalizeBrandTokens({
      companyName: "Papr",
      colors: {
        primary: "#0161E0",
        accent: "#0CCDFF",
        highlight: "#00FEFE",
        backgroundLight: "#FFFFFF",
        textLight: "#131417",
      },
      typography: {
        headings: null,
        body: null,
      },
      logo: {
        light: "brand/logo.svg",
        dark: "brand/logo-dark.svg",
      },
      sources: [{ date: "2026-08-25", note: "Onboarding swatches" }],
    });

    expect(normalized.name).toBe("Papr");
    expect(normalized.colors?.primary).toBe("#0161E0");
    expect(normalized.colors?.background).toBe("#FFFFFF");
    expect(normalized.colors?.text).toBe("#131417");
    expect(normalized.logo?.light).toBe("brand/logo.svg");
    expect(normalized.sources).toHaveLength(1);
  });

  it("passes through canonical brand.json unchanged", () => {
    const input = {
      name: "Acme",
      colors: { primary: "#111111", accent: "#222222" },
      fonts: { heading: "Inter", body: "Inter" },
    };
    expect(normalizeBrandTokens(input)).toEqual(input);
    expect(brandJsonNeedsNormalization(input)).toBe(false);
  });

  it("detects legacy keys that need normalization", () => {
    expect(
      brandJsonNeedsNormalization({
        companyName: "Papr",
        colors: { primary: "#0161E0", backgroundLight: "#FFFFFF" },
      }),
    ).toBe(true);
  });
});
