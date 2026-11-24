/**
 * Resource governor: one memory budget per machine, shared by every agent, chat and job in this app.
 *
 * Nov 19: four agents each started a Python process that loaded its own copy of a model (3.5-5.6 GB each, 18 GB in
 * total) on a 16 GB Mac that also had 54 GB of Safari tabs resident. The compressor hit its segment limit, the kernel
 * stalled for 94 s and the watchdog panicked the machine. Nothing in the app measured memory: agents were capped by
 * count (6) and the bash tool spawned anything immediately.
 *
 * What this does:
 *   1. Leases. A command classified heavy (commandCost.ts) needs a lease before it starts: granted only when the
 *      pressure state is green or yellow, fewer than maxHeavy() leases are out, and available - estimate - in-flight estimates
 *      stays above the reserve. Otherwise the caller waits a little, then gets a plain answer (who holds memory, how
 *      much) instead of a crash.
 *   2. Watchdog. Every process tree the agent tools start is tracked. While anything is tracked the sensor samples every
 *      2 s. Red: the newest heavy tree is paused (SIGSTOP; resumed when pressure clears). Critical on two samples in a
 *      row, or Red for 30 s: the largest tracked tree is stopped and its agent is told why. Only agent-started trees
 *      are ever touched, never the app or the user's own programs.
 *   3. Agent cap. maxLocalAgents() replaces the fixed 6 with a cap from RAM, lowered while pressure is high.
 *
 * Cross-platform via memoryPressure.ts / processTree.ts. Windows has no SIGSTOP: Red only blocks new heavy work there.
 * PAPR_RESOURCE_GOVERNOR=0 turns leases and the watchdog off (the sensor still reports).
 */
import * as os from "os";
import * as path from "path";
import { getPaprDataDir } from "../utils/paprRoot.js";
import { classifyPressure, fmtGb, readMemorySnapshot, type MemorySnapshot, type PressureState } from "./memoryPressure.js";
import { estimateCommandCost, LearnedPeaks, type CommandCost } from "./commandCost.js";
import { isAlive, listProcesses, signalTree, treeRss, type ProcRow } from "./processTree.js";

const GB = 1024 ** 3;
const FAST_MS = 2_000;
const IDLE_MS = 30_000;
const RED_ESCALATE_MS = 30_000;
const RESUME_AFTER_MS = 10_000;
/** The watchdog only pauses / stops trees at least this big (a 50 MB grep is never the problem). */
const ACTION_MIN_BYTES = 512 * 1024 ** 2;

export interface Tracked {
  pid: number;
  owner: string;
  command: string;
  cost: CommandCost;
  startedAt: number;
  peakBytes: number;
  lastBytes: number;
  paused: boolean;
  leaseId: number | null;
}

export interface Lease { id: number; owner: string; cost: CommandCost; at: number; pid: number | null }

export type AcquireResult =
  | { ok: true; lease: Lease | null; cost: CommandCost }
  | { ok: false; cost: CommandCost; message: string };

export interface GovernorDeps {
  sample?: () => Promise<MemorySnapshot>;
  processes?: () => Promise<ProcRow[]>;
  signal?: (pid: number, rows: ProcRow[], sig: "SIGSTOP" | "SIGCONT" | "SIGKILL") => number;
  alive?: (pid: number) => boolean;
  now?: () => number;
  totalBytes?: number;
  learnedFile?: string | null;
  enabled?: boolean;
  platform?: NodeJS.Platform;
}

/** Concurrent heavy leases by RAM. 8 GB: 1 (the budget check usually refuses it anyway; heavy work belongs in the cloud). */
export function maxHeavyFor(totalBytes: number): number {
  const g = totalBytes / GB;
  return g < 24 ? 1 : g < 48 ? 2 : 4;
}

/** Local agent sessions by RAM. Agents are light; this bounds the commands they start. */
export function agentCapFor(totalBytes: number): number {
  const g = totalBytes / GB;
  return g <= 9 ? 2 : g <= 17 ? 4 : g <= 33 ? 6 : 8;
}

/** Memory kept free for the user and the OS: 3 GB or 20% of RAM, whichever is larger. */
export const reserveFor = (totalBytes: number): number => Math.max(3 * GB, 0.2 * totalBytes);

