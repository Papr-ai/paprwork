/**
 * One "GitHub is paused until …" marker shared by every Paprwork process.
 *
 * GitHub's rate limit belongs to the whole Papr GitHub App installation, not
 * to a process. Before this, the gateway and the publish worker each found out
 * on their own and kept retrying into the same wall, burning more of the budget
 * and showing raw 403s. Now whoever hits the limit first writes the reset time
 * to ~/.paprwork-v2/github-rate-pause.json; everyone else checks it before
 * calling GitHub (directly, or through memory / the app-repo writer) and fails
 * fast with the same friendly message until it passes.
 *
 * Deliberately simple: a file read per check (cached 1s in-process), atomic
 * write via rename, and a hard cap so a bad clock can't park GitHub for hours.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_PAUSE_SEC = 60 * 60;
const READ_CACHE_MS = 1_000;

type PauseFile = { untilMs: number; reason: string; setBy: string; setAtMs: number };

let cached: { at: number; value: PauseFile | null } | null = null;

export function githubPauseFilePath(): string {
  const override = process.env.PAPR_GITHUB_PAUSE_FILE?.trim();
  return override || path.join(os.homedir(), ".paprwork-v2", "github-rate-pause.json");
}

function readPause(nowMs: number): PauseFile | null {
  if (cached && nowMs - cached.at < READ_CACHE_MS) return cached.value;
  let value: PauseFile | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(githubPauseFilePath(), "utf8")) as PauseFile;
    if (typeof parsed.untilMs === "number" && parsed.untilMs > nowMs) value = parsed;
  } catch {
    value = null;
  }
  cached = { at: nowMs, value };
  return value;
}

export class GitHubPausedError extends Error {
  readonly code = "github_rate_limited";
  constructor(
    readonly retryAfterSec: number,
    readonly reason: string,
  ) {
    super(
      `GitHub is rate-limiting Papr right now (shared hourly limit). ` +
        `Try again in about ${Math.max(1, Math.ceil(retryAfterSec / 60))} min — nothing is lost.`,
    );
    this.name = "GitHubPausedError";
  }
}

/** Seconds left on the shared pause, or null when GitHub calls are allowed. */
export function githubPauseRemainingSec(nowMs = Date.now()): number | null {
  const p = readPause(nowMs);
  return p ? Math.ceil((p.untilMs - nowMs) / 1000) : null;
}

/** Throw GitHubPausedError if another process (or this one) paused GitHub. */
export function assertGitHubNotPaused(nowMs = Date.now()): void {
  const p = readPause(nowMs);
  if (p) throw new GitHubPausedError(Math.ceil((p.untilMs - nowMs) / 1000), p.reason);
}

/** Record a rate limit for every process. Extends, never shortens, an existing pause. */
export function pauseGitHub(retryAfterSec: number, reason: string, nowMs = Date.now()): void {
  const sec = Math.min(MAX_PAUSE_SEC, Math.max(5, Math.ceil(retryAfterSec)));
  const untilMs = nowMs + sec * 1000;
  const existing = readPause(nowMs);
  if (existing && existing.untilMs >= untilMs) return;
  const body: PauseFile = { untilMs, reason: reason.slice(0, 200), setBy: `pid:${process.pid}`, setAtMs: nowMs };
  const file = githubPauseFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn("[GitHubRateGate] could not write pause file:", (err as Error).message);
  }
  cached = { at: nowMs, value: body };
  console.warn(`[GitHubRateGate] GitHub paused for ${sec}s (${reason})`);
}

/** Clear the pause (tests, or after a confirmed successful GitHub call post-reset). */
export function clearGitHubPause(): void {
  cached = null;
  try {
    fs.rmSync(githubPauseFilePath(), { force: true });
  } catch {
    // ignore
  }
}

/**
 * Inspect an HTTP response from GitHub — or from memory / the app-repo writer,
 * which relay GitHub's limit as 429 + Retry-After — and pause everyone if it
 * is a rate limit. Returns the wait in seconds, or null if it was not one.
 */
export function noteGitHubRateLimit(
  status: number,
  headers: { get(name: string): string | null },
  body: string,
  source: string,
  nowMs = Date.now(),
): number | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = headers.get("retry-after");
  const remaining = headers.get("x-ratelimit-remaining");
  const mentions = /rate.?limit/i.test(body);
  // A plain 429 from our own servers without a GitHub hint is some other limit.
  if (status === 429 && !retryAfter && !mentions) return null;
  if (status === 403 && !retryAfter && remaining !== "0" && !mentions) return null;
  let wait = 60;
  if (retryAfter && /^\d+$/.test(retryAfter)) wait = Number(retryAfter);
  else {
    const reset = headers.get("x-ratelimit-reset");
    if (reset && /^\d+$/.test(reset)) wait = Math.max(0, Number(reset) - Math.floor(nowMs / 1000));
  }
  pauseGitHub(wait, `${source} ${status}`, nowMs);
  return wait;
}

/** Test hook: forget the 1s read cache. */
export function resetGitHubRateGateCacheForTests(): void {
  cached = null;
}
