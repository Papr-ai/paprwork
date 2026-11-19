/**
 * The on-device code index as one long-lived service for the agent's code search (bash.ts hybrid grep).
 *
 * Chain for a grep inside a Papr app/job:
 *   1. on device  - papr-embed-code-1-0.6b: ONNX int8 on CPU from the start, swapped for the Neural Engine (CoreML
 *                   helper) once that loads in the background
 *   2. cloud      - Papr Memory (the existing code_indexer search, plus code_search when this device is cloud-tier)
 *   3. grep       - always runs; the pointer block (codeSearchV2) is added when 1 or 2 found something
 *
 * Nothing here ever blocks or fails a grep: search has a hard time budget, indexing runs in the background a few
 * files per tick, and every error degrades to "no on-device hits".
 *
 * Also indexes the Papr Work folder's non-code context (documents/, workspace/, repos/<name>/): adopted at startup,
 * kept fresh by the existing watchers (cloud-sync workspace watcher for workspace/, a documents/repos watcher here).
 *
 * Cloud tier (cloud agent gateway, or a device that fails the on-device checks): no model is loaded. Files the cloud
 * lacks are chunked with the model's tokenizer (exact boundaries) and sent as text; memory embeds them with the same
 * model and does not store the text. Search is server-embedded. PAPR_CODE_EMBED_TIER=cloud forces it (tests).
 * Env: PAPR_CODE_EMBED=0 turns it off. PAPR_CODE_EMBED_LOCAL=0 never runs the model on this device (cloud tier, or off). PAPR_CODE_EMBED_CONTEXT=0 skips documents/workspace/repos. PAPR_CODE_EMBED_DOWNLOAD=0 never downloads the model.
 *      PAPR_CODE_EMBED_CLOUD_SYNC=0 never uploads vectors. PAPR_CODE_EMBED_COREML=0 stays on ONNX. PAPR_CODE_EMBED_DATA_DIR overrides <PAPR_HOME>/data. PAPR_CODE_EMBED_HELPER = path to the Swift helper.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CodeIndexer, QUARANTINE_AFTER, SKIP_DIRS } from "./codeIndexer.js";
import { contextEnabled, contextRootFor, contextRoots, contextSkip } from "./contextRoots.js";
import type { PostClient } from "./cloudSync.js";
import { availableMemBytes, readDeviceFacts, readPowerState, selfTestPasses, staticTier, throttleReason, type EmbedTier } from "./deviceHealth.js";
import { CODE_EMBED_DIM, CODE_EMBED_MODEL, downloadModel, downloadTokenizer, loadTokenCounter, modelDir, tokenizerInstalled, WorkerOnnxEmbedder, modelInstalled, type Embedder } from "./embedder.js";
import { CodeVectorStore } from "./vectorStore.js";
import { aneAvailable } from "./coremlEmbedder.js";

export interface RuntimeDeps {
  /** Directory holding models/ and code-embed/index.db (default <PAPR_HOME>/data). */
  dataDir: string;
  /** Papr Memory client for cloud sync/search, or null when signed out. */
  cloud: () => Promise<PostClient | null>;
  cloudAvailable: boolean;
  /** Base embedder (default ONNX int8 on CPU in a worker thread). Must be quick to load: indexing and search start on it. */
  loadEmbedder?: (root: string) => Promise<Embedder>;
  /** Faster backend loaded in the background and swapped in when ready (default CoreML on the Neural Engine on
   *  Apple Silicon; its first load compiles for ~1 min, longer under memory pressure). null = no upgrade. */
  loadUpgrade?: ((root: string, base: Embedder) => Promise<Embedder>) | null;
  download?: (root: string) => Promise<void>;
  installed?: (root: string) => boolean;
  /** Cloud tier: tokenizer for exact chunk boundaries (default: the model's tokenizer.json, downloaded alone). */
  loadTokenCounter?: (root: string) => Promise<(s: string) => number>;
  tierOverride?: EmbedTier;
  canRun?: () => boolean;
  /** Papr Work folder: documents/, workspace/ and repos/<name>/ under it are indexed too. Omit to skip them. */
  paprRoot?: string;
  /** "org:<id>|ns:<id>" this index belongs to. The store is pinned to it, and cloud calls are made only while
   *  activeScope() still returns it (a workspace switch mid-sync must not upload this org's vectors with the next
   *  org's key, or search the next org's cloud index). */
  scope?: string;
  activeScope?: () => string | null;
  /** First retry delay after a failed Neural Engine load (default UPGRADE_RETRY_MS; tests use a few ms). */
  upgradeRetryMs?: number;
  /** Load the Neural Engine (loadUpgrade) first and only start ONNX if it fails. Default: aneAvailable() (Apple Silicon
   *  with the helper and CoreML model on disk). false = ONNX first, Neural Engine swapped in when ready. */
  aneFirst?: boolean;
}

export interface DeviceHit {
  path: string;
  score: number;
  lineStart: number;
  lineEnd: number;
}

