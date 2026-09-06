/**
 * Lightweight phase timer for gateway hot paths (scheduler tick, persistence, etc.).
 */

export class PhaseTimer {
  private readonly startedAt = performance.now();
  private lastMarkAt = this.startedAt;
  private readonly phases: Array<{ name: string; ms: number }> = [];

  mark(phase: string): void {
    const now = performance.now();
    this.phases.push({ name: phase, ms: Math.round(now - this.lastMarkAt) });
    this.lastMarkAt = now;
  }

  totalMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  formatPhases(): string {
    return this.phases.map((p) => `${p.name}=${p.ms}ms`).join(" ");
  }

  /** Log when total exceeds threshold (always includes phase breakdown). */
  logIfSlow(label: string, thresholdMs: number): void {
    const total = this.totalMs();
    if (total < thresholdMs) {
      return;
    }
    console.log(`[${label}] ${total}ms total — ${this.formatPhases()}`);
  }

  /** Always log (for operations we always want traced, e.g. scheduler ticks). */
  log(label: string): void {
    console.log(`[${label}] ${this.totalMs()}ms total — ${this.formatPhases()}`);
  }
}
