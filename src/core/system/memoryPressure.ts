/**
 * Cross-platform memory pressure, for the resource governor.
 *
 * Why not os.freemem(): on macOS it counts only "free" pages (a healthy 16 GB Mac reports ~1 GB), and it says nothing
 * about the compressor. The Nov 19 kernel panic (watchdog timeout, compressor at its segment limit, 46 swap files) gave
 * no warning in free memory; the compressor and swap were the signal.
 *
 *   macOS   vm_stat (free + inactive + speculative + purgeable = available; pages occupied by compressor),
 *           sysctl kern.memorystatus_vm_pressure_level, vm.swapusage, vm.compressor_segment_pages_compressed(_limit)
 *   Linux   /proc/meminfo MemAvailable, SwapTotal/SwapFree, /proc/pressure/memory (PSI) "some avg10"
 *   Windows os.freemem() (= available physical memory). No compressor/PSI signal: state comes from available share.
 *
 * Every reader is best-effort: an unreadable signal is null and never raises the state on its own.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";

export type PressureState = "green" | "yellow" | "red" | "critical";

export interface MemorySnapshot {
  at: number;
  platform: NodeJS.Platform;
  totalBytes: number;
  /** Memory the OS can hand out without paging. */
  availableBytes: number;
  /** macOS: RAM held by the compressor. null elsewhere. */
  compressorBytes: number | null;
  /** macOS: compressed pages / the kernel's compressed-pages limit (0-1). The panic logged 88% of this. */
  compressorLimitShare: number | null;
  /** macOS memorystatus level: 1 normal, 2 warning, 4 critical. Linux: PSI mapped to the same scale. */
  osPressureLevel: number | null;
  swapUsedBytes: number | null;
  /** Linux PSI "some avg10" (% of time stalled on memory). */
  psiSome10: number | null;
}

const GB = 1024 ** 3;

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, out) => resolve(err ? "" : String(out)));
  });

export function parseVmStat(out: string): { pageSize: number; availablePages: number; compressorPages: number } | null {
  if (!out) return null;
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (k: string): number => Number(out.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1] ?? 0);
  return {
    pageSize,
    availablePages: pages("free") + pages("inactive") + pages("speculative") + pages("purgeable"),
    compressorPages: pages("occupied by compressor"),
  };
}

export function parseSwapUsage(out: string): number | null {
  const m = out.match(/used = ([\d.]+)M/);
  return m ? Number(m[1]) * 1024 * 1024 : null;
}

export function parseMeminfo(out: string): { availableBytes: number | null; swapUsedBytes: number | null } {
  const kb = (k: string): number | null => {
    const m = out.match(new RegExp(`^${k}:\\s+(\\d+) kB`, "m"));
    return m ? Number(m[1]) * 1024 : null;
  };
  const st = kb("SwapTotal");
  const sf = kb("SwapFree");
  return { availableBytes: kb("MemAvailable"), swapUsedBytes: st !== null && sf !== null ? st - sf : null };
}

export function parsePsi(out: string): number | null {
  const m = out.match(/^some avg10=([\d.]+)/m);
  return m ? Number(m[1]) : null;
}

/** Linux PSI → the macOS memorystatus scale, so one classifier works for both. */
export const psiToLevel = (psi: number | null): number | null => (psi === null ? null : psi >= 40 ? 4 : psi >= 10 ? 2 : 1);