const REFRESH_EVERY_MS = 30_000;
const SYNC_EVERY_MS = 5 * 60_000;
const TICK_MS = 250;
/** The on-device embed process died on its own (native abort, OOM kill): wait before loading it again, doubling. */
export const CRASH_BACKOFF_MS = 30_000;
export const CRASH_BACKOFF_MAX_MS = 30 * 60_000;
/** This many crashes within CRASH_WINDOW_MS turns the local tier off for CRASH_DISABLE_MS (persisted across restarts,
 *  so a crash that also takes the app down cannot loop either). */
export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 60 * 60_000;
export const CRASH_DISABLE_MS = 24 * 60 * 60_000;
/** Neural Engine load failed or the helper died: try again after this, doubling up to the max. */
export const UPGRADE_RETRY_MS = 60_000;
export const UPGRADE_RETRY_MAX_MS = 30 * 60_000;

export class CodeEmbedRuntime {
  readonly store: CodeVectorStore;
  readonly indexer: CodeIndexer;
  tier: EmbedTier;
  tierReasons: string[];
  private emb: Embedder | null = null;
  /** The ONNX base process (also the upgrade's long-document fallback). */
  private base: Embedder | null = null;
  /** No embedder load before this time (backoff after a crash or failed load). */
  private retryAt = 0;
  private embLoading: Promise<Embedder | null> | null = null;
  private downloading: Promise<void> | null = null;
  private refreshedAt = new Map<string, number>();
  private roots = new Set<string>();
  private loop: NodeJS.Timeout | null = null;
  private syncedAt = 0;
  /** Why background indexing is paused right now (battery, heat, memory), null when it runs. Search is never paused. */
  private paused: string | null = null;
  private lastSwap: number | null = null;
  private closed = false;
  /** Something the cloud does not have yet: new local vectors, queued deletes, or a sync that failed. Starts true so
   *  every app start (restart, crash, update) reconciles once with the cloud. */
  private syncDirty = true;
  private upgradeTimer: NodeJS.Timeout | null = null;
  private upgradeFailures = 0;
  /** Why the Neural Engine is not in use yet (shown in /api/code-embed/status). */
  private upgradeNote: string | null = null;
  /** When the Neural Engine last failed to load or died (0 = never): ONNX is used until the backoff retry succeeds. */
  private aneFailedAt = 0;
  private counter: ((s: string) => number) | null = null;
  private counterLoading: Promise<((s: string) => number) | null> | null = null;
  status = "starting";

  constructor(private readonly d: RuntimeDeps) {
    const dir = path.join(d.dataDir, "code-embed");
    fs.mkdirSync(dir, { recursive: true });
    this.store = CodeVectorStore.open(path.join(dir, "index.db"), CODE_EMBED_MODEL, CODE_EMBED_DIM);
    if (d.scope) {
      try {
        this.store.bindScope(d.scope);
      } catch (e) {
        this.store.close();
        throw e;
      }
    }
    let freeDisk: number | null = null;
    try {
      const s = fs.statfsSync(d.dataDir);
      freeDisk = s.bavail * s.bsize;
    } catch {}
    const decision = staticTier(readDeviceFacts(freeDisk), { cloudAvailable: d.cloudAvailable });
    this.tier = d.tierOverride ?? decision.tier;
    this.tierReasons = decision.reasons;
    const fallback: EmbedTier = d.cloudAvailable ? "cloud" : "off";
    // A blob still marked in flight means the last run died while embedding it (an older build ran ONNX in the
    // gateway, so a native abort took everything down): count it against that blob and as a crash.
    // An isolated marker (child process) means the app itself stopped mid-embed: quit, restart, sleep kill, power
    // loss. The child's own crashes are counted live, so this one is not held against the blob or the device.
    const crashed = this.store.takeInflight();
    if (crashed && !crashed.isolated) {
      this.store.noteEmbedFailure(crashed.blobSha);
      this.noteCrash();
    }
    if (this.tier === "local" && process.env.PAPR_CODE_EMBED_LOCAL === "0") {
      this.tier = fallback;
      this.tierReasons = ["on-device embedding turned off (PAPR_CODE_EMBED_LOCAL=0)"];
    } else if (this.tier === "local" && this.localDisabledUntil() > Date.now()) {
      this.tier = fallback;
      this.tierReasons = [`on-device embedder crashed ${CRASH_LIMIT} times; off until ${new Date(this.localDisabledUntil()).toISOString()}`];
    }
    this.indexer = new CodeIndexer({
      store: this.store,
      tier: () => this.tier,
      embedder: () => this.embedder(),
      tokenCounter: () => this.tokenCounter(),
      cloud: () => this.cloudForScope(),
      canRun: d.canRun ?? (() => this.mayIndex()),
      skipFor: contextSkip,
    });
  }

  /** Background indexing may run now: not on low battery, Low Power Mode, a hot CPU or a machine that is paging. */
  private mayIndex(): boolean {
    const s = readPowerState();
    this.paused = throttleReason(s, availableMemBytes(), this.lastSwap);
    if (s.swapUsedBytes !== null) this.lastSwap = s.swapUsedBytes;
    return this.paused === null;
  }

