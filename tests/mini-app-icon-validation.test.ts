import { describe, expect, test } from "vitest";
import { sanitizeMiniAppIcon, validateMiniAppIcon } from "../src/core/utils/miniAppIconValidation.js";

const VALID_CHART_ICON =
  '<svg viewBox="0 0 24 24"><path d="M3 3v16a2 2 0 002 2h16" stroke="currentColor" stroke-width="2" fill="none"/></svg>';

describe("validateMiniAppIcon", () => {
  test("accepts stroke-only SVG icons", () => {
    expect(validateMiniAppIcon(VALID_CHART_ICON)).toEqual({ ok: true });
  });

  test("accepts PNG data URIs", () => {
    expect(validateMiniAppIcon("data:image/png;base64,abc")).toEqual({ ok: true });
  });

  test("accepts https image URLs", () => {
    expect(validateMiniAppIcon("https://example.com/icon.png")).toEqual({ ok: true });
  });

  test("rejects plain text icons", () => {
    const result = validateMiniAppIcon("chart");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rule).toBe("icon-format");
    }
  });

  test("rejects SVG with large white circle background", () => {
    const result = validateMiniAppIcon(
      '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="white"/><path d="M10 32h44" stroke="black"/></svg>',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rule).toBe("svg-background");
      expect(result.message).toContain("circle");
    }
  });

  test("rejects SVG with large filled rectangle background", () => {
    const result = validateMiniAppIcon(
      '<svg viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="30" fill="#ffffff"/><path d="M10 32h44" stroke="black"/></svg>',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rule).toBe("svg-background");
    }
  });

  test("rejects SVG gradient orb backgrounds", () => {
    const result = validateMiniAppIcon(
      '<svg viewBox="0 0 64 64"><defs><radialGradient id="g"><stop offset="0%" stop-color="#fff"/></radialGradient></defs><circle cx="32" cy="32" r="30" fill="url(#g)"/></svg>',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rule).toBe("svg-background");
    }
  });

  test("allows small decorative filled shapes", () => {
    const result = validateMiniAppIcon(
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
    );
    expect(result).toEqual({ ok: true });
  });

  test("sanitizeMiniAppIcon returns null for invalid icons", () => {
    expect(sanitizeMiniAppIcon("chart")).toBeNull();
    expect(sanitizeMiniAppIcon("  ")).toBeNull();
    expect(sanitizeMiniAppIcon(undefined)).toBeNull();
  });

  test("sanitizeMiniAppIcon returns trimmed valid icons", () => {
    expect(sanitizeMiniAppIcon(`  ${VALID_CHART_ICON}  `)).toBe(VALID_CHART_ICON);
    expect(sanitizeMiniAppIcon("data:image/png;base64,abc")).toBe(
      "data:image/png;base64,abc",
    );
  });
});
