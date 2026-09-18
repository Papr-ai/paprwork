import type {
  PreviewGateReport,
  RendererAppSample,
  RendererIncident,
  RendererLongTaskAttribution,
  RendererPerformanceSample,
} from "../../src/core/types/rendererPerformance";

type TrackedFrame = { read: () => RendererAppSample; poll: () => void };
const frames = new Map<string, TrackedFrame>();
export function trackPreviewFrame(id: string, frame: TrackedFrame): () => void {
  if (frames.size < 32) frames.set(id, frame);
  return () => {
    frames.delete(id);
  };
}

export function readGateReport(value: unknown): PreviewGateReport | null {
  if (!value || typeof value !== "object") return null;
  const v = value as PreviewGateReport;
  if (
    typeof v.documentId !== "string" ||
    v.documentId.length > 100 ||
    !["hidden", "visible", "evicting"].includes(v.phase) ||
    ![v.allowedApi, v.blockedApi, v.allowedOther].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return null;
  return {
    documentId: v.documentId,
    phase: v.phase,
    allowedApi: v.allowedApi,
    blockedApi: v.blockedApi,
    allowedOther: v.allowedOther,
  };
}

/** One observer and one bounded upload per renderer, not per app/request. */
export function startRendererPerformanceReporting(
  endpoint: string,
): () => void {
  const sessionId = crypto.randomUUID();
  let sequence = 0,
    failedReports = 0,
    pending = false,
    stopped = false;
  let startedAt = new Date().toISOString();
  let incidents: RendererIncident[] = [],
    droppedIncidents = 0;
  let longTaskCount = 0,
    longTaskTotalMs = 0,
    maxInputDelayMs = 0,
    maxTimerDelayMs = 0;
  const supported =
    typeof PerformanceObserver === "undefined"
      ? []
      : (PerformanceObserver.supportedEntryTypes ?? []);
  const observers: PerformanceObserver[] = [];
  const readLongTaskAttribution = (
    entry: PerformanceEntry,
  ): RendererLongTaskAttribution[] | undefined => {
    const attribution = (
      entry as PerformanceEntry & {
        attribution?: Array<{
          name?: string;
          containerType?: string;
          containerSrc?: string;
          containerId?: string;
        }>;
      }
    ).attribution;
    if (!attribution?.length) return undefined;
    const mapped = attribution.slice(0, 5).map((a) => ({
      name:
        typeof a.name === "string" ? a.name.slice(0, 120) : undefined,
      containerType:
        typeof a.containerType === "string"
          ? a.containerType.slice(0, 40)
          : undefined,
      containerSrc:
        typeof a.containerSrc === "string"
          ? a.containerSrc.slice(0, 200)
          : undefined,
      containerId:
        typeof a.containerId === "string"
          ? a.containerId.slice(0, 80)
          : undefined,
    }));
    const filtered = mapped.filter(
      (a) => a.name || a.containerType || a.containerSrc || a.containerId,
    );
    return filtered.length ? filtered : undefined;
  };
  const record = (
    kind: RendererIncident["kind"],
    start: number,
    durationMs: number,
    attribution?: RendererLongTaskAttribution[],
  ) => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    if (incidents.length === 20) {
      droppedIncidents++;
      return;
    }
    incidents.push({
      kind,
      startedAt: new Date(performance.timeOrigin + start).toISOString(),
      durationMs,
      ...(attribution?.length ? { attribution } : {}),
    });
  };
  let longTasksSupported = false,
    inputTimingSupported = false;
  const observe = (
    type: string,
    callback: (entries: PerformanceEntry[]) => void,
  ) => {
    if (!supported.includes(type)) return false;
    try {
      const observer = new PerformanceObserver((list) =>
        callback(list.getEntries()),
      );
      observer.observe({
        type,
        buffered: false,
        ...(type === "event" ? { durationThreshold: 16 } : {}),
      } as PerformanceObserverInit);
      observers.push(observer);
      return true;
    } catch {
      return false;
    }
  };
  longTasksSupported = observe("longtask", (entries) => {
    for (const entry of entries) {
      longTaskCount++;
      longTaskTotalMs += entry.duration;
      record(
        "long-task",
        entry.startTime,
        entry.duration,
        readLongTaskAttribution(entry),
      );
    }
  });
  inputTimingSupported = observe("event", (entries) => {
    for (const entry of entries) {
      const delay =
        (entry as PerformanceEventTiming).processingStart - entry.startTime;
      if (!Number.isFinite(delay)) continue;
      maxInputDelayMs = Math.max(maxInputDelayMs, delay);
      if (delay >= 50) record("input-delay", entry.startTime, delay);
    }
  });
  let expectedTick = performance.now() + 1000;
  let wasVisible = !document.hidden;
  const tick = setInterval(() => {
    const now = performance.now();
    const delay = Math.max(0, now - expectedTick);
    if (wasVisible && !document.hidden) {
      maxTimerDelayMs = Math.max(maxTimerDelayMs, delay);
      if (delay >= 100) record("timer-delay", expectedTick, delay);
    }
    wasVisible = !document.hidden;
    expectedTick = now + 1000;
  }, 1000);
  const onVisibility = () => {
    wasVisible = !document.hidden;
    expectedTick = performance.now() + 1000;
  };
  document.addEventListener("visibilitychange", onVisibility);
  let controller: AbortController | undefined;
  const upload = async () => {
    for (const frame of frames.values()) frame.poll();
    if (pending || stopped) return;
    const finishedAt = new Date().toISOString();
    const sample: RendererPerformanceSample = {
      sessionId,
      sequence: ++sequence,
      startedAt,
      finishedAt,
      documentVisible: !document.hidden,
      longTasksSupported,
      inputTimingSupported,
      longTaskCount,
      longTaskTotalMs,
      maxInputDelayMs,
      maxTimerDelayMs,
      droppedIncidents,
      failedReports,
      apps: [...frames.values()].map((frame) => frame.read()),
      incidents,
    };
    startedAt = finishedAt;
    incidents = [];
    droppedIncidents = 0;
    longTaskCount = longTaskTotalMs = maxInputDelayMs = maxTimerDelayMs = 0;
    pending = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 3000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sample),
        signal: controller.signal,
      });
      if (!response.ok) failedReports++;
    } catch {
      failedReports++;
    } finally {
      clearTimeout(timeout);
      pending = false;
    }
  };
  const reporting = setInterval(() => {
    void upload();
  }, 5000);
  return () => {
    stopped = true;
    controller?.abort();
    clearInterval(tick);
    clearInterval(reporting);
    document.removeEventListener("visibilitychange", onVisibility);
    for (const observer of observers) observer.disconnect();
  };
}