  /** Cloud client only while the active workspace is still the one this index belongs to. */
  private async cloudForScope(): Promise<PostClient | null> {
    if (this.d.scope && this.d.activeScope && this.d.activeScope() !== this.d.scope) return null;
    const c = await this.d.cloud();
    if (this.d.scope && this.d.activeScope && this.d.activeScope() !== this.d.scope) return null;
    return c;
  }

  /** Cloud tier: the model's tokenizer only (no ONNX), so chunks match what a Mac cuts. null while it downloads. */
  tokenCounter(): Promise<((s: string) => number) | null> {
    if (this.counter) return Promise.resolve(this.counter);
    if (!this.counterLoading) {
      this.counterLoading = (async () => {
        try {
          if (!this.d.loadTokenCounter && !tokenizerInstalled(this.d.dataDir)) {
            this.status = "downloading tokenizer";
            await downloadTokenizer(this.d.dataDir);
          }
          this.counter = await (this.d.loadTokenCounter ?? loadTokenCounter)(this.d.dataDir);
          this.status = "ready (cloud tier)";
          return this.counter;
        } catch (e) {
          this.status = `tokenizer failed: ${(e as Error).message}`;
          return null;
        } finally {
          this.counterLoading = null;
        }
      })();
    }
    return this.counterLoading;
  }

  private crashTimes(): number[] {
    try {
      return (JSON.parse(this.store.getMeta("embed_crashes") ?? "[]") as number[]).filter((t) => Date.now() - t < CRASH_WINDOW_MS);
    } catch {
      return [];
    }
  }

  private localDisabledUntil(): number {
    return Number(this.store.getMeta("local_disabled_until") ?? 0) || 0;
  }

  /** Record an embed-process crash; after CRASH_LIMIT in the window, turn the local tier off (persisted). */
  private noteCrash(): void {
    const times = [...this.crashTimes(), Date.now()];
    this.store.setMeta("embed_crashes", JSON.stringify(times));
    this.retryAt = Date.now() + Math.min(CRASH_BACKOFF_MAX_MS, CRASH_BACKOFF_MS * 2 ** (times.length - 1));
    if (times.length >= CRASH_LIMIT) {
      const until = Date.now() + CRASH_DISABLE_MS;
      this.store.setMeta("local_disabled_until", String(until));
      if (this.tier === "local") {
        this.tier = this.d.cloudAvailable ? "cloud" : "off";
        this.tierReasons = [`on-device embedder crashed ${times.length} times in an hour; off until ${new Date(until).toISOString()}`];
      }
    }
  }

  /** The embed process died on its own: drop it, count the crash, and back off before loading it again. */
  private onEmbedderDied(e: Embedder, why: string): void {
    if (this.emb !== e && this.base !== e) return;
    const up = this.emb !== e ? this.emb : null;
    this.emb = null;
    this.base = null;
    void up?.close().catch(() => undefined);
    this.noteCrash();
    this.status = this.tier === "local" ? `embedder crashed (${why}); retrying after ${new Date(this.retryAt).toISOString()}` : `embedder crashed (${why}); ${this.tierReasons[0]}`;
    console.warn(`[codeEmbed] ${this.status}`);
  }

