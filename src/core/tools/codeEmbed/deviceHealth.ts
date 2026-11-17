/**
 * Which code-embedding tier this machine gets. Static checks at startup, a speed self-test after the model loads,
 * and live checks (memory pressure, battery saver) before each background batch. Search never waits on any of this.
 *
 *   local  - the device embeds queries and edited files (papr-embed-code-1-0.6b, ONNX int8)
 *   cloud  - the device is too weak or the model is not installed: queries embed on Papr Cloud, files come from the
 *            cloud-built index; unpublished edits are found by graph + exact words until published
 *   off    - no model and no cloud (offline / signed out / opted out): graph + exact words + grep only
 *
 * Rules mirror papr-pythonSDK _is_old_platform (Intel Mac, base M1 < 16 GB, < 8 GB, < 4 cores) plus a disk check and
 * the self-test, which catches emulated Windows-on-ARM and thermally throttled laptops.
 */
import { execFileSync } from "child_process";
import * as os from "os";

export type EmbedTier = "local" | "cloud" | "off";

export interface DeviceFacts {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  physicalCores: number;
  totalMemBytes: number;
  freeMemBytes: number;
  freeDiskBytes: number | null;
  /** Running under Rosetta / x64 emulation on arm64 hardware. */
  translated: boolean;
}

export interface TierDecision {
  tier: EmbedTier;
  reasons: string[];
}

const GB = 1024 ** 3;
export const MIN_TOTAL_MEM = 8 * GB;
export const MIN_FREE_MEM_TO_LOAD = 2 * GB;
export const MIN_FREE_DISK = 2 * GB;
/** 8 query-sized embeds must finish under this on the self-test (M2 Pro: ~0.3 s each on CPU int8). */
export const SELF_TEST_BUDGET_MS = 4000;

export function staticTier(f: DeviceFacts, opts: { cloudAvailable: boolean }): TierDecision {
  const reasons: string[] = [];
  const isMac = f.platform === "darwin";
  const appleSilicon = isMac && /apple/i.test(f.cpuModel) && !f.translated;
  if (isMac && !appleSilicon) reasons.push(f.translated ? "running under Rosetta" : "Intel Mac");
  if (isMac && /\bM1\b/.test(f.cpuModel) && !/M1 (Pro|Max|Ultra)/.test(f.cpuModel) && f.totalMemBytes < 16 * GB)
    reasons.push("base M1 with under 16 GB");
  if (f.totalMemBytes < MIN_TOTAL_MEM) reasons.push("under 8 GB RAM");
  if (!isMac && f.physicalCores < 4) reasons.push("fewer than 4 CPU cores");
  if (f.platform === "win32" && f.translated) reasons.push("x64 build emulated on ARM");
  if (f.freeDiskBytes !== null && f.freeDiskBytes < MIN_FREE_DISK) reasons.push("under 2 GB free disk");
  if (!["darwin", "win32", "linux"].includes(f.platform)) reasons.push(`unsupported platform ${f.platform}`);
  if (reasons.length === 0) return { tier: "local", reasons: ["meets on-device minimums"] };
  return { tier: opts.cloudAvailable ? "cloud" : "off", reasons };
}

/** Live check before loading or running a background batch. */
export function canRunNow(f: Pick<DeviceFacts, "freeMemBytes">, onBatterySaver: boolean): { ok: boolean; reason?: string } {
  if (onBatterySaver) return { ok: false, reason: "battery saver" };
  if (f.freeMemBytes < MIN_FREE_MEM_TO_LOAD) return { ok: false, reason: "low free memory" };
  return { ok: true };
}

export function selfTestPasses(totalMs: number): boolean {
  return Number.isFinite(totalMs) && totalMs <= SELF_TEST_BUDGET_MS;
}

let availCache: { at: number; bytes: number } | null = null;

/**
 * Memory the OS can hand out now. os.freemem() on macOS counts only "free" pages and leaves out inactive and
 * speculative pages that macOS reclaims on demand, so a 16 GB Mac routinely reports ~1 GB and would never index.
 * On macOS this adds those pages from vm_stat (cached 10 s); elsewhere os.freemem() (MemAvailable on Linux).
 */
export function availableMemBytes(): number {
  if (process.platform !== "darwin") return os.freemem();
  if (availCache && Date.now() - availCache.at < 10_000) return availCache.bytes;
  let bytes = os.freemem();
  try {
    const out = execFileSync("vm_stat", { timeout: 2000 }).toString();
    const page = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
    const pages = (k: string) => Number(out.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1] ?? 0);
    bytes = (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page;
  } catch {}
  availCache = { at: Date.now(), bytes };
  return bytes;
}

/** Facts for this process. Disk is filled by the caller (statfs needs a path). */
export function readDeviceFacts(freeDiskBytes: number | null = null): DeviceFacts {
  const cpus = os.cpus();
  // Node reports logical cores; Apple Silicon has no SMT and x64 usually has 2-way SMT.
  const logical = cpus.length || 1;
  const physical = process.arch === "arm64" ? logical : Math.max(1, Math.floor(logical / 2));
  let translated = false;
  if (process.platform === "darwin" && process.arch === "x64") {
    try {
      // sysctl.proc_translated = 1 under Rosetta
      translated = execFileSync("sysctl", ["-in", "sysctl.proc_translated"], { timeout: 2000 }).toString().trim() === "1";
    } catch {}
  }
  if (process.platform === "win32" && process.arch === "x64") {
    translated = /arm/i.test(process.env.PROCESSOR_IDENTIFIER ?? "") || process.env.PROCESSOR_ARCHITEW6432 === "ARM64";
  }
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? "",
    physicalCores: physical,
    totalMemBytes: os.totalmem(),
    freeMemBytes: availableMemBytes(),
    freeDiskBytes,
    translated,
  };
}
