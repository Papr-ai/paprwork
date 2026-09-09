/**
 * Opt-in stream latency profiler.
 * Enable with PAPR_STREAM_PROFILE=1 (gateway) or VITE_PAPR_STREAM_PROFILE=1 (UI).
 */

export function isStreamProfilingEnabled(): boolean {
  const v = process.env.PAPR_STREAM_PROFILE;
  return v === "1" || v === "true";
}

export interface StreamProfileMark {
  label: string;
  msSinceStart: number;
}

export interface StreamProfileGap {
  from: string;
  to: string;
  ms: number;
}

export class StreamProfiler {
  private readonly startMs: number;
  private readonly marks: StreamProfileMark[] = [];
  private readonly meta: Record<string, string | number | boolean> = {};
  private finished = false;

  constructor(
    readonly scope: string,
    readonly streamKey: string,
  ) {
    this.startMs = performance.now();
    if (isStreamProfilingEnabled()) {
      this.mark("profiler.start");
    }
  }

  mark(label: string): void {
    if (!isStreamProfilingEnabled() || this.finished) return;
    this.marks.push({
      label,
      msSinceStart: performance.now() - this.startMs,
    });
  }

  setMeta(key: string, value: string | number | boolean): void {
    if (!isStreamProfilingEnabled()) return;
    this.meta[key] = value;
  }

  async measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!isStreamProfilingEnabled()) {
      return fn();
    }
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      const elapsed = performance.now() - t0;
      this.marks.push({
        label: `${label} (${elapsed.toFixed(1)}ms)`,
        msSinceStart: performance.now() - this.startMs,
      });
    }
  }

  getGaps(): StreamProfileGap[] {
    const gaps: StreamProfileGap[] = [];
    for (let i = 1; i < this.marks.length; i++) {
      const prev = this.marks[i - 1];
      const cur = this.marks[i];
      gaps.push({
        from: prev.label,
        to: cur.label,
        ms: cur.msSinceStart - prev.msSinceStart,
      });
    }
    return gaps;
  }

  printSummary(extra?: Record<string, string | number | boolean>): void {
    if (!isStreamProfilingEnabled() || this.marks.length === 0) return;
    this.finished = true;

    const totalMs =
      this.marks[this.marks.length - 1]?.msSinceStart ??
      performance.now() - this.startMs;
    const gaps = this.getGaps().sort((a, b) => b.ms - a.ms);
    const meta = { ...this.meta, ...extra };

    const lines: string[] = [];
    lines.push("");
    lines.push("═".repeat(72));
    lines.push(`[StreamProfile:${this.scope}] ${this.streamKey}`);
    if (Object.keys(meta).length > 0) {
      lines.push(
        `  meta: ${Object.entries(meta)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      );
    }
    lines.push("─".repeat(72));
    lines.push("  Timeline (ms from stream start):");
    for (const m of this.marks) {
      lines.push(`    ${m.msSinceStart.toFixed(1).padStart(8)}  ${m.label}`);
    }
    lines.push("─".repeat(72));
    lines.push("  Largest gaps (likely bottlenecks):");
    for (const g of gaps.slice(0, 8)) {
      lines.push(
        `    ${g.ms.toFixed(1).padStart(8)}ms  ${g.from} → ${g.to}`,
      );
    }
    lines.push("─".repeat(72));
    lines.push(`  Total profiled span: ${totalMs.toFixed(1)}ms`);
    lines.push("═".repeat(72));
    console.log(lines.join("\n"));
  }
}

const activeByChatId = new Map<string, StreamProfiler>();

export function startStreamProfiler(
  chatId: string,
  scope = "gateway",
): StreamProfiler {
  const profiler = new StreamProfiler(scope, chatId);
  activeByChatId.set(chatId, profiler);
  return profiler;
}

export function getStreamProfiler(chatId: string): StreamProfiler | undefined {
  return activeByChatId.get(chatId);
}

export function finishStreamProfiler(
  chatId: string,
  extra?: Record<string, string | number | boolean>,
): void {
  const profiler = activeByChatId.get(chatId);
  if (!profiler) return;
  activeByChatId.delete(chatId);
  profiler.printSummary(extra);
}