  /** The loaded embedder, starting download/load in the background. Resolves null while unavailable. */
  embedder(): Promise<Embedder | null> {
    if (this.emb) return Promise.resolve(this.emb);
    if (this.tier !== "local") return Promise.resolve(null);
    if (Date.now() < this.retryAt) return Promise.resolve(null);
    if (!(this.d.installed ?? modelInstalled)(this.d.dataDir)) {
      if (!this.downloading && process.env.PAPR_CODE_EMBED_DOWNLOAD !== "0") {
        this.status = "downloading model";
        this.downloading = (this.d.download ?? ((r) => downloadModel(r)))(this.d.dataDir)
          .then(() => { this.status = "model downloaded"; this.kick(true); })
          .catch((e) => { this.status = `download failed: ${(e as Error).message}`; })
          .finally(() => { this.downloading = null; });
      }
      return Promise.resolve(null);
    }
    if (!this.embLoading) {
      this.status = "loading model";
      this.embLoading = (async () => {
        // Neural Engine first on Apple Silicon: ~16 ms per short chunk at near-zero CPU, versus ONNX keeping ~4 cores
        // busy. ONNX only starts if the Neural Engine cannot load (or later, for a document longer than it takes).
        try {
          if (this.aneFirst && !this.aneFailedAt) {
            const ane = await this.loadAneFirst();
            if (ane) return ane;
          }
          const e = await (this.d.loadEmbedder ?? ((r) => WorkerOnnxEmbedder.start(r)))(this.d.dataDir);
          const ex = e as Embedder & { onExit?: (l: (i: { code: number | null; signal: string | null }) => void) => void };
          ex.onExit?.((i) => this.onEmbedderDied(e, String(i.signal ?? i.code)));
          // Speed self-test: catches emulation and throttled laptops the static rules miss. One untimed warm-up
          // (first run allocates and JITs), then up to 2 timed rounds: one busy moment must not disable it all session.
          await e.embedQuery("warm up");
          let ms = Infinity;
          for (let round = 0; round < 2 && !selfTestPasses(ms); round++) {
            const t = Date.now();
            for (let i = 0; i < 8; i++) await e.embedQuery(`self test ${i}: where is the retry logic`);
            ms = Date.now() - t;
          }
          if (!selfTestPasses(ms)) {
            this.tier = this.d.cloudAvailable ? "cloud" : "off";
            this.tierReasons = [`self-test too slow (${ms} ms for 8 queries, twice)`];
            await e.close();
            this.status = "self-test failed";
            return null;
          }
          if ((e as { dead?: boolean }).dead) return null; // died during the self-test (already counted)
          this.emb = e;
          this.base = e;
          this.status = `ready (${e.constructor.name})`;
          this.kick(true); // index now instead of waiting for the idle re-check
          // The Neural Engine just failed: try it again after the backoff, not straight away.
          if (this.aneFailedAt) this.scheduleUpgrade(e, this.upgradeNote ?? "Neural Engine unavailable");
          else this.startUpgrade(e);
          return e;
        } catch (err) {
          this.status = `load failed: ${(err as Error).message}`;
          // A process that died while loading or self-testing counts as a crash too, so it cannot be retried in a loop.
          if (/exited/.test((err as Error).message ?? "")) this.noteCrash();
          else this.retryAt = Date.now() + CRASH_BACKOFF_MS;
          return null;
        } finally {
          this.embLoading = null;
        }
      })();
    }
    return this.embLoading;
  }

  /** Swap in the faster backend when it loads. A failed load (helper not built yet, compile timed out under memory
   *  pressure) is retried with backoff instead of staying on ONNX for the whole session, and a helper that dies later
   *  hands back to the base embedder and is reloaded the same way. */
  private scheduleUpgrade(base: Embedder, why: string): void {
    if (this.closed || this.base !== base) return;
    if (this.upgradeTimer) clearTimeout(this.upgradeTimer);
    const wait = Math.min(UPGRADE_RETRY_MAX_MS, (this.d.upgradeRetryMs ?? UPGRADE_RETRY_MS) * 2 ** this.upgradeFailures++);
    this.upgradeNote = `${why}; retrying at ${new Date(Date.now() + wait).toISOString()}`;
    this.upgradeTimer = setTimeout(() => this.startUpgrade(base), wait);
    this.upgradeTimer.unref?.();
  }

  private get aneFirst(): boolean {
    return this.d.aneFirst ?? aneAvailable(this.d.dataDir).ok;
  }

  /** ONNX loaded on demand: the Neural Engine's fallback for a document longer than its longest shape. Most sessions
   *  never start it. */
  private lazyBase(): Embedder {
    const load = async (): Promise<Embedder> => {
      if (this.base) return this.base;
      const e = await (this.d.loadEmbedder ?? ((r) => WorkerOnnxEmbedder.start(r)))(this.d.dataDir);
      if (this.closed) { await e.close().catch(() => undefined); throw new Error("closed"); }
      // Its crash costs one long document, not the Neural Engine: drop it (restarts on the next long document) and
      // count it like any embed-process crash.
      (e as { onExit?: (l: () => void) => void }).onExit?.(() => { if (this.base === e) { this.base = null; this.noteCrash(); } });
      this.base = e;
      return e;
    };
    return {
      model: CODE_EMBED_MODEL, dim: CODE_EMBED_DIM,
      embedQuery: async (t) => (await load()).embedQuery(t),
      embedDocuments: async (ts) => (await load()).embedDocuments(ts),
      countTokens: () => { throw new Error("lazy fallback does not count tokens"); },
      close: async () => {}, // the runtime closes this.base itself
    };
  }

  /** Load the Neural Engine as the primary embedder. null (and ONNX takes over) if it fails or is too slow. */
  private async loadAneFirst(): Promise<Embedder | null> {
    const up = this.d.loadUpgrade === undefined ? defaultUpgrade() : this.d.loadUpgrade;
    if (!up) return null;
    this.status = "loading Neural Engine (first compile ~2 min, then under 1 s)";
    try {
      const u = await up(this.d.dataDir, this.lazyBase());
      await u.embedQuery("warm up");
      const t = Date.now();
      for (let i = 0; i < 8; i++) await u.embedQuery(`self test ${i}: where is the retry logic`);
      if (!selfTestPasses(Date.now() - t)) throw new Error(`self-test too slow (${Date.now() - t} ms for 8 queries)`);
      if (this.closed) { await u.close().catch(() => undefined); return null; }
      this.emb = u;
      this.upgradeFailures = 0;
      this.upgradeNote = null;
      this.status = `ready (${u.constructor.name})`;
      (u as { onExit?: (l: () => void) => void }).onExit?.(() => {
        if (this.emb !== u) return;
        // Helper died (memory pressure kill, crash): carry on with ONNX now, Neural Engine again after the backoff.
        this.emb = this.base;
        this.aneFailedAt = Date.now();
        this.upgradeNote = "Neural Engine helper exited";
        if (this.emb) { this.status = `ready (${this.emb.constructor.name})`; this.scheduleUpgrade(this.emb, "Neural Engine helper exited"); }
        else void this.embedder();
      });
      this.kick(true);
      return u;
    } catch (e) {
      this.aneFailedAt = Date.now();
      this.upgradeNote = `Neural Engine load failed: ${(e as Error)?.message ?? e}`;
      return null;
    }
  }

