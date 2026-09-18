/** Bounded, content-free renderer diagnostics. Counts are not CPU attribution. */
export type PreviewPhase = "visible" | "hidden" | "evicting";

export interface PreviewGateReport {
  documentId: string;
  phase: PreviewPhase;
  allowedApi: number;
  blockedApi: number;
  allowedOther: number;
}

export interface RendererAppSample {
  instanceId: string;
  appId: string;
  loaded: boolean;
  expectedPhase: PreviewPhase;
  acknowledgedPhase: PreviewPhase | null;
  acknowledgementAgeMs: number | null;
  gate: PreviewGateReport | null;
}

/** Bounded Task Attribution Timing fields (Chromium long-task API). No script bodies. */
export interface RendererLongTaskAttribution {
  name?: string;
  containerType?: string;
  containerSrc?: string;
  containerId?: string;
}

export interface RendererIncident {
  kind: "long-task" | "input-delay" | "timer-delay";
  startedAt: string;
  durationMs: number;
  /** Present when the browser exposes PerformanceLongTaskTiming.attribution. */
  attribution?: RendererLongTaskAttribution[];
}

export interface RendererPerformanceSample {
  sessionId: string;
  sequence: number;
  startedAt: string;
  finishedAt: string;
  documentVisible: boolean;
  longTasksSupported: boolean;
  inputTimingSupported: boolean;
  longTaskCount: number;
  longTaskTotalMs: number;
  maxInputDelayMs: number;
  maxTimerDelayMs: number;
  droppedIncidents: number;
  failedReports: number;
  apps: RendererAppSample[];
  incidents: RendererIncident[];
}
