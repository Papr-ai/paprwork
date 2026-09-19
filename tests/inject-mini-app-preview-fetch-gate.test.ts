import { describe, expect, test, vi } from "vitest";
import { JSDOM } from "jsdom";
import { injectMiniAppPreviewFetchGate } from "../src/gateway/utils/injectMiniAppPreviewFetchGate.js";

const EMPTY = "<html><head></head><body></body></html>";

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
  test("inlines both preview scripts at the start of head", async () => {
    const out = await injectMiniAppPreviewFetchGate(EMPTY);

    // Inlined, not referenced: no request to be slow, 404, or miss a per-app
    // origin's cache partition.
    expect(out).not.toContain('src="/__papr__/papr-preview-fetch-gate.js"');
    expect(out).not.toContain('src="/__papr__/papr-app-bridge.js"');
    expect(out).toContain('data-papr-preview-gate="papr-app-bridge.ts"');
    expect(out).toContain('data-papr-preview-gate="papr-preview-fetch-gate.ts"');

    // Never deferred. Both scripts exist to be in place before app code runs.
    expect(out).not.toContain("async defer");

    expect(out.indexOf("data-papr-preview-gate")).toBeLessThan(
      out.indexOf("</head>"),
    );
  });

  test("installs the bridge before the gate", async () => {
    // An app script throwing at module scope should reach the renderer, which
    // needs the log forwarder already installed to carry it.
    const out = await injectMiniAppPreviewFetchGate(EMPTY);
    expect(out.indexOf("papr-app-bridge.ts")).toBeLessThan(
      out.indexOf("papr-preview-fetch-gate.ts"),
    );
  });

  test("upgrades old async tags, stays idempotent and preserves doctype", async () => {
    const html = await injectMiniAppPreviewFetchGate(
      '<!doctype html><head><script async defer src="/__papr__/papr-preview-fetch-gate.js"></script></head>',
    );
    // The stale tag is removed rather than left to run alongside the inline copy.
    expect(html).not.toContain("/__papr__/papr-preview-fetch-gate.js");
    expect(html.match(/data-papr-preview-gate/g)).toHaveLength(2);
    expect(await injectMiniAppPreviewFetchGate(html)).toBe(html);
    expect(
      await injectMiniAppPreviewFetchGate("<!doctype html><p>Hello</p>"),
    ).toMatch(/^<!doctype html>/);
  });

  test("is in place before app code captures fetch, on a hidden initial boot", async () => {
    // End to end: the app reads window.fetch at module scope, which is the
    // pattern the inline-vs-deferred choice above exists for, and boots hidden
    // via iframe.name with no lifecycle message yet delivered.
    const html = await injectMiniAppPreviewFetchGate(`<html><HEAD><script>
      window.appFetch = window.fetch;
      window.state = 'pending';
      window.appFetch('/api/db/query')
        .then(() => { window.state = 'ran'; }, (e) => { window.state = e.name; });
    </script></HEAD><body></body></html>`);
    const nativeFetch = vi.fn(() => Promise.resolve(new Response("ok")));
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      url: "http://localhost:18789/apps/test/index.html",
      beforeParse(w) {
        w.name = "papr-preview:hidden";
        (w as unknown as { fetch: unknown }).fetch = nativeFetch;
      },
    });
    const win = dom.window as unknown as Window & { state: string };
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Held, not run and not failed: the caller gets an unsettled promise,
      // never an AbortError it has no reason to expect.
      expect(win.state).toBe("pending");
      expect(nativeFetch).not.toHaveBeenCalled();

      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source: dom.window.parent,
          data: { type: "papr:preview-visible" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(win.state).toBe("ran");
      expect(nativeFetch).toHaveBeenCalledTimes(1);
    } finally {
      dom.window.close();
    }
  });
});