  private startUpgrade(base: Embedder): void {
    const up = this.d.loadUpgrade === undefined ? defaultUpgrade() : this.d.loadUpgrade;
    if (!up || this.closed) return;
    if (this.upgradeTimer) { clearTimeout(this.upgradeTimer); this.upgradeTimer = null; }
    const retry = (why: string) => this.scheduleUpgrade(base, why);
    up(this.d.dataDir, base)
      .then((u) => {
        if (this.closed || this.emb !== base) return void u.close();
        this.emb = u; // u keeps base as its long-document fallback; do not close base
        this.upgradeFailures = 0;
        this.upgradeNote = null;
        this.status = `ready (${u.constructor.name})`;
        (u as { onExit?: (l: () => void) => void }).onExit?.(() => {
          if (this.emb !== u) return;
          this.emb = this.base; // ONNX carries on; the Neural Engine comes back after the backoff
          if (this.emb) this.status = `ready (${this.emb.constructor.name})`;
          retry("Neural Engine helper exited");
        });
      })
      .catch((e) => retry(`Neural Engine load failed: ${(e as Error)?.message ?? e}`));
  }

  get backend(): string {
    return this.emb?.constructor.name ?? "none";
  }

  /** Rescan a root (cheap mtime/size check) at most every REFRESH_EVERY_MS, and keep the background loop going. */
  touch(root: string, force = false): void {
    this.roots.add(root);
    const at = this.refreshedAt.get(root) ?? 0;
    if (force || Date.now() - at > REFRESH_EVERY_MS) {
      this.indexer.refresh(root);
      this.refreshedAt.set(root, Date.now());
    }
    this.kick();
  }

  /** A file under a known root changed on disk (app watcher, agent write, summary/README regenerated): mark it
   *  pending now so it is re-embedded in the background before the next grep, not after the 30 s rescan. */
  noteChange(absPath: string): boolean {
    let root = [...this.roots].find((r) => absPath.startsWith(r + path.sep));
    if (!root && this.d.paprRoot && contextEnabled()) {
      // A new repo cloned into repos/, or documents/ created after startup: adopt it now.
      const ctx = contextRootFor(absPath, this.d.paprRoot);
      if (ctx && fs.existsSync(ctx)) {
        this.touch(ctx, true);
        return true;
      }
    }
    if (!root) return false;
    const rel = path.relative(root, absPath).split(path.sep);
    const extra = contextSkip(root);
    if (rel.some((seg) => SKIP_DIRS.has(seg) || seg.startsWith(".") || extra?.dirs.has(seg))) return false;
    if (extra?.file?.test(rel.join("/"))) return false;
    if (fs.existsSync(absPath)) this.indexer.noteWrite(root, absPath);
    else this.indexer.refresh(root);
    this.kick();
    return true;
  }

  /** Startup: fetch/load the model in the background and keep previously indexed roots fresh. Never throws. */
  warm(): void {
    if (this.tier === "off") return;
    for (const r of this.store.roots()) if (fs.existsSync(r)) this.roots.add(r);
    for (const r of this.contextRoots()) this.roots.add(r);
    if (this.tier === "cloud") {
      void this.tokenCounter().then((c) => { if (c) for (const r of this.roots) this.touch(r, true); });
      return;
    }
    void this.embedder().then((e) => { if (e) for (const r of this.roots) this.touch(r, true); });
  }

  /** documents/, workspace/, repos/<name>/ that exist now ([] when off or no Papr root). */
  contextRoots(): string[] {
    return this.d.paprRoot && contextEnabled() ? contextRoots(this.d.paprRoot) : [];
  }

  info() {
    // Device facts and crash history, so a report like "the gateway keeps crashing" comes with the machine it ran on.
    const f = readDeviceFacts(null);
    const GBf = (b: number) => Math.round((b / 1e9) * 10) / 10;
    return {
      scope: this.store.scope(), tier: this.tier, reasons: this.tierReasons, status: this.status, backend: this.backend, upgrade: this.upgradeNote,
      indexingPaused: this.paused,
      neuralEngine: { ...aneAvailable(this.d.dataDir), first: this.aneFirst, onnxStarted: !!this.base },
      modelInstalled: (this.d.installed ?? modelInstalled)(this.d.dataDir), roots: this.roots.size, ...this.store.stats(),
      device: { platform: f.platform, arch: f.arch, os: `${os.type()} ${os.release()}`, cpu: f.cpuModel, cores: f.physicalCores, ramGB: GBf(f.totalMemBytes), availableGB: GBf(f.freeMemBytes), translated: f.translated },
      crashes: { lastHour: this.crashTimes().length, localDisabledUntil: this.localDisabledUntil() || null, quarantined: this.store.quarantined(QUARANTINE_AFTER).size },
    };
  }