export async function readMemorySnapshot(): Promise<MemorySnapshot> {
  const s: MemorySnapshot = {
    at: Date.now(), platform: process.platform, totalBytes: os.totalmem(), availableBytes: os.freemem(),
    compressorBytes: null, compressorLimitShare: null, osPressureLevel: null, swapUsedBytes: null, psiSome10: null,
  };
  if (process.platform === "darwin") {
    const [vm, lvl, swap, segs] = await Promise.all([
      run("vm_stat", []),
      run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
      run("sysctl", ["-n", "vm.swapusage"]),
      run("sysctl", ["-n", "vm.compressor_segment_pages_compressed", "vm.compressor_segment_pages_compressed_limit"]),
    ]);
    const v = parseVmStat(vm);
    if (v) {
      s.availableBytes = v.availablePages * v.pageSize;
      s.compressorBytes = v.compressorPages * v.pageSize;
    }
    const n = Number(lvl.trim());
    s.osPressureLevel = Number.isFinite(n) && n > 0 ? n : null;
    s.swapUsedBytes = parseSwapUsage(swap);
    const [used, limit] = segs.trim().split(/\s+/).map(Number);
    s.compressorLimitShare = used > 0 && limit > 0 ? used / limit : null;
  } else if (process.platform === "linux") {
    const read = (p: string): string => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
    const mi = parseMeminfo(read("/proc/meminfo"));
    if (mi.availableBytes !== null) s.availableBytes = mi.availableBytes;
    s.swapUsedBytes = mi.swapUsedBytes;
    s.psiSome10 = parsePsi(read("/proc/pressure/memory"));
    s.osPressureLevel = psiToLevel(s.psiSome10);
  }
  return s;
}

/** Thresholds. Starting values: tune on real 8 and 16 GB machines. */
export const T = {
  yellowAvailShare: 0.15,
  redAvailShare: 0.08,
  yellowCompressorShare: 0.25,
  redCompressorShare: 0.4,
  /** Share of the kernel's compressed-pages limit. Above this the compressor is close to what killed the Nov 19 Mac. */
  redCompressorLimit: 0.6,
  criticalCompressorLimit: 0.8,
  /** Swap growth between two samples (~2 s apart while heavy work runs). */
  yellowSwapGrowth: 256 * 1024 ** 2,
  redSwapGrowth: 1 * GB,
};

/** Classify one snapshot (plus the previous one, for swap growth). Pure: unit-tested with fixtures. */
export function classifyPressure(s: MemorySnapshot, prev?: MemorySnapshot | null): { state: PressureState; reasons: string[] } {
  const reasons: string[] = [];
  let state: PressureState = "green";
  const raise = (to: PressureState, why: string): void => {
    const order: PressureState[] = ["green", "yellow", "red", "critical"];
    if (order.indexOf(to) > order.indexOf(state)) state = to;
    reasons.push(why);
  };
  const avail = s.availableBytes / s.totalBytes;
  if (avail < T.redAvailShare) raise("red", `only ${fmtGb(s.availableBytes)} available`);
  else if (avail < T.yellowAvailShare) raise("yellow", `${fmtGb(s.availableBytes)} available`);
  if (s.osPressureLevel !== null && s.osPressureLevel >= 4) raise("critical", "OS reports critical memory pressure");
  else if (s.osPressureLevel === 2) raise("yellow", "OS reports memory pressure");
  if (s.compressorLimitShare !== null) {
    if (s.compressorLimitShare >= T.criticalCompressorLimit) raise("critical", `compressor at ${pct(s.compressorLimitShare)} of its limit`);
    else if (s.compressorLimitShare >= T.redCompressorLimit) raise("red", `compressor at ${pct(s.compressorLimitShare)} of its limit`);
  }
  if (s.compressorBytes !== null) {
    const c = s.compressorBytes / s.totalBytes;
    if (c >= T.redCompressorShare) raise("red", `compressor holds ${pct(c)} of RAM`);
    else if (c >= T.yellowCompressorShare) raise("yellow", `compressor holds ${pct(c)} of RAM`);
  }
  if (prev && s.swapUsedBytes !== null && prev.swapUsedBytes !== null) {
    const g = s.swapUsedBytes - prev.swapUsedBytes;
    if (g >= T.redSwapGrowth) raise("red", `swap grew ${fmtGb(g)}`);
    else if (g >= T.yellowSwapGrowth) raise("yellow", `swap growing`);
  }
  return { state, reasons };
}

export const fmtGb = (b: number): string => `${(b / GB).toFixed(1)} GB`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;
