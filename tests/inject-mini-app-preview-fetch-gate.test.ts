import { describe, expect, test, vi } from "vitest";
import { JSDOM } from "jsdom";
import { injectMiniAppPreviewFetchGate } from "../src/gateway/utils/injectMiniAppPreviewFetchGate.js";

describe("injectMiniAppPreviewFetchGate", () => {
  test("runs before app code captures fetch, including a hidden initial boot", async () => {
    const html = await injectMiniAppPreviewFetchGate(`<html><HEAD><script>
      window.appFetch = window.fetch;
      window.result = window.appFetch('/api/db/query').then(() => 'allowed', e => e.name);
    </script></HEAD><body></body></html>`);
    const nativeFetch = vi.fn();
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      url: "http://localhost:18789/apps/test/index.html",
      beforeParse(w) {
        w.name = "papr-preview:hidden";
        w.fetch = nativeFetch;
      },
    });
    try {
      expect(await (dom.window as any).result).toBe("AbortError");
      expect(nativeFetch).not.toHaveBeenCalled();
      expect(html).not.toContain("async defer");
    } finally {
      dom.window.close();
    }
  });
  test("upgrades old async tags, remains idempotent and preserves doctype", async () => {
    const html = await injectMiniAppPreviewFetchGate(
      '<!doctype html><head><script async defer src="/__papr__/papr-preview-fetch-gate.js"></script></head>',
    );
    expect(html.match(/data-papr-preview-gate/g)).toHaveLength(1);
    expect(await injectMiniAppPreviewFetchGate(html)).toBe(html);
    expect(
      await injectMiniAppPreviewFetchGate("<!doctype html><p>Hello</p>"),
    ).toMatch(/^<!doctype html>/);
  });
});
