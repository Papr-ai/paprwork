import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import type {
  PreviewPhase,
  PreviewGateReport,
} from "../../src/core/types/rendererPerformance";
import {
  readGateReport,
  resyncAllPreviewFramePhases,
  trackPreviewFrame,
} from "./rendererPerformance";

export type PreviewLifecycleMessageType =
  | "papr:preview-hidden"
  | "papr:preview-visible"
  | "papr:preview-evicting";
export function postPreviewLifecycleToIframe(
  iframe: HTMLIFrameElement | null | undefined,
  type: PreviewLifecycleMessageType,
  targetOrigin = "*",
): void {
  iframe?.contentWindow?.postMessage({ type }, targetOrigin);
}

/** Ready handshake plus load/visibility updates; works when the frame mounts late. */
export function usePreviewTabLifecycle(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  previewTabVisible: boolean,
  appId?: string,
  frameKey?: string | null,
): void {
  const phase = useRef<PreviewPhase>("visible");
  phase.current = previewTabVisible ? "visible" : "hidden";
  const pollRef = useRef<() => void>(() => {});
  useEffect(() => {
    const instanceId = crypto.randomUUID();
    let sequence = 0,
      acknowledgedAt: number | null = null;
    let gate: PreviewGateReport | null = null;
    let acknowledgedPhase: PreviewPhase | null = null;
    const poll = () => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage(
        { type: `papr:preview-${phase.current}`, sequence: ++sequence },
        new URL(iframe.src).origin,
      );
    };
    pollRef.current = poll;
    const receive = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (
        !iframe ||
        event.source !== iframe.contentWindow ||
        event.origin !== new URL(iframe.src).origin ||
        event.data?.type !== "papr:preview-gate-report"
      )
        return;
      const report = readGateReport(event.data.gate);
      if (!report) return;
      // An unsolicited ready message belongs to the newly booted gate. Reply
      // immediately, rather than waiting for images and the iframe load event.
      if (event.data.sequence === undefined) {
        if (gate?.documentId !== report.documentId) {
          acknowledgedAt = null;
          acknowledgedPhase = null;
        }
        gate = report;
        poll();
        return;
      }
      if (event.data.sequence !== sequence) return;
      gate = report;
      acknowledgedAt = performance.now();
      acknowledgedPhase = report.phase;
    };
    window.addEventListener("message", receive);
    const untrack = appId
      ? trackPreviewFrame(instanceId, {
          poll,
          read: () => ({
            instanceId,
            appId,
            loaded: !!iframeRef.current?.contentWindow,
            expectedPhase: phase.current,
            acknowledgedPhase,
            acknowledgementAgeMs:
              acknowledgedAt === null
                ? null
                : performance.now() - acknowledgedAt,
            gate,
          }),
        })
      : () => {};
    poll();
    return () => {
      window.removeEventListener("message", receive);
      untrack();
      pollRef.current = () => {};
      postPreviewLifecycleToIframe(iframeRef.current, "papr:preview-evicting");
    };
  }, [iframeRef, appId, frameKey]);
  useEffect(() => {
    pollRef.current();
  }, [previewTabVisible]);
}

const WAKE_RESYNC_FOLLOWUP_MS = [250, 1000] as const;

function burstPreviewPhaseResync(): void {
  resyncAllPreviewFramePhases();
  for (const delayMs of WAKE_RESYNC_FOLLOWUP_MS) {
    window.setTimeout(() => resyncAllPreviewFramePhases(), delayMs);
  }
}

/**
 * After OS sleep the preview fetch gate can disagree with the host until phase
 * messages are re-sent. Gateway reconnect also finishes slightly after resume.
 */
export function installMiniAppPreviewWakeResync(): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const onWake = () => {
    burstPreviewPhaseResync();
  };

  const onVisibility = () => {
    if (!document.hidden) {
      onWake();
    }
  };

  window.addEventListener("system:resume", onWake);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    window.removeEventListener("system:resume", onWake);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
