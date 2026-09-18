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

export interface RendererIncident {
  kind: "long-task" | "input-delay" | "timer-delay";
  startedAt: string;
  durationMs: number;
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