export class ResourceGovernor {
  private readonly d: Required<Omit<GovernorDeps, "learnedFile">>;
  readonly learned: LearnedPeaks;
  private snap: MemorySnapshot | null = null;
  private prevSnap: MemorySnapshot | null = null;
  private stateNow: PressureState = "green";
  private reasonsNow: string[] = [];
  private redSince: number | null = null;
  private criticalStreak = 0;
  private calmSince: number | null = null;
  private leases = new Map<number, Lease>();
  private tracked = new Map<number, Tracked>();
  private notes = new Map<number, string>();
  private events: Array<{ at: number; text: string }> = [];
  private nextLease = 1;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastScan = 0;

  constructor(deps: GovernorDeps = {}) {
    this.d = {
      sample: deps.sample ?? readMemorySnapshot,
      processes: deps.processes ?? listProcesses,
      signal: deps.signal ?? signalTree,
      alive: deps.alive ?? isAlive,
      now: deps.now ?? Date.now,
      totalBytes: deps.totalBytes ?? os.totalmem(),
      enabled: deps.enabled ?? process.env.PAPR_RESOURCE_GOVERNOR !== "0",
      platform: deps.platform ?? process.platform,
    };
    this.learned = new LearnedPeaks(deps.learnedFile ?? null);
  }

  get enabled(): boolean { return this.d.enabled; }
  get state(): PressureState { return this.stateNow; }

  private listeners = new Set<(s: PressureState) => void>();

