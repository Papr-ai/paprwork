import type {
  RendererPerformanceSample,
  RendererAppSample,
  RendererIncident,
  RendererLongTaskAttribution,
} from "../../core/types/rendererPerformance.js";

const MAX_SAMPLES = 120;
const MAX_SESSIONS = 4;
const phases = ["hidden", "visible", "evicting"];
const num = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER;
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[\w-]{1,100}$/.test(v);
const date = (v: unknown): v is string =>
  typeof v === "string" && v.length < 40 && Number.isFinite(Date.parse(v));
const short = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max;

function parseAttribution(value: unknown): RendererLongTaskAttribution[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) return undefined;
  const out: RendererLongTaskAttribution[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const a = item as RendererLongTaskAttribution;
    if (
      (a.name !== undefined && !short(a.name, 120)) ||
      (a.containerType !== undefined && !short(a.containerType, 40)) ||
      (a.containerSrc !== undefined && !short(a.containerSrc, 200)) ||
      (a.containerId !== undefined && !short(a.containerId, 80))
    )
      return undefined;
    const parsed: RendererLongTaskAttribution = {};
    if (a.name !== undefined) parsed.name = a.name;
    if (a.containerType !== undefined) parsed.containerType = a.containerType;
    if (a.containerSrc !== undefined) parsed.containerSrc = a.containerSrc;
    if (a.containerId !== undefined) parsed.containerId = a.containerId;
    if (Object.keys(parsed).length) out.push(parsed);
  }
  return out.length ? out : undefined;
}

/** Whitelist fields; never retain URLs, text, arbitrary objects or script names. */
export function parseRendererSample(
  value: unknown,
): RendererPerformanceSample | null {
  if (!value || typeof value !== "object") return null;
  const v = value as RendererPerformanceSample;
  if (
    !id(v.sessionId) ||
    !num(v.sequence) ||
    !date(v.startedAt) ||
    !date(v.finishedAt) ||
    Date.parse(v.finishedAt) < Date.parse(v.startedAt) ||
    ![v.documentVisible, v.longTasksSupported, v.inputTimingSupported].every(
      (x) => typeof x === "boolean",
    ) ||
    ![
      v.longTaskCount,
      v.longTaskTotalMs,
      v.maxInputDelayMs,
      v.maxTimerDelayMs,
      v.droppedIncidents,
      v.failedReports,
    ].every(num) ||
    !Array.isArray(v.apps) ||
    v.apps.length > 32 ||
    !Array.isArray(v.incidents) ||
    v.incidents.length > 20
  )
    return null;
  const apps: RendererAppSample[] = [];
  for (const a of v.apps) {
    if (
      !a ||
      !id(a.appId) ||
      !id(a.instanceId) ||
      typeof a.loaded !== "boolean" ||
      !phases.includes(a.expectedPhase) ||
      (a.acknowledgedPhase !== null && !phases.includes(a.acknowledgedPhase)) ||
      (a.acknowledgementAgeMs !== null && !num(a.acknowledgementAgeMs))
    )
      return null;
    const g = a.gate;
    if (
      g !== null &&
      (!g ||
        !id(g.documentId) ||
        !phases.includes(g.phase) ||
        ![
          g.allowedApi,
          g.deferredApi,
          g.passedThroughApi,
          g.allowedOther,
        ].every(num))
    )
      return null;
    apps.push({
      instanceId: a.instanceId,
      appId: a.appId,
      loaded: a.loaded,
      expectedPhase: a.expectedPhase,
      acknowledgedPhase: a.acknowledgedPhase,
      acknowledgementAgeMs: a.acknowledgementAgeMs,
      gate: g
        ? {
            documentId: g.documentId,
            phase: g.phase,
            allowedApi: g.allowedApi,
            deferredApi: g.deferredApi,
            passedThroughApi: g.passedThroughApi,
            allowedOther: g.allowedOther,
          }
        : null,
    });
  }
  const incidents: RendererIncident[] = [];
  for (const i of v.incidents) {
    if (
      !i ||
      !["long-task", "input-delay", "timer-delay"].includes(i.kind) ||
      !date(i.startedAt) ||
      !num(i.durationMs)
    )
      return null;
    const attribution =
      i.kind === "long-task" ? parseAttribution(i.attribution) : undefined;
    if (i.attribution !== undefined && i.kind === "long-task" && !attribution)
      return null;
    incidents.push({
      kind: i.kind,
      startedAt: i.startedAt,
      durationMs: i.durationMs,
      ...(attribution ? { attribution } : {}),
    });
  }
  return {
    sessionId: v.sessionId,
    sequence: v.sequence,
    startedAt: v.startedAt,
    finishedAt: v.finishedAt,
    documentVisible: v.documentVisible,
    longTasksSupported: v.longTasksSupported,
    inputTimingSupported: v.inputTimingSupported,
    longTaskCount: v.longTaskCount,
    longTaskTotalMs: v.longTaskTotalMs,
    maxInputDelayMs: v.maxInputDelayMs,
    maxTimerDelayMs: v.maxTimerDelayMs,
    droppedIncidents: v.droppedIncidents,
    failedReports: v.failedReports,
    apps,
    incidents,
  };
}

export class RendererPerformanceDiagnostics {
  private sessions = new Map<
    string,
    { receivedAt: number; samples: RendererPerformanceSample[] }
  >();
  record(value: unknown, now = Date.now()): boolean {
    const sample = parseRendererSample(value);
    if (!sample) return false;
    const session = this.sessions.get(sample.sessionId) ?? {
      receivedAt: now,
      samples: [],
    };
    if (sample.sequence <= (session.samples.at(-1)?.sequence ?? -1))
      return false;
    session.receivedAt = now;
    session.samples.push(sample);
    if (session.samples.length > MAX_SAMPLES) session.samples.shift();
    this.sessions.delete(sample.sessionId);
    this.sessions.set(sample.sessionId, session);
    if (this.sessions.size > MAX_SESSIONS)
      this.sessions.delete(this.sessions.keys().next().value!);
    return true;
  }
  snapshot(now = Date.now()) {
    return {
      sampleLimitPerSession: MAX_SAMPLES,
      sessionLimit: MAX_SESSIONS,
      note: "Renderer-reported observations, not per-app CPU attribution. Gate counts exclude bypassed fetches, XHR and SSE. Timer delay can include system sleep. Missing or stale reports are not evidence of an idle app.",
      sessions: [...this.sessions.entries()].map(([sessionId, s]) => ({
        sessionId,
        receivedAt: new Date(s.receivedAt).toISOString(),
        ageMs: Math.max(0, now - s.receivedAt),
        stale: now - s.receivedAt > 15000,
        samples: s.samples,
      })),
    };
  }
}
export const rendererPerformanceDiagnostics =
  new RendererPerformanceDiagnostics();
