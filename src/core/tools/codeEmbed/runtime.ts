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
 * Env: PAPR_CODE_EMBED=0 turns it off. PAPR_CODE_EMBED_CONTEXT=0 skips documents/workspace/repos. PAPR_CODE_EMBED_DOWNLOAD=0 never downloads the model.
 *      PAPR_CODE_EMBED_CLOUD_SYNC=0 never uploads vectors. PAPR_CODE_EMBED_COREML=0 stays on ONNX. PAPR_CODE_EMBED_DATA_DIR overrides <PAPR_HOME>/data. PAPR_CODE_EMBED_HELPER = path to the Swift helper.
 */
import * as fs from "fs";
import * as path from "path";
import { CodeIndexer, SKIP_DIRS } from "./codeIndexer.js";
import { contextEnabled, contextRootFor, contextRoots, contextSkip } from "./contextRoots.js";
import type { PostClient } from "./cloudSync.js";
import { availableMemBytes, canRunNow, readDeviceFacts, selfTestPasses, staticTier, type EmbedTier } from "./deviceHealth.js";
import { CODE_EMBED_DIM, CODE_EMBED_MODEL, downloadModel, modelDir, WorkerOnnxEmbedder, modelInstalled, type Embedder } from "./embedder.js";
import { CodeVectorStore } from "./vectorStore.js";

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
  tierOverride?: EmbedTier;
  canRun?: () => boolean;
  /** Papr Work folder: documents/, workspace/ and repos/<name>/ under it are indexed too. Omit to skip them. */
  paprRoot?: string;
  /** "org:<id>|ns:<id>" this index belongs to. The store is pinned to it, and cloud calls are made only while
   *  activeScope() still returns it (a workspace switch mid-sync must not upload this org's vectors with the next
   *  org's key, or search the next org's cloud index). */
  scope?: string;
  activeScope?: () => string | null;
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

export class CodeEmbedRuntime {
  readonly store: CodeVectorStore;
  readonly indexer: CodeIndexer;
  tier: EmbedTier;
  tierReasons: string[];
  private emb: Embedder | null = null;
  private embLoading: Promise<Embedder | null> | null = null;
  private downloading: Promise<void> | null = null;
  private refreshedAt = new Map<string, number>();
  private roots = new Set<string>();
  private loop: NodeJS.Timeout | null = null;
  private syncedAt = 0;
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
    this.indexer = new CodeIndexer({
      store: this.store,
      tier: () => this.tier,
      embedder: () => this.embedder(),
      cloud: () => this.cloudForScope(),
      canRun: d.canRun ?? (() => canRunNow({ freeMemBytes: availableMemBytes() }, false).ok),
      skipFor: contextSkip,
    });
  }

  /** Cloud client only while the active workspace is still the one this index belongs to. */
  private async cloudForScope(): Promise<PostClient | null> {
    if (this.d.scope && this.d.activeScope && this.d.activeScope() !== this.d.scope) return null;
    const c = await this.d.cloud();
    if (this.d.scope && this.d.activeScope && this.d.activeScope() !== this.d.scope) return null;
    return c;
  }

  /** The loaded embedder, starting download/load in the background. Resolves null while unavailable. */
  embedder(): Promise<Embedder | null> {
    if (this.emb) return Promise.resolve(this.emb);
    if (this.tier !== "local") return Promise.resolve(null);
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
        try {
          const e = await (this.d.loadEmbedder ?? ((r) => WorkerOnnxEmbedder.start(r)))(this.d.dataDir);
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
          this.emb = e;
          this.status = `ready (${e.constructor.name})`;
          this.kick(true); // index now instead of waiting for the idle re-check
          this.startUpgrade(e);
          return e;
        } catch (err) {
          this.status = `load failed: ${(err as Error).message}`;
          return null;
        } finally {
          this.embLoading = null;
        }
      })();
    }
    return this.embLoading;
  }

  /** Swap in the faster backend when it loads. Vectors are interchangeable (CoreML fp16 vs ONNX int8: cosine 0.9998). */
  private startUpgrade(base: Embedder): void {
    const up = this.d.loadUpgrade === undefined ? defaultUpgrade() : this.d.loadUpgrade;
    if (!up) return;
    up(this.d.dataDir, base)
      .then((u) => {
        if (this.emb !== base) return void u.close();
        this.emb = u; // u keeps base as its long-document fallback; do not close base
        this.status = `ready (${u.constructor.name})`;
      })
      .catch(() => undefined);
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
    if (this.tier !== "local") return;
    for (const r of this.store.roots()) if (fs.existsSync(r)) this.roots.add(r);
    for (const r of this.contextRoots()) this.roots.add(r);
    void this.embedder().then((e) => { if (e) for (const r of this.roots) this.touch(r, true); });
  }

  /** documents/, workspace/, repos/<name>/ that exist now ([] when off or no Papr root). */
  contextRoots(): string[] {
    return this.d.paprRoot && contextEnabled() ? contextRoots(this.d.paprRoot) : [];
  }

  info(): { scope: string | null; tier: EmbedTier; reasons: string[]; status: string; backend: string; modelInstalled: boolean; roots: number } & ReturnType<CodeVectorStore["stats"]> {
    return { scope: this.store.scope(), tier: this.tier, reasons: this.tierReasons, status: this.status, backend: this.backend, modelInstalled: (this.d.installed ?? modelInstalled)(this.d.dataDir), roots: this.roots.size, ...this.store.stats() };
  }

  /** Background: embed pending files a few at a time, then sync vectors to the cloud. One loop at a time. */
  private kick(now = false): void {
    if (this.loop && !now) return;
    if (this.loop) clearTimeout(this.loop);
    const tick = async () => {
      try {
        const r = await this.indexer.embedPending(4);
        const pending = this.store.pendingBlobs().length;
        if (r.embedded > 0 || (pending > 0 && r.skipped === null)) {
          this.loop = setTimeout(tick, TICK_MS);
          return;
        }
        if (pending === 0 && process.env.PAPR_CODE_EMBED_CLOUD_SYNC !== "0" && Date.now() - this.syncedAt > SYNC_EVERY_MS) {
          this.syncedAt = Date.now();
          await this.indexer.syncCloud((root) => `paprwork:${path.basename(root)}`);
        }
        // Model still downloading/loading or device busy: check again later.
        this.loop = pending > 0 && this.tier === "local" ? setTimeout(tick, 5_000) : null;
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

  async close(): Promise<void> {
    if (this.loop) clearTimeout(this.loop);
    await this.emb?.close();
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
    const r = await rt.search(root, query, { limit: 10, budgetMs });
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
          const c = new Papr({ xAPIKey: k });
          return { post: (p, o) => c.post(p, { body: o.body, timeout: o.timeout }) };
        };
        const scope = await activeCodeScope();
        const { readActiveWorkspacePointer } = await import("../../utils/paprWorkspace.js");
        const activeScopeSync = () => {
          const p = readActiveWorkspacePointer();
          return p ? `org:${p.organizationId}|ns:${p.namespaceId}` : null;
        };
        const rt = new CodeEmbedRuntime({
          dataDir: process.env.PAPR_CODE_EMBED_DATA_DIR || getPaprDataDir(), cloud, cloudAvailable: !!key, paprRoot: getPaprRoot(),
          scope: scope ?? undefined, activeScope: activeScopeSync,
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