  /** Called whenever the pressure state changes (the agent gate drains its queue when pressure clears). */
  onStateChange(fn: (s: PressureState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start sampling (every 30 s idle, every 2 s while agent commands are tracked). Safe to call more than once. */
  start(): void { this.ensureLoop(); }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Take a fresh sample and update the state machine. */
  async refresh(): Promise<PressureState> {
    const s = await this.d.sample();
    this.prevSnap = this.snap;
    this.snap = s;
    const c = classifyPressure(s, this.prevSnap);
    const changed = c.state !== this.stateNow;
    this.stateNow = c.state;
    if (changed) {
      this.log(`memory ${c.state}${c.reasons.length ? `: ${c.reasons.join("; ")}` : ""}`);
      for (const fn of this.listeners) { try { fn(c.state); } catch { /* listener errors never reach the sampler */ } }
    }
    this.reasonsNow = c.reasons;
    const now = this.d.now();
    this.redSince = c.state === "red" || c.state === "critical" ? (this.redSince ?? now) : null;
    this.criticalStreak = c.state === "critical" ? this.criticalStreak + 1 : 0;
    this.calmSince = c.state === "green" || c.state === "yellow" ? (this.calmSince ?? now) : null;
    return c.state;
  }

  maxHeavy(): number { return maxHeavyFor(this.d.totalBytes); }

  /**
   * Cap on agent sessions starting now, or null for "no extra cap". Agents themselves are light (the leases above
   * bound what they start), so the cap only applies under pressure: Red allows half the RAM-based count, Critical 1.
   * Sessions already running are never stopped by this; new ones wait in the existing queue.
   */
  agentCap(): number | null {
    if (!this.d.enabled) return null;
    const base = agentCapFor(this.d.totalBytes);
    if (this.stateNow === "critical") return 1;
    if (this.stateNow === "red") return Math.max(1, Math.floor(base / 2));
    return null;
  }

  classify(command: string): CommandCost { return estimateCommandCost(command, this.learned.all); }

  /** Can a heavy command start now? Pure check on the latest sample. */
  private admits(cost: CommandCost): { ok: boolean; why: string } {
    // Yellow alone does not refuse: many Macs sit at the OS "warning" level all day with browser tabs. The budget
    // check below still has to pass. Red and Critical refuse outright.
    if (this.stateNow === "red" || this.stateNow === "critical") return { ok: false, why: `memory is tight (${this.reasonsNow.join("; ") || this.stateNow})` };
    const heavy = [...this.leases.values()];
    if (heavy.length >= this.maxHeavy()) return { ok: false, why: `${heavy.length} memory-heavy command${heavy.length > 1 ? "s are" : " is"} already running (limit ${this.maxHeavy()} on this machine)` };
    // Leases whose process has not reached its estimate yet still count against the budget.
    const pending = heavy.reduce((s, l) => {
      const t = l.pid !== null ? this.tracked.get(l.pid) : undefined;
      return s + Math.max(0, l.cost.estimateBytes - (t?.lastBytes ?? 0));
    }, 0);
    const avail = (this.snap?.availableBytes ?? os.freemem()) - pending;
    const reserve = reserveFor(this.d.totalBytes);
    if (avail - cost.estimateBytes < reserve)
      return { ok: false, why: `it needs about ${fmtGb(cost.estimateBytes)} and only ${fmtGb(Math.max(0, avail))} is available (keeping ${fmtGb(reserve)} free for the system)` };
    return { ok: true, why: "" };
  }

  /**
   * Ask to run a command. Light and medium commands always run (they are still tracked). Heavy ones wait up to waitMs
   * for room, then get a refusal the agent can act on.
   */
  async acquire(command: string, owner: string, opts: { waitMs?: number; signal?: AbortSignal } = {}): Promise<AcquireResult> {
    const cost = this.classify(command);
    if (!this.d.enabled || cost.cls !== "heavy") return { ok: true, lease: null, cost };
    const deadline = this.d.now() + (opts.waitMs ?? 20_000);
    for (;;) {
      await this.refresh();
      const a = this.admits(cost);
      if (a.ok) {
        const lease: Lease = { id: this.nextLease++, owner, cost, at: this.d.now(), pid: null };
        this.leases.set(lease.id, lease);
        this.ensureLoop();
        return { ok: true, lease, cost };
      }
      if (this.d.now() >= deadline || opts.signal?.aborted) return { ok: false, cost, message: this.refusal(cost, a.why) };
      await new Promise((r) => setTimeout(r, FAST_MS));
    }
  }

  private refusal(cost: CommandCost, why: string): string {
    const holders = [...this.tracked.values()].filter((t) => t.lastBytes >= ACTION_MIN_BYTES).sort((a, b) => b.lastBytes - a.lastBytes).slice(0, 3)
      .map((t) => `${t.cost.signature || t.command.slice(0, 60)} (${fmtGb(t.lastBytes)}, pid ${t.pid})`);
    return [
      `Not started: this looks memory-heavy (${cost.why}, ~${fmtGb(cost.estimateBytes)}) and ${why}.`,
      holders.length ? `Agent commands holding memory now: ${holders.join(", ")}.` : "",
      "Options: wait for the running work to finish and retry; run it as a cloud job (create_job / run_job with runtime \"cloud\"); or make it lighter (smaller model, fewer workers, one process that loads the model once and is reused).",
    ].filter(Boolean).join(" ");
  }

  /** Register a started process tree (any class) so the watchdog can measure it. */
  track(pid: number | undefined, owner: string, command: string, lease: Lease | null, cost?: CommandCost): void {
    if (!pid) return;
    if (lease) lease.pid = pid;
    this.tracked.set(pid, { pid, owner, command, cost: cost ?? lease?.cost ?? this.classify(command), startedAt: this.d.now(), peakBytes: 0, lastBytes: 0, paused: false, leaseId: lease?.id ?? null });
    this.ensureLoop();
  }

  /** The caller saw the process exit: stop tracking it and hand back any note the watchdog left for its agent. */
  finish(pid: number | undefined, lease?: Lease | null): string | undefined {
    if (lease) this.leases.delete(lease.id);
    if (!pid) return undefined;
    this.untrack(pid);
    const note = this.notes.get(pid);
    this.notes.delete(pid);
    return note;
  }

  /** Stop measuring a tree: learn its peak and free its lease. Notes stay until the caller collects them in finish(). */
  private untrack(pid: number): void {
    const t = this.tracked.get(pid);
    if (!t) return;
    this.learned.record(t.cost.signature, t.peakBytes);
    if (t.leaseId !== null) this.leases.delete(t.leaseId);
    this.tracked.delete(pid);
  }

  release(lease: Lease | null): void { if (lease) this.leases.delete(lease.id); }

  private ensureLoop(): void {
    if (this.timer || !this.d.enabled) return;
    const loop = (): void => {
      const busy = this.tracked.size > 0 || this.leases.size > 0;
      this.timer = setTimeout(() => { void this.tick().finally(loop); }, busy ? FAST_MS : IDLE_MS);
      this.timer.unref?.();
    };
    loop();
  }

  /** One watchdog pass. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.refresh();
      if (!this.tracked.size) return;
      // Windows lists processes through PowerShell (~0.5-1 s); scan there every 10 s instead of every tick.
      const now = this.d.now();
      if (this.d.platform === "win32" && now - this.lastScan < 10_000 && this.stateNow === "green") return;
      this.lastScan = now;
      const rows = await this.d.processes();
      for (const t of [...this.tracked.values()]) {
        if (!this.d.alive(t.pid)) { this.untrack(t.pid); continue; }
        t.lastBytes = treeRss(t.pid, rows);
        t.peakBytes = Math.max(t.peakBytes, t.lastBytes);
      }
      await this.act(rows);
    } catch { /* the watchdog never throws into the app */ } finally {
      this.ticking = false;
    }
  }

