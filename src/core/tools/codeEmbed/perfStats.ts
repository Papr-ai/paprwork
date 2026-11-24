/**
 * Rolling performance numbers for on-device code search, shown in /api/code-embed/status so "is it slowing my Mac?" has
 * an answer without Activity Monitor. Budget: indexing averages at most 1 core, a search query's embed p50 under 100 ms.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

export const QUERY_P50_BUDGET_MS = 100;
export const INDEX_CORES_BUDGET = 1;

/** p50 / p95 of the last `cap` samples. */
export class Samples {
  private xs: number[] = [];
  constructor(private readonly cap = 200) {}
  add(ms: number): void {
    this.xs.push(ms);
    if (this.xs.length > this.cap) this.xs.shift();
  }
  get count(): number {
    return this.xs.length;
  }
  pct(p: number): number | null {
    if (!this.xs.length) return null;
    const s = [...this.xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
  }
}

/** CPU seconds a process has used, null when unknown. Linux: /proc/<pid>/stat (ps TIME there is whole seconds only).
 *  macOS: ps TIME (hundredths). Not on Windows. */
export function cpuSeconds(pid: number | undefined): number | null {
  if (!pid || process.platform === "win32") return null;
  if (process.platform === "linux") {
    try {
      // Fields after the ")" of comm: state is [0], utime [11], stime [12], in clock ticks (USER_HZ = 100 on Linux).
      const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      return (Number(f[11]) + Number(f[12])) / 100;
    } catch {
      return null;
    }
  }
  try {
    const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { timeout: 2000 }).toString().trim();
    // [[dd-]hh:]mm:ss.cc
    const [days, rest] = t.includes("-") ? t.split("-") : ["0", t];
    const parts = rest!.split(":").map(Number);
    while (parts.length < 3) parts.unshift(0);
    return Number(days) * 86400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  } catch {
    return null;
  }
}

/** Average cores used by the embed process(es) while indexing: CPU time spent during batches / wall time of batches. */
export class IndexCpu {
  private cpu = 0;
  private wall = 0;
  addBatch(cpuSec: number, wallSec: number): void {
    if (cpuSec >= 0 && wallSec > 0) { this.cpu += cpuSec; this.wall += wallSec; }
  }
  get cores(): number | null {
    return this.wall > 0 ? Math.round((this.cpu / this.wall) * 100) / 100 : null;
  }
}
