import { describe, expect, test } from "vitest";
import { injectMiniAppPreviewFetchGate } from "../src/gateway/utils/injectMiniAppPreviewFetchGate.js";

describe("injectMiniAppPreviewFetchGate", () => {
  test("injects script tag at start of head", () => {
    const html = "<html><head></head><body></body></html>";
    const out = injectMiniAppPreviewFetchGate(html);
    expect(out).toContain('src="/__papr__/papr-preview-fetch-gate.js"');
    expect(out.indexOf("papr-preview-fetch-gate.js")).toBeLessThan(
      out.indexOf("</head>"),
    );
  });

  test("is idempotent", () => {
    const html = injectMiniAppPreviewFetchGate(
      "<html><head></head><body></body></html>",
    );
    expect(injectMiniAppPreviewFetchGate(html)).toBe(html);
  });
});