  private async act(rows: ProcRow[]): Promise<void> {
    if (!this.d.enabled) return;
    const now = this.d.now();
    const big = [...this.tracked.values()].filter((t) => t.lastBytes >= ACTION_MIN_BYTES);
    const escalate = this.criticalStreak >= 2 || (this.redSince !== null && now - this.redSince >= RED_ESCALATE_MS);
    if (escalate && big.length) {
      const victim = big.sort((a, b) => b.lastBytes - a.lastBytes)[0];
      this.d.signal(victim.pid, rows, "SIGKILL");
      this.say(victim, `Stopped by Papr to keep the computer responsive: memory stayed critical (${this.reasonsNow.join("; ")}) and this command was the largest agent process (${fmtGb(victim.lastBytes)}). Run it as a cloud job, or one at a time with less memory.`);
      this.untrack(victim.pid);
      this.redSince = null;
      this.criticalStreak = 0;
      return;
    }
    const canPause = this.d.platform !== "win32";
    if ((this.stateNow === "red" || this.stateNow === "critical") && canPause) {
      const running = big.filter((t) => !t.paused && t.cost.cls !== "light").sort((a, b) => b.startedAt - a.startedAt);
      const v = running[0];
      if (v && running.length + big.filter((t) => t.paused).length > 1) {
        // Pause the newest heavy tree, never the only one (pausing the only one just delays the same outcome).
        this.d.signal(v.pid, rows, "SIGSTOP");
        v.paused = true;
        this.say(v, `Paused by Papr while memory was tight (${this.reasonsNow.join("; ")}). It resumes automatically when memory frees up.`);
      }
      return;
    }
    if (this.calmSince !== null && now - this.calmSince >= RESUME_AFTER_MS) {
      for (const t of this.tracked.values()) if (t.paused) {
        this.d.signal(t.pid, rows, "SIGCONT");
        t.paused = false;
        this.log(`resumed ${t.cost.signature} (pid ${t.pid})`);
      }
    }
  }

  private say(t: Tracked, text: string): void {
    this.notes.set(t.pid, text);
    // Bounded: a note nobody collects (the app restarted mid-command) must not grow forever.
    if (this.notes.size > 50) this.notes.delete(this.notes.keys().next().value as number);
    this.log(`${t.owner}: ${text}`);
  }

  private log(text: string): void {
    this.events.push({ at: this.d.now(), text });
    if (this.events.length > 50) this.events.shift();
    console.warn(`[ResourceGovernor] ${text}`);
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.d.enabled,
      state: this.stateNow,
      reasons: this.reasonsNow,
      totalGb: +(this.d.totalBytes / GB).toFixed(1),
      availableGb: this.snap ? +(this.snap.availableBytes / GB).toFixed(1) : null,
      compressorLimitShare: this.snap?.compressorLimitShare ?? null,
      reserveGb: +(reserveFor(this.d.totalBytes) / GB).toFixed(1),
      agentCap: this.agentCap(),
      agentCapByRam: agentCapFor(this.d.totalBytes),
      maxHeavy: this.maxHeavy(),
      leases: [...this.leases.values()].map((l) => ({ owner: l.owner, what: l.cost.signature, estimateGb: +(l.cost.estimateBytes / GB).toFixed(1), pid: l.pid })),
      tracked: [...this.tracked.values()].map((t) => ({ owner: t.owner, pid: t.pid, what: t.cost.signature, cls: t.cost.cls, gb: +(t.lastBytes / GB).toFixed(2), paused: t.paused })),
      events: this.events.slice(-10),
    };
  }
}

let shared: ResourceGovernor | null = null;

export function getResourceGovernor(): ResourceGovernor {
  if (!shared) {
    let learnedFile: string | null = null;
    try { learnedFile = path.join(getPaprDataDir(), "resource-governor-peaks.json"); } catch { learnedFile = null; }
    shared = new ResourceGovernor({ learnedFile });
  }
  return shared;
}

/** Tests only. */
export function __setResourceGovernorForTests(g: ResourceGovernor | null): void { shared = g; }
