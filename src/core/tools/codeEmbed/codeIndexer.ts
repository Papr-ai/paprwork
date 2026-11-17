/**
 * On-device code index for one or more roots (Papr apps/jobs, user git repos). Grep answers now; this catches up.
 *
 *   refresh(root)       scan files (cheap: mtime+size check, hash only when changed) -> manifest; changed files become
 *                       pending. Renames/moves keep their vectors (same blob).
 *   embedPending()      background: embed pending blobs on device (local tier), a few files per tick, yielding.
 *   syncCloud()         upload vectors the cloud lacks; drop orphans locally and in the cloud.
 *   search(query)       local tier: embed query on device, cosine over local chunks.
 *                       cloud tier: server embeds the query, restricted to blobs this device holds.
 *                       off: [] (callers still have graph + exact words + grep).
 *
 * Search never blocks on indexing; a file whose content changed is not returned by its old vector.
 */
import * as fs from "fs";
import * as path from "path";
import { chunkFile } from "./chunker.js";
import { cloudDelete, cloudSearch, pushVectors, type PostClient } from "./cloudSync.js";
import type { EmbedTier } from "./deviceHealth.js";
import type { Embedder } from "./embedder.js";
import { gitBlobSha, type CodeHit, type CodeVectorStore } from "./vectorStore.js";

export const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".swift", ".kt", ".sql", ".sh", ".md", ".html", ".css", ".json", ".yaml", ".yml", ".toml"]);
export const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "venv", ".venv", "__pycache__", ".versions", "data", ".next", "coverage"]);
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_rsa.*|.*secret.*\.json|credentials.*)$/i;
export const MAX_FILE_BYTES = 400_000;
export const MAX_FILES_PER_ROOT = 5000;

export interface IndexerDeps {
  store: CodeVectorStore;
  tier: () => EmbedTier;
  embedder: () => Promise<Embedder | null>;
  cloud: () => Promise<PostClient | null>;
  /** Live gate before each background batch (memory pressure, battery saver). */
  canRun?: () => boolean;
  now?: () => number;
}

export function isIndexable(rel: string, size: number): boolean {
  if (size > MAX_FILE_BYTES || size === 0) return false;
  if (SECRET.test(rel)) return false;
  return CODE_EXT.has(path.extname(rel).toLowerCase());
}

export function listFiles(root: string): Array<{ rel: string; abs: string; mtimeMs: number; size: number }> {
  const out: Array<{ rel: string; abs: string; mtimeMs: number; size: number }> = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_FILES_PER_ROOT) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
      } else if (e.isFile()) {
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (isIndexable(rel, st.size)) out.push({ rel, abs, mtimeMs: st.mtimeMs, size: st.size });
        if (out.length >= MAX_FILES_PER_ROOT) return;
      }
    }
  };
  walk(root);
  return out;
}

export class CodeIndexer {
  private texts = new Map<string, { root: string; rel: string; abs: string }>();
  private busy = false;

  constructor(private readonly d: IndexerDeps) {}

  /** Bring the manifest for one root up to date. Returns {changed, removed} paths. */
  refresh(root: string): { changed: string[]; removed: string[] } {
    const { store } = this.d;
    const seen = new Set<string>();
    const changed: string[] = [];
    for (const f of listFiles(root)) {
      seen.add(f.rel);
      const prev = store.fileEntry(root, f.rel);
      if (prev && prev.size === f.size && Math.abs(prev.mtimeMs - Math.round(f.mtimeMs)) < 1) {
        this.texts.set(prev.blobSha, { root, rel: f.rel, abs: f.abs });
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(f.abs);
      } catch {
        continue;
      }
      const sha = gitBlobSha(buf);
      if (store.setFile(root, f.rel, sha, f.mtimeMs, f.size)) changed.push(f.rel);
      this.texts.set(sha, { root, rel: f.rel, abs: f.abs });
    }
    const removed = store.listFiles(root).filter((f) => !seen.has(f.path)).map((f) => f.path);
    removed.forEach((p) => store.removeFile(root, p));
    return { changed, removed };
  }

