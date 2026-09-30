import { getGatewayHealthEvents, type GatewayHealthEvent } from "./gatewayHealthEvents.js";
import type { DiagnosticRecord } from "../../core/utils/performanceDiagnostics.js";
import type { GatewayResourceSample } from "./gatewayEventLoopMonitor.js";

export const DEFAULT_SLOW_EVENT_LOOP_MAX_MS = 500;

export interface OperationRef {
  id: string;
  kind: string;
  name: string;
  chatId?: string;
  provider?: string;
  model?: string;
  status: string;
}

export interface SlowEventLoopWindow {
  sampleStartedAt: string;
  sampleFinishedAt: string;
  elapsedMs: number;
  eventLoop: GatewayResourceSample["eventLoop"];
  cpuPercentOfOneCore: number;
  gcInWindow: GatewayResourceSample["gc"];
  /** Ops whose IDs were recorded at the sample boundary (not proof of causation). */
  activeAtSample: OperationRef[];
  /** Ops whose lifetime overlaps this sample window (better for “what was in flight”). */
  overlapping: OperationRef[];
  note: string;
}

export interface TimelineOperationBar {
  id: string;
  kind: DiagnosticRecord["kind"];
  name: string;
  chatId?: string;
  status: DiagnosticRecord["status"];
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  queueMs?: number;
  durationMs?: number;
  totalMs?: number;
  firstResponseMs?: number;
  longestStreamGapMs?: number;
  parentId?: string;
  turnId?: string;
  provider?: string;
  model?: string;
  errorType?: string;
  waits?: DiagnosticRecord["waits"];
  row: number;
}

export interface GatewayPerformanceTimeline {
  capturedAt: string;
  rangeStart: string;
  rangeEnd: string;
  lanes: DiagnosticRecord["kind"][];
  operations: TimelineOperationBar[];
  slowEventLoopWindows: SlowEventLoopWindow[];
  healthEvents: GatewayHealthEvent[];
}

function toMs(iso: string): number {
  return Date.parse(iso);
}

function opRef(record: DiagnosticRecord): OperationRef {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    ...(record.chatId ? { chatId: record.chatId } : {}),
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.model ? { model: record.model } : {}),
    status: record.status,
  };
}

function overlapsSample(
  record: DiagnosticRecord,
  sample: GatewayResourceSample,
  capturedAtIso: string,
): boolean {
  const sampleStart = toMs(sample.startedAt);
  const sampleEnd = toMs(sample.finishedAt);
  const queued = toMs(record.queuedAt);
  const ended = record.finishedAt
    ? toMs(record.finishedAt)
    : toMs(capturedAtIso);
  return queued <= sampleEnd && ended >= sampleStart;
}

export function buildOperationIndex(
  active: DiagnosticRecord[],
  recent: DiagnosticRecord[],
): Map<string, DiagnosticRecord> {
  const map = new Map<string, DiagnosticRecord>();
  for (const record of [...recent, ...active]) {
    map.set(record.id, record);
  }
  return map;
}

export function correlateSlowEventLoopWindows(
  samples: GatewayResourceSample[],
  operationIndex: Map<string, DiagnosticRecord>,
  capturedAt: string,
  minMaxMs = DEFAULT_SLOW_EVENT_LOOP_MAX_MS,
): SlowEventLoopWindow[] {
  const allOps = [...operationIndex.values()];
  return samples
    .filter((sample) => sample.eventLoop.maxMs >= minMaxMs)
    .map((sample) => {
      const activeAtSample: OperationRef[] = sample.activeOperationIds
        .map((id) => operationIndex.get(id))
        .filter((record): record is DiagnosticRecord => record !== undefined)
        .map(opRef);

      const overlapping = allOps
        .filter((record) => overlapsSample(record, sample, capturedAt))
        .map(opRef);

      return {
        sampleStartedAt: sample.startedAt,
        sampleFinishedAt: sample.finishedAt,
        elapsedMs: sample.elapsedMs,
        eventLoop: { ...sample.eventLoop },
        cpuPercentOfOneCore: sample.cpuPercentOfOneCore,
        gcInWindow: { ...sample.gc },
        activeAtSample,
        overlapping,
        note:
          "Temporal overlap shows work in flight during this window; it does not prove that work blocked the event loop. Short synchronous work may finish between samples.",
      };
    })
    .sort(
      (a, b) =>
        b.eventLoop.maxMs - a.eventLoop.maxMs ||
        a.sampleFinishedAt.localeCompare(b.sampleFinishedAt),
    );
}

/** Assign sub-rows within a lane so overlapping bars stack vertically. */
export function assignTimelineRows(
  records: DiagnosticRecord[],
  capturedAt: string,
): TimelineOperationBar[] {
  const sorted = [...records].sort(
    (a, b) => a.queuedAt.localeCompare(b.queuedAt),
  );
  const rowEnds: number[] = [];
  const bars: TimelineOperationBar[] = [];

  for (const record of sorted) {
    const start = toMs(record.queuedAt);
    const end = record.finishedAt
      ? toMs(record.finishedAt)
      : toMs(capturedAt);

    let row = 0;
    while (row < rowEnds.length && rowEnds[row]! > start) {
      row++;
    }
    if (row === rowEnds.length) {
      rowEnds.push(end);
    } else {
      rowEnds[row] = end;
    }

    bars.push({
      id: record.id,
      kind: record.kind,
      name: record.name,
      ...(record.chatId ? { chatId: record.chatId } : {}),
      status: record.status,
      queuedAt: record.queuedAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(record.queueMs !== undefined ? { queueMs: record.queueMs } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.totalMs !== undefined ? { totalMs: record.totalMs } : {}),
      ...(record.firstResponseMs !== undefined
        ? { firstResponseMs: record.firstResponseMs }
        : {}),
      longestStreamGapMs: record.longestStreamGapMs,
      parentId: record.parentId, turnId: record.turnId, provider: record.provider, model: record.model,
      errorType: record.errorType, waits: record.waits?.map(wait => ({ ...wait })),
      row,
    });
  }

  return bars;
}

const LANE_ORDER: DiagnosticRecord["kind"][] = [
  "chat",
  "model",
  "tool",
  "background",
  "indexing",
  "setup",
  "heap-snapshot",
];

export function buildGatewayPerformanceTimeline(input: {
  capturedAt: string;
  samples: GatewayResourceSample[];
  active: DiagnosticRecord[];
  recent: DiagnosticRecord[];
  minSlowMaxMs?: number;
}): GatewayPerformanceTimeline {
  const operationIndex = buildOperationIndex(input.active, input.recent);
  const allRecords = [...operationIndex.values()];
  const healthEvents = getGatewayHealthEvents();
  const rangeStart =
    [...allRecords.map(record => record.queuedAt), ...input.samples.map(sample => sample.startedAt), ...healthEvents.map(event => event.timestamp)].reduce(
      (min, timestamp) => timestamp < min ? timestamp : min,
      input.capturedAt,
    ) ?? input.capturedAt;
  const slowEventLoopWindows = correlateSlowEventLoopWindows(
    input.samples,
    operationIndex,
    input.capturedAt,
    input.minSlowMaxMs ?? DEFAULT_SLOW_EVENT_LOOP_MAX_MS,
  );

  const operations = assignTimelineRows(allRecords, input.capturedAt);
  const lanes = LANE_ORDER.filter((kind) =>
    operations.some((bar) => bar.kind === kind),
  );

  return {
    capturedAt: input.capturedAt,
    rangeStart,
    rangeEnd: input.capturedAt,
    lanes,
    operations,
    slowEventLoopWindows,
    healthEvents,
  };
}
