import React, { useRef } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePreviewTabLifecycle } from "../../utils/previewIframeLifecycle";
import { startRendererPerformanceReporting } from "../../utils/rendererPerformance";

function Host({
  mounted,
  visible,
  frameKey = "one",
}: {
  mounted: boolean;
  visible: boolean;
  frameKey?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  usePreviewTabLifecycle(ref, visible, "app-1", frameKey);
  return mounted ? (
    <iframe
      ref={ref}
      src="http://localhost:18789/apps/app-1/index.html"
      name={visible ? "papr-preview:visible" : "papr-preview:hidden"}
    />
  ) : null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("handshakes with a late-mounted frame and validates message source/origin/sequence", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("PerformanceObserver", undefined);
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const stop = startRendererPerformanceReporting("http://localhost/report");
  const host = render(<Host mounted={false} visible={false} />);
  host.rerender(<Host mounted visible={false} />);
  const iframe = host.container.querySelector("iframe")!;
  const post = vi.spyOn(iframe.contentWindow!, "postMessage");
  const gate = {
    documentId: "document-1",
    phase: "hidden",
    allowedApi: 0,
    blockedApi: 2,
    allowedOther: 0,
  };
  const send = (source: Window | null, origin: string, sequence?: number) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          origin,
          data: { type: "papr:preview-gate-report", gate, sequence },
        }),
      );
    });
  send(window, "http://localhost:18789");
  send(iframe.contentWindow, "http://wrong-origin");
  expect(post).not.toHaveBeenCalled();
  send(iframe.contentWindow, "http://localhost:18789");
  expect(post).toHaveBeenLastCalledWith(
    { type: "papr:preview-hidden", sequence: 1 },
    "http://localhost:18789",
  );
  send(iframe.contentWindow, "http://localhost:18789", 0); // stale response
  await vi.advanceTimersByTimeAsync(5000);
  expect(
    JSON.parse(fetch.mock.calls[0][1].body).apps[0].acknowledgedPhase,
  ).toBeNull();
  send(iframe.contentWindow, "http://localhost:18789", 2);
  await vi.advanceTimersByTimeAsync(5000);
  const app = JSON.parse(fetch.mock.calls[1][1].body).apps[0];
  expect(app.acknowledgedPhase).toBe("hidden");
  expect(app.gate.blockedApi).toBe(2);
  host.rerender(<Host mounted visible />);
  expect(post.mock.calls.at(-1)?.[0].type).toBe("papr:preview-visible");
  host.unmount();
  await vi.advanceTimersByTimeAsync(5000);
  expect(JSON.parse(fetch.mock.calls[2][1].body).apps).toEqual([]);
  stop();
});
