/**
 * Resident memory of process trees, cross-platform, from one OS call.
 *   macOS / Linux: ps -axo pid=,ppid=,rss=   (rss in KB)
 *   Windows:       PowerShell Get-CimInstance Win32_Process (WorkingSetSize in bytes); slower, so the watchdog samples
 *                  it less often.
 */
import { execFile } from "child_process";

export interface ProcRow { pid: number; ppid: number; rssBytes: number }

const run = (cmd: string, args: string[], timeout = 3000): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? "" : String(out)));
  });

export function parsePs(out: string, rssUnitBytes = 1024): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) * rssUnitBytes });
  }
  return rows;
}

export async function listProcesses(): Promise<ProcRow[]> {
  if (process.platform === "win32") {
    const ps = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)\" }";
    return parsePs(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 8000), 1);
  }
  return parsePs(await run("ps", ["-axo", "pid=,ppid=,rss="]));
}

/** pid → all descendants (inclusive). */
export function treeOf(rootPid: number, rows: ProcRow[]): ProcRow[] {
  const kids = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = kids.get(r.ppid);
    if (list) list.push(r);
    else kids.set(r.ppid, [r]);
  }
  const out: ProcRow[] = [];
  const self = rows.find((r) => r.pid === rootPid);
  if (!self) return out;
  const stack = [self];
  const seen = new Set<number>();
  while (stack.length) {
    const r = stack.pop()!;
    if (seen.has(r.pid)) continue;
    seen.add(r.pid);
    out.push(r);
    for (const k of kids.get(r.pid) ?? []) stack.push(k);
  }
  return out;
}

export const treeRss = (rootPid: number, rows: ProcRow[]): number => treeOf(rootPid, rows).reduce((s, r) => s + r.rssBytes, 0);

/** Pause / resume / stop a whole tree. Windows has no SIGSTOP: pause is a no-op there, stop uses taskkill /T. */
export function signalTree(rootPid: number, rows: ProcRow[], sig: "SIGSTOP" | "SIGCONT" | "SIGKILL"): number {
  if (process.platform === "win32") {
    if (sig !== "SIGKILL") return 0;
    execFile("taskkill", ["/PID", String(rootPid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return 1;
  }
  let n = 0;
  // Children first for SIGSTOP/SIGKILL so a parent can't respawn them; order doesn't matter for SIGCONT.
  for (const r of treeOf(rootPid, rows).reverse()) {
    try { process.kill(r.pid, sig); n++; } catch { /* already gone */ }
  }
  return n;
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
