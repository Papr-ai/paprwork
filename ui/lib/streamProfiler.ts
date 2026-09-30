/**
 * Renderer-side stream latency profiler.
 * Enable with VITE_PAPR_STREAM_PROFILE=1 or localStorage PAPR_STREAM_PROFILE=1.
 */

export function isUiStreamProfilingEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const ls = window.localStorage.getItem("PAPR_STREAM_PROFILE");
    if (ls === "1" || ls === "true") return true;
  } catch {
    // ignore
  }
  const env = import.meta.env.VITE_PAPR_STREAM_PROFILE;
  return env === "1" || env === "true";
}

export interface UiStreamProfileMark {
  label: string;
  msSinceStart: number;
}

export class UiStreamProfiler {
  private readonly startMs: number;
  private readonly marks: UiStreamProfileMark[] = [];
  private finished = false;

  constructor(readonly chatId: string) {
    this.startMs = performance.now();
    if (isUiStreamProfilingEnabled()) {
      this.mark("ui.send.start");
    }
  }

  mark(label: string): void {
    if (!isUiStreamProfilingEnabled() || this.finished) return;
    this.marks.push({
      label,
      msSinceStart: performance.now() - this.startMs,
    });
  }

  measureSync(label: string, fn: () => void): void {
    if (!isUiStreamProfilingEnabled()) {
      fn();
      return;
    }
    const t0 = performance.now();
    fn();
    const elapsed = performance.now() - t0;
    this.marks.push({
      label: `${label} (${elapsed.toFixed(1)}ms sync)`,
      msSinceStart: performance.now() - this.startMs,
    });
  }

  printSummary(): void {
    if (!isUiStreamProfilingEnabled() || this.marks.length === 0) return;
    this.finished = true;

    const gaps: Array<{ from: string; to: string; ms: number }> = [];
    for (let i = 1; i < this.marks.length; i++) {
      gaps.push({
        from: this.marks[i - 1].label,
        to: this.marks[i].label,
        ms: this.marks[i].msSinceStart - this.marks[i - 1].msSinceStart,
      });
    }
    gaps.sort((a, b) => b.ms - a.ms);

    const total =
      this.marks[this.marks.length - 1]?.msSinceStart ??
      performance.now() - this.startMs;

    console.log(
      [
        "",
        "═".repeat(72),
        `[StreamProfile:ui] chat=${this.chatId}`,
        "─".repeat(72),
        ...this.marks.map(
          (m) =>
            `    ${m.msSinceStart.toFixed(1).padStart(8)}  ${m.label}`,
        ),
        "─".repeat(72),
        "  Largest UI gaps:",
        ...gaps.slice(0, 6).map(
          (g) =>
            `    ${g.ms.toFixed(1).padStart(8)}ms  ${g.from} → ${g.to}`,
        ),
        "─".repeat(72),
        `  Total UI span: ${total.toFixed(1)}ms`,
        "═".repeat(72),
      ].join("\n"),
    );
  }
}

const activeByChatId = new Map<string, UiStreamProfiler>();

export function startUiStreamProfiler(chatId: string): UiStreamProfiler {
  const p = new UiStreamProfiler(chatId);
  activeByChatId.set(chatId, p);
  return p;
}

export function getUiStreamProfiler(
  chatId: string,
): UiStreamProfiler | undefined {
  return activeByChatId.get(chatId);
}

export function finishUiStreamProfiler(chatId: string): void {
  const p = activeByChatId.get(chatId);
  if (!p) return;
  activeByChatId.delete(chatId);
  p.printSummary();
}
