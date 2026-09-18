import { describe, expect, test } from "vitest";
import { injectMiniAppPreviewFetchGate } from "../src/gateway/utils/injectMiniAppPreviewFetchGate.js";

describe("injectMiniAppPreviewFetchGate", () => {
  /**
   * This suite used to assert `async defer src=...`, added in #155 so a missing
   * SDK module could not block mini-app load for ~11 seconds. That assertion
   * pinned a fix whose cost was invisible: `async defer` runs the scripts after
   * parsing, so an app that captured `window.fetch` or called `window.paprAPI`
   * at module scope missed them entirely. It traded a loud slow failure for a
   * quiet broken one — and the quiet one is the CPU pathology in
   * docs/MINI_APP_PROCESS_ISOLATION.md.
   *
   * Inlining keeps #155's requirement (no request, so nothing to be slow or
   * missing) while making "runs before app scripts" true.
   */
  test("inlines the preview scripts at the start of head", async () => {
    const html = "<html><head></head><body></body></html>";
    const out = await injectMiniAppPreviewFetchGate(html);

    // Inlined, not referenced: no request to be slow, 404, or miss a per-app
    // origin's cache partition.
    expect(out).not.toContain('src="/__papr__/papr-preview-fetch-gate.js"');
    expect(out).toContain('data-papr-preview-scripts="papr-app-bridge.ts"');
    expect(out).toContain(
      'data-papr-preview-scripts="papr-preview-fetch-gate.ts"',
    );

    // Never deferred. Both scripts exist to be in place before app code runs.
    expect(out).not.toContain("async defer");

    expect(out.indexOf("data-papr-preview-scripts")).toBeLessThan(
      out.indexOf("</head>"),
    );
  });

  test("installs the bridge before the gate", async () => {
    // An app script throwing at module scope should reach the renderer, which
    // needs the log forwarder already installed to carry it.
    const out = await injectMiniAppPreviewFetchGate(
      "<html><head></head><body></body></html>",
    );
    expect(out.indexOf("papr-app-bridge.ts")).toBeLessThan(
      out.indexOf("papr-preview-fetch-gate.ts"),
    );
  });

  test("is idempotent", async () => {
    const html = await injectMiniAppPreviewFetchGate(
      "<html><head></head><body></body></html>",
    );
    expect(await injectMiniAppPreviewFetchGate(html)).toBe(html);
  });
});
