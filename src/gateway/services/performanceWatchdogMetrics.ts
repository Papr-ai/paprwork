/** Read-only OS measurements. Missing/denied probes remain explicit, never zero. */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type Measurement<T> = { status: "available"; value: T } | {
  status: "unavailable"; reason: string;
};
function commandFailure(error: unknown): Measurement<never> {
  const detail = error as { code?: unknown; killed?: boolean } | null;
  const code = String(detail?.code ?? "command_failed");
  return { status: "unavailable", reason: detail?.killed ? "timeout_or_output_limit" :
    ["EPERM", "EACCES", "ENOENT"].includes(code) ? code : "command_failed" };
}

export async function diagnosticCommand(command: string, args: string[], timeout = 2000): Promise<Measurement<string>> {
  return new Promise(resolve => {
    try {
      execFile(command, args, { timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
        encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } }, (error, stdout) => {
        resolve(error ? commandFailure(error) : { status: "available", value: stdout });
      });
    } catch (error) {
      // spawn can throw synchronously under sandbox/OS restrictions.
      resolve(commandFailure(error));
    }
  });
}

export function parseVmStat(text: string) {
  const pageSizeBytes = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!pageSizeBytes) throw new Error("invalid_vm_stat");
  const pages: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([^:]+):\s+(\d+)\.?\s*$/);
    if (match) pages[match[1]] = Number(match[2]);
  }
  const bytes = (key: string) => key in pages ? pages[key] * pageSizeBytes : null;
  return { pageSizeBytes, freeBytes: bytes("Pages free"), wiredBytes: bytes("Pages wired down"),
    compressorBytes: bytes("Pages occupied by compressor"),
    uncompressedBytesInCompressor: bytes("Pages stored in compressor"),
    counters: { pageins: pages.Pageins ?? null, pageouts: pages.Pageouts ?? null,
      swapins: pages.Swapins ?? null, swapouts: pages.Swapouts ?? null,
      compressions: pages.Compressions ?? null, decompressions: pages.Decompressions ?? null } };
}

export function parseSwapUsage(text: string) {
  const bytes = (key: string) => {
    const m = text.match(new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT]?)`, "i"));
    if (!m) throw new Error("invalid_swap_usage");
    return Number(m[1]) * 1024 ** (m[2] ? "KMGT".indexOf(m[2].toUpperCase()) + 1 : 0);
  };
  return { totalBytes: bytes("total"), usedBytes: bytes("used"), freeBytes: bytes("free") };
}

export function parseMemoryPressure(text: string) {
  // XNU exports the NOTE_MEMORYSTATUS_PRESSURE_* dispatch flags (sys/event_private.h).
  const rawLevel = Number(text.trim());
  const level = ({ 1: "normal", 2: "warning", 4: "critical" } as Record<number, string>)[rawLevel];
  if (!level) throw new Error("unknown_pressure_level");
  return { level, rawLevel };
}

export interface ProcessMeasurement { pid: number; parentPid: number; cpuPercent: number; rssBytes: number; executable: string }
export function parseProcessTable(text: string): ProcessMeasurement[] {
  return text.split("\n").flatMap(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    return m ? [{ pid: Number(m[1]), parentPid: Number(m[2]), cpuPercent: Number(m[3]),
      rssBytes: Number(m[4]) * 1024, executable: path.basename(m[5].trim()).slice(0, 120) }] : [];
  });
}

export function selectProcesses(rows: ProcessMeasurement[], gatewayPid: number) {
  const ids = new Set([gatewayPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (ids.has(row.parentPid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
  }
  const family = rows.filter(row => ids.has(row.pid));
  return { gatewayAndDescendants: family.slice(0, 64), omittedDescendants: Math.max(0, family.length - 64),
    topHostCpu: [...rows].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5),
    topHostMemory: [...rows].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 5) };
}

export function parseMeasurement<T>(result: Measurement<string>, parse: (text: string) => T): Measurement<T> {
  if (result.status === "unavailable") return result;
  try { return { status: "available", value: parse(result.value) }; }
  catch { return { status: "unavailable", reason: "unrecognized_output" }; }
}

export function counterRates(current: Record<string, number | null>, previous: Record<string, number | null>, elapsedMs: number) {
  return Object.fromEntries(Object.entries(current).map(([key, value]) => {
    const before = previous[key];
    return [key, value !== null && before != null && value >= before && elapsedMs > 0 ? (value - before) * 1000 / elapsedMs : null];
  }));
}

export async function collectHostMeasurements(gatewayPid: number) {
  const startedAt = new Date().toISOString();
  const unsupported: Measurement<string> = { status: "unavailable", reason: "unsupported_platform" };
  const mac = process.platform === "darwin";
  const [vm, swap, pressure, processes] = await Promise.all([
    mac ? diagnosticCommand("/usr/bin/vm_stat", []) : unsupported,
    mac ? diagnosticCommand("/usr/sbin/sysctl", ["-n", "vm.swapusage"]) : unsupported,
    mac ? diagnosticCommand("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]) : unsupported,
    process.platform !== "win32" ? diagnosticCommand("/bin/ps", ["-axo", "pid=,ppid=,%cpu=,rss=,comm="]) : unsupported,
  ]);
  return { startedAt, finishedAt: new Date().toISOString(), logicalCpuCount: os.cpus().length,
    freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem(), loadAverage: os.loadavg(),
    virtualMemory: parseMeasurement(vm, parseVmStat), swap: parseMeasurement(swap, parseSwapUsage),
    memoryPressure: parseMeasurement(pressure, parseMemoryPressure),
    processes: parseMeasurement(processes, text => {
      const rows = parseProcessTable(text);
      if (!rows.length) throw new Error("empty_process_table");
      return selectProcesses(rows, gatewayPid);
    }) };
}

export function sanitizeStack(text: string, home: string): { text: string; truncated: boolean } {
  // Keep the thread call trees; discard metadata and binary-image paths.
  const start = text.indexOf("Call graph:");
  if (start < 0) return { text: "", truncated: false };
  let callGraph = text.slice(start).split("Binary Images:")[0];
  if (home) callGraph = callGraph.split(home).join("~");
  const buffer = Buffer.from(callGraph);
  return { text: new TextDecoder().decode(buffer.subarray(0, 64 * 1024), { stream: true }), truncated: buffer.length > 64 * 1024 };
}

export async function captureNativeStack(pid: number): Promise<Measurement<{ text: string; truncated: boolean }>> {
  if (process.env.PAPR_PERFORMANCE_STACK_SAMPLES === "0") return { status: "unavailable", reason: "disabled" };
  if (process.platform !== "darwin") return { status: "unavailable", reason: "native_sampling_requires_macos" };
  const result = await diagnosticCommand("/usr/bin/sample", [String(pid), "1", "10", "-file", "/dev/stdout"], 6000);
  return parseMeasurement(result, text => {
    const stack = sanitizeStack(text, os.homedir());
    if (!stack.text) throw new Error("no_call_graph");
    return stack;
  });
}