  /** Background: embed pending files a few at a time, then sync vectors to the cloud. One loop at a time. */
  private kick(now = false): void {
    if (this.loop && !now) return;
    if (this.loop) clearTimeout(this.loop);
    const tick = async () => {
      try {
        if (this.tier === "cloud") {
          // No model here: send the text of files the cloud lacks; the server embeds them (papr-embed-code-1-0.6b).
          if (process.env.PAPR_CODE_EMBED_CLOUD_SYNC === "0") { this.loop = null; return; }
          const r = await this.indexer.indexInCloud((root) => `paprwork:${path.basename(root)}`);
          const left = this.store.pendingBlobs().filter((b) => !this.store.isCloudIndexed(b)).length;
          this.loop = left > 0 && r.failed === 0 && r.files > 0 ? setTimeout(tick, TICK_MS) : left > 0 ? setTimeout(tick, 30_000) : null;
          this.loop?.unref?.();
          return;
        }
        const r = await this.indexer.embedPending(4);
        // Quarantined blobs are not pending on device: counting them would spin this loop forever.
        const pending = this.tier === "local" ? this.indexer.localPending().length : this.store.pendingBlobs().length;
        if ((this.tier as EmbedTier) === "cloud") {
          this.loop = setTimeout(tick, 0); // the local tier just turned off (crashes): carry on in the cloud
          return;
        }
        if (r.embedded > 0) this.syncDirty = true;
        if (r.embedded > 0 || (pending > 0 && r.skipped === null)) {
          this.loop = setTimeout(tick, TICK_MS);
          return;
        }
        const syncOn = process.env.PAPR_CODE_EMBED_CLOUD_SYNC !== "0";
        if (pending === 0 && syncOn && this.syncDirty && Date.now() - this.syncedAt > SYNC_EVERY_MS) {
          this.syncedAt = Date.now();
          const s = await this.indexer.syncCloud((root) => `paprwork:${path.basename(root)}`);
          // Offline, signed out, server error or cut short: keep it dirty so the next pass retries. Uploads are
          // idempotent (the cloud is asked what it lacks), and deletes stay queued in the store across restarts.
          this.syncDirty = s.failed !== 0 || this.store.pendingCloudDeletes(1).length > 0 || !(await this.cloudForScope());
        }
        if (this.closed) { this.loop = null; return; }
        if (pending > 0 && this.tier === "local") {
          // Paused for battery, heat or memory: look again in 30 s. Model still loading: 5 s.
          this.loop = setTimeout(tick, r.skipped === "device busy" ? 30_000 : 5_000);
          this.loop.unref?.();
        } else if (pending === 0 && syncOn && this.syncDirty) {
          // New vectors, a failed sync, or deletes still queued: come back when the sync window opens, instead of
          // waiting for the next file change or grep to restart the loop.
          this.loop = setTimeout(tick, Math.max(1_000, SYNC_EVERY_MS - (Date.now() - this.syncedAt)));
          this.loop.unref?.();
        } else {
          this.loop = null;
        }
      } catch {
        this.loop = null;
      }
    };
    this.loop = setTimeout(tick, 0);
    this.loop.unref?.();
  }

  /** On-device (or cloud-tier) semantic hits for a query in one root, within budgetMs. [] when not ready. */
  async search(root: string, query: string, opts: { limit?: number; budgetMs?: number } = {}): Promise<{ tier: EmbedTier; hits: DeviceHit[] }> {
    this.touch(root);
    if (this.tier === "local" && !this.emb) {
      void this.embedder();
      return { tier: "local", hits: [] };
    }
    if (this.tier === "off") return { tier: "off", hits: [] };
    const work = this.indexer.search(query, { root, limit: opts.limit ?? 10 });
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), opts.budgetMs ?? 2_000).unref?.());
    const res = await Promise.race([work.catch(() => null), timeout]);
    if (!res) return { tier: this.tier, hits: [] };
    return { tier: res.tier, hits: res.hits.map((h) => ({ path: h.path, score: h.score, lineStart: h.lineStart, lineEnd: h.lineEnd })) };
  }

  /** Shut down (app quit, workspace switch). An embed in progress is abandoned, not counted against its blob, and the
   *  in-flight marker is cleared so the next start does not treat the quit as a crash. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.indexer.stop();
    if (this.loop) clearTimeout(this.loop);
    if (this.upgradeTimer) clearTimeout(this.upgradeTimer);
    const emb = this.emb;
    const base = this.base;
    this.emb = null;
    this.base = null;
    await emb?.close().catch(() => undefined);
    if (base && base !== emb) await base.close().catch(() => undefined);
    try { this.store.setInflight(null); } catch {}
    this.store.close();
  }
}

/** A grep path inside another org/namespace's Papr folder (~/Papr/orgs/<org>/namespaces/<ns>/…) than the active one.
 *  Those never get on-device hits: the index belongs to the active workspace only. */