  /** Called from the write hook (agent edits) so a written file is pending immediately, without a rescan. */
  noteWrite(root: string, absPath: string): void {
    try {
      const st = fs.statSync(absPath);
      const rel = path.relative(root, absPath).split(path.sep).join("/");
      if (!isIndexable(rel, st.size)) return;
      const buf = fs.readFileSync(absPath);
      const sha = gitBlobSha(buf);
      this.d.store.setFile(root, rel, sha, st.mtimeMs, st.size);
      this.texts.set(sha, { root, rel, abs: absPath });
    } catch {}
  }

  /** Embed up to maxFiles pending blobs on device. Safe to call often; no-op unless tier is local. */
  async embedPending(maxFiles = 8): Promise<{ embedded: number; skipped: string | null }> {
    if (this.busy) return { embedded: 0, skipped: "busy" };
    if (this.d.tier() !== "local") return { embedded: 0, skipped: `tier ${this.d.tier()}` };
    if (this.d.canRun && !this.d.canRun()) return { embedded: 0, skipped: "device busy" };
    const emb = await this.d.embedder();
    if (!emb) return { embedded: 0, skipped: "no embedder" };
    this.busy = true;
    let embedded = 0;
    try {
      for (const sha of this.d.store.pendingBlobs().slice(0, maxFiles)) {
        const src = this.texts.get(sha);
        if (!src) continue;
        let text: string;
        try {
          text = fs.readFileSync(src.abs, "utf8");
        } catch {
          continue;
        }
        if (gitBlobSha(text) !== sha) continue; // changed again since the scan; next refresh picks it up
        const chunks = chunkFile(src.rel, text, (s) => emb.countTokens(s));
        if (!chunks.length) continue;
        const vecs = await emb.embedDocuments(chunks.map((c) => c.text));
        this.d.store.putChunks(chunks.map((c, i) => ({ blobSha: sha, chunk: c.chunk, lineStart: c.lineStart, lineEnd: c.lineEnd, vec: vecs[i]!, source: "local" as const })));
        embedded++;
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      this.busy = false;
    }
    return { embedded, skipped: null };
  }

  /** Upload what the cloud lacks, then drop orphans locally and remotely. Never throws. */
  async syncCloud(repoIdFor: (root: string) => string): Promise<{ uploaded: number; failed: number; dropped: number }> {
    const client = await this.d.cloud();
    if (!client) return { uploaded: 0, failed: 0, dropped: 0 };
    try {
      const where = (sha: string) => this.texts.get(sha);
      const r = await pushVectors(client, this.d.store, {
        repoId: (sha) => (where(sha) ? repoIdFor(where(sha)!.root) : undefined),
        pathHint: (sha) => where(sha)?.rel,
      });
      const orphans = this.d.store.orphanBlobs();
      if (orphans.length) {
        await cloudDelete(client, this.d.store.model, orphans).catch(() => undefined);
        this.d.store.dropBlobs(orphans);
      }
      return { ...r, dropped: orphans.length };
    } catch {
      return { uploaded: 0, failed: -1, dropped: 0 };
    }
  }

  async search(query: string, opts: { root?: string; limit?: number } = {}): Promise<{ tier: EmbedTier; hits: CodeHit[] }> {
    const tier = this.d.tier();
    const limit = opts.limit ?? 10;
    if (tier === "local") {
      const emb = await this.d.embedder();
      if (emb) return { tier, hits: this.d.store.search(await emb.embedQuery(query), { root: opts.root, limit }) };
    }
    if (tier === "local" || tier === "cloud") {
      const client = await this.d.cloud();
      if (!client) return { tier: "off", hits: [] };
      const files = opts.root ? this.d.store.listFiles(opts.root) : [];
      const blobs = files.map((f) => f.blobSha);
      const hits = await cloudSearch(client, this.d.store.model, query, { blobShas: blobs.length ? blobs : undefined, limit });
      const byBlob = new Map<string, string[]>();
      files.forEach((f) => byBlob.set(f.blobSha, [...(byBlob.get(f.blobSha) ?? []), f.path]));
      const out: CodeHit[] = [];
      for (const h of hits)
        for (const p of byBlob.get(h.blobSha) ?? []) out.push({ path: p, root: opts.root!, blobSha: h.blobSha, chunk: h.chunk, lineStart: h.lineStart, lineEnd: h.lineEnd, score: h.score });
      return { tier: "cloud", hits: out.slice(0, limit) };
    }
    return { tier: "off", hits: [] };
  }
}
