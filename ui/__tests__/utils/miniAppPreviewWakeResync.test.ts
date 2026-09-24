import { afterEach, expect, it, vi } from "vitest";
import {
  installMiniAppPreviewWakeResync,
} from "../../utils/previewIframeLifecycle";
import {
  resyncAllPreviewFramePhases,
  trackPreviewFrame,
} from "../../utils/rendererPerformance";

afterEach(() => {
  vi.useRealTimers();
});

it("resyncAllPreviewFramePhases invokes every tracked frame poll", () => {
  const polls: string[] = [];
  const stopA = trackPreviewFrame("a", {
    poll: () => {
      polls.push("a");
    },
    read: () => ({
      instanceId: "a",
      appId: "app-a",
      loaded: true,
      expectedPhase: "visible",
      acknowledgedPhase: null,
      acknowledgementAgeMs: null,
      gate: null,
    }),
  });
  const stopB = trackPreviewFrame("b", {
    poll: () => {
      polls.push("b");
    },
    read: () => ({
      instanceId: "b",
      appId: "app-b",
      loaded: true,
      expectedPhase: "hidden",
      acknowledgedPhase: "hidden",
      acknowledgementAgeMs: 10,
      gate: null,
    }),
  });

  expect(resyncAllPreviewFramePhases()).toBe(2);
  expect(polls).toEqual(["a", "b"]);

  stopA();
  stopB();
});

it("system:resume and visibility visible burst resync tracked frames", async () => {
  vi.useFakeTimers();
  const polls: number[] = [];
  const stop = trackPreviewFrame("wake", {
    poll: () => {
      polls.push(Date.now());
    },
    read: () => ({
      instanceId: "wake",
      appId: "app-wake",
      loaded: true,
      expectedPhase: "visible",
      acknowledgedPhase: null,
      acknowledgementAgeMs: null,
      gate: null,
    }),
  });

  const uninstall = installMiniAppPreviewWakeResync();
  polls.length = 0;

  window.dispatchEvent(new CustomEvent("system:resume", { detail: {} }));
  expect(polls.length).toBe(1);

  await vi.advanceTimersByTimeAsync(250);
  expect(polls.length).toBe(2);

  await vi.advanceTimersByTimeAsync(750);
  expect(polls.length).toBe(3);

  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => false,
  });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(polls.length).toBe(4);

  uninstall();
  stop();
});