export function isForeignWorkspacePath(p: string, activePaprRoot: string): boolean {
  const n = p.replace(/\\/g, "/");
  const m = n.match(/\/orgs\/([^/\s"']+)\/namespaces\/([^/\s"']+)/);
  if (!m) return false;
  const a = activePaprRoot.replace(/\\/g, "/").match(/\/orgs\/([^/]+)\/namespaces\/([^/]+)/);
  return !a || a[1] !== m[1] || a[2] !== m[2];
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The app/job id in a grep path: the UUID right after an apps/ or jobs/ segment, else the last UUID in the path
 *  (a UUID earlier in the path, e.g. in a temp or org folder name, is not the project). */
export function projectIdFromPath(p: string): string | undefined {
  const n = p.replace(/\\/g, "/");
  const after = n.match(new RegExp(`/(?:apps|jobs)/(${UUID})(?:/|$|\\s|["'])`, "i"))?.[1];
  if (after) return after;
  const all = n.match(new RegExp(UUID, "gi"));
  return all?.[all.length - 1];
}

/**
 * On-device hits for a grep inside one Papr app/job, as root-relative paths. Never throws; [] when the path names no
 * project, the runtime is off, or the model is not ready yet (it starts downloading/loading in the background).
 */
export async function deviceHitsForGrep(grepPath: string, query: string, budgetMs = 2_000): Promise<{ tier: EmbedTier | "disabled"; backend: string; hits: DeviceHit[] }> {
  const none = { tier: "disabled" as const, backend: "none", hits: [] };
  try {
    const roots = await import("../../utils/paprRoot.js");
    if (isForeignWorkspacePath(grepPath, roots.getPaprRoot())) return none;
    const ctx = contextEnabled() ? contextRootFor(grepPath, roots.getPaprRoot()) : undefined;
    const projectId = ctx ? undefined : projectIdFromPath(grepPath);
    if (!ctx && !projectId) return none;
    const root = ctx && fs.existsSync(ctx) ? ctx : projectId ? [roots.getPaprAppsRoot(), roots.getPaprJobsRoot()].map((r) => path.join(r, projectId)).find((r) => fs.existsSync(r)) : undefined;
    if (!root) return none;
    const rt = await getCodeEmbedRuntime();
    if (!rt) return none;
    // 20: the formula ranks the first 10, Jev reranks up to 20 (codeJevRerank.ts).
    const r = await rt.search(root, query, { limit: 20, budgetMs });
    return { tier: r.tier, backend: rt.backend, hits: r.hits };
  } catch {
    return none;
  }
}

/** CoreML on the Neural Engine, Apple Silicon only; falls back to the ONNX base for documents over its longest length. */
function defaultUpgrade(): ((root: string, base: Embedder) => Promise<Embedder>) | null {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.env.PAPR_CODE_EMBED_COREML === "0") return null;
  return async (root, base) => {
    const { CoreMLEmbedder, COREML_MODEL, helperPath } = await import("./coremlEmbedder.js");
    const { Tokenizer }: any = await import("@huggingface/tokenizers");
    const dir = modelDir(root);
    const tok = new Tokenizer(
      JSON.parse(fs.readFileSync(path.join(dir, "tokenizer.json"), "utf8")),
      JSON.parse(fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf8")),
    );
    return CoreMLEmbedder.start({ helper: helperPath(), modelPath: path.join(dir, COREML_MODEL), tok, fallback: base, timeoutMs: 10 * 60_000 });
  };
}

let shared: Promise<CodeEmbedRuntime | null> | null = null;
/** Bumped on reset (workspace switch): a runtime still being created for the old workspace is discarded. */
let generation = 0;

/** "org:<id>|ns:<id>" of the active workspace, or null (signed out / legacy flat ~/Papr). */
export async function activeCodeScope(): Promise<string | null> {
  const { readActiveWorkspacePointer } = await import("../../utils/paprWorkspace.js");
  const p = readActiveWorkspacePointer();
  return p ? `org:${p.organizationId}|ns:${p.namespaceId}` : null;
}

/** Process-wide runtime, or null when disabled or the store cannot open. */
export function getCodeEmbedRuntime(): Promise<CodeEmbedRuntime | null> {
  if (process.env.PAPR_CODE_EMBED === "0") return Promise.resolve(null);
  if (!shared) {
    const gen = generation;
    shared = (async () => {
      try {
        const [{ getPaprDataDir, getPaprRoot }, { getApiKey }] = await Promise.all([
          import("../../utils/paprRoot.js"),
          import("../../../gateway/utils/keyResolver.js"),
        ]);
        const key = await getApiKey("PAPR_API_KEY").catch(() => null);
        const cloud = async (): Promise<PostClient | null> => {
          const k = await getApiKey("PAPR_API_KEY").catch(() => null);
          if (!k) return null;
          const { default: Papr } = await import("@papr/memory");
          // Same memory server as Jev and the rest of the gateway: PAPR_MEMORY_SERVER_URL (dev sandbox -> dev memory).
          // Without it the SDK falls back to PAPR_BASE_URL / memory.papr.ai, so a dev cloud agent indexed into prod.
          const baseURL = process.env.PAPR_MEMORY_SERVER_URL?.replace(/\/$/, "") || undefined;
          const c = new Papr({ xAPIKey: k, ...(baseURL ? { baseURL } : {}) });
          return { post: (p, o) => c.post(p, { body: o.body, timeout: o.timeout }) };
        };
        const scope = await activeCodeScope();
        const { readActiveWorkspacePointer } = await import("../../utils/paprWorkspace.js");
        const activeScopeSync = () => {
          const p = readActiveWorkspacePointer();
          return p ? `org:${p.organizationId}|ns:${p.namespaceId}` : null;
        };
        const { isCloudAgentGatewayMode } = await import("../../utils/paprRoot.js");
        // Cloud agent (laptop off): no model in the container. Index the clone by sending text to memory, which embeds
        // with the same model; search goes to memory too. PAPR_CODE_EMBED_TIER=cloud forces it on a desktop (tests).
        const forceCloud = isCloudAgentGatewayMode() || process.env.PAPR_CODE_EMBED_TIER === "cloud";
        const rt = new CodeEmbedRuntime({
          dataDir: process.env.PAPR_CODE_EMBED_DATA_DIR || getPaprDataDir(), cloud, cloudAvailable: !!key, paprRoot: getPaprRoot(),
          scope: scope ?? undefined, activeScope: activeScopeSync,
          ...(forceCloud && key ? { tierOverride: "cloud" as const } : {}),
        });
        if (gen !== generation || activeScopeSync() !== scope) {
          // Workspace switched while this was starting: never hand out the old workspace's index.
          await rt.close();
          return null;
        }
        console.log(`[codeEmbed] tier=${rt.tier} (${rt.tierReasons.join("; ")})`);
        return rt;
      } catch (e) {
        console.warn("[codeEmbed] disabled:", (e as Error)?.message ?? e);
        return null;
      }
    })();
  }
  return shared;
}

/** Gateway startup: download the model (first run, existing users included) and warm it, off the critical path.
 *  Skipped in tests and cloud-agent mode, when disabled, or when downloads are off and the model is missing. */
export function startCodeEmbedInBackground(delayMs = 20_000): void {
  if (process.env.PAPR_CODE_EMBED === "0" || process.env.VITEST) return;
  const t = setTimeout(() => {
    void getCodeEmbedRuntime()
      .then(async (rt) => {
        if (!rt) return;
        rt.warm();
        const { getPaprRoot } = await import("../../utils/paprRoot.js");
        await watchContextDirs(rt, getPaprRoot());
      })
      .catch(() => undefined);
  }, delayMs);
  t.unref?.();
}

let contextWatcher: { close(): Promise<void> | void } | null = null;

/** One recursive OS watch each on documents/ and repos/ (workspace/ already has the cloud-sync watcher, which calls
 *  noteCodeEmbedFileChange). Feeds edits into the index; skipped dirs and dotfiles are ignored before any stat. */
async function watchContextDirs(rt: CodeEmbedRuntime, paprRoot: string): Promise<void> {
  if (contextWatcher || !contextEnabled()) return;
  const dirs = ["documents", "repos"].map((d) => path.join(paprRoot, d)).filter((d) => fs.existsSync(d));
  if (!dirs.length) return;
  const { TreeWatcher } = await import("../../../gateway/services/TreeWatcher.js");
  const w = new TreeWatcher({
    roots: dirs,
    recursive: true,
    settleMs: 1000,
    ignore: (abs) => abs.split(path.sep).some((seg) => SKIP_DIRS.has(seg) || seg === "versions" || (seg.startsWith(".") && seg.length > 1)),
    onEvent: (e) => void rt.noteChange(e.path),
    onError: () => undefined,
  });
  contextWatcher = w.rootCount > 0 ? w : null;
}

/** File watcher hook: cheap no-op unless the runtime is already up and the file is under an indexed root. */
export function noteCodeEmbedFileChange(absPath: string): void {
  if (!shared) return;
  void shared.then((rt) => rt?.noteChange(absPath)).catch(() => undefined);
}

/** Close the runtime (shutdown, workspace switch: the next use opens the new workspace's index). Also used by tests. */
export async function resetCodeEmbedRuntime(): Promise<void> {
  generation++;
  const rt = await shared?.catch(() => null);
  shared = null;
  await contextWatcher?.close();
  contextWatcher = null;
  await rt?.close().catch(() => undefined);
}
