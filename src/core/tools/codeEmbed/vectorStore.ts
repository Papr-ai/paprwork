/**
 * Local code vectors, content-addressed. Two tables in one SQLite file (code-vectors.db, next to code-index.db):
 *
 *   chunks(model, blob_sha, chunk, line_start, line_end, vec BLOB, source)  - one row per embedded chunk; source is
 *          'local' (embedded here) or 'cloud' (downloaded / cloud-embedded). Keyed by content, never by path.
 *   files(root, path, blob_sha, mtime_ms, size)                             - the manifest: what each path holds NOW.
 *
 * A hit is a chunk; it resolves to every current path whose blob_sha matches, so renames cost nothing and a file whose
 * content changed simply has no vector until it is re-embedded ("pending"). Brute-force cosine over Float32 rows:
 * 20k chunks x 1024 dims is ~20M multiply-adds, a few ms in JS — no ANN index needed at Paprwork's scale.
 */
import Database from "better-sqlite3";
import * as crypto from "crypto";

export interface ChunkRow {
  blobSha: string;
  chunk: number;
  lineStart: number;
  lineEnd: number;
  vec: Float32Array;
  source: "local" | "cloud";
}

export interface CodeHit {
  path: string;
  root: string;
  blobSha: string;
  chunk: number;
  lineStart: number;
  lineEnd: number;
  score: number;
}

/** git's blob id: sha1("blob <len>\0" + bytes). Matches `git hash-object` and git ls-files -s. */
export function gitBlobSha(content: string | Buffer): string {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

type Db = {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): any[]; get(...a: unknown[]): any };
  transaction<T extends (...a: any[]) => any>(fn: T): T;
  close(): void;
};

export class CodeVectorStore {
  private cache: { model: string; rows: Array<ChunkRow & { key: string }> } | null = null;

  constructor(private readonly db: Db, readonly model: string, readonly dim: number) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chunks (
        model TEXT NOT NULL, blob_sha TEXT NOT NULL, chunk INTEGER NOT NULL,
        line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, vec BLOB NOT NULL,
        source TEXT NOT NULL DEFAULT 'local', updated_at INTEGER NOT NULL,
        PRIMARY KEY (model, blob_sha, chunk)
      );
      CREATE TABLE IF NOT EXISTS files (
        root TEXT NOT NULL, path TEXT NOT NULL, blob_sha TEXT NOT NULL, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
        PRIMARY KEY (root, path)
      );
      CREATE INDEX IF NOT EXISTS files_blob ON files(blob_sha);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_indexed (model TEXT NOT NULL, blob_sha TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (model, blob_sha));
      CREATE TABLE IF NOT EXISTS embed_failures (model TEXT NOT NULL, blob_sha TEXT NOT NULL, failures INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (model, blob_sha));
      CREATE TABLE IF NOT EXISTS cloud_deletes (model TEXT NOT NULL, blob_sha TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (model, blob_sha));
    `);
  }

  /**
   * Pin this index to one org + namespace. The first bind stamps it; a later bind for a different scope throws, so an
   * index can never serve (or upload from) another workspace, e.g. via a shared PAPR_CODE_EMBED_DATA_DIR.
   */
  bindScope(scope: string): void {
    const cur = this.db.prepare(`SELECT value FROM meta WHERE key='scope'`).get();
    if (!cur) {
      this.db.prepare(`INSERT INTO meta(key, value) VALUES ('scope', ?)`).run(scope);
      return;
    }
    if (cur.value !== scope) throw new Error(`code index belongs to ${cur.value}, not ${scope}`);
  }

  getMeta(key: string): string | null {
    return this.db.prepare(`SELECT value FROM meta WHERE key=?`).get(key)?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare(`DELETE FROM meta WHERE key=?`).run(key);
    else this.db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
  }

  /** The blob being embedded on device right now. Written before the run and cleared after, so a blob that takes the
   *  process down is still known on the next start (see takeInflight). */
  setInflight(blobSha: string | null, opts: { isolated?: boolean } = {}): void {
    this.setMeta(`inflight:${this.model}`, blobSha && opts.isolated ? `${blobSha}|child` : blobSha);
  }

  /** A blob left in flight when the last run stopped, cleared as it is read. isolated: it was being embedded in a
   *  child process. That child's own crash is caught live (onExit), so a leftover isolated marker means the whole app
   *  stopped (quit, restart, power loss, force kill) and says nothing about the blob. */
  takeInflight(): { blobSha: string; isolated: boolean } | null {
    const b = this.getMeta(`inflight:${this.model}`);
    if (!b) return null;
    this.setInflight(null);
    const [blobSha, tag] = b.split("|");
    return { blobSha: blobSha!, isolated: tag === "child" };
  }

  /** Blobs dropped here whose cloud vectors still have to be deleted. Kept until the cloud confirms, so a delete
   *  is not lost when the device is offline, signed out or restarts before the next sync. */
  queueCloudDeletes(blobShas: string[]): void {
    const ins = this.db.prepare(`INSERT OR IGNORE INTO cloud_deletes(model, blob_sha, at) VALUES (?,?,?)`);
    const now = Date.now();
    this.db.transaction(() => blobShas.forEach((b) => ins.run(this.model, b, now)))();
  }

  pendingCloudDeletes(limit = 5000): string[] {
    return this.db.prepare(`SELECT blob_sha FROM cloud_deletes WHERE model=? ORDER BY at LIMIT ?`).all(this.model, limit).map((r) => r.blob_sha);
  }

  clearCloudDeletes(blobShas: string[]): void {
    const del = this.db.prepare(`DELETE FROM cloud_deletes WHERE model=? AND blob_sha=?`);
    this.db.transaction(() => blobShas.forEach((b) => del.run(this.model, b)))();
  }

  /** Which of these blobs some current path holds (a file restored before its queued cloud delete ran). */
  referencedBlobs(blobShas: string[]): Set<string> {
    const q = this.db.prepare(`SELECT 1 FROM files WHERE blob_sha=? LIMIT 1`);
    return new Set(blobShas.filter((b) => q.get(b)));
  }

  /** One more failed on-device embed for this blob. Returns its failure count. */
  noteEmbedFailure(blobSha: string): number {
    this.db
      .prepare(`INSERT INTO embed_failures(model, blob_sha, failures, at) VALUES (?,?,1,?)
                ON CONFLICT(model, blob_sha) DO UPDATE SET failures=failures+1, at=excluded.at`)
      .run(this.model, blobSha, Date.now());
    return this.db.prepare(`SELECT failures FROM embed_failures WHERE model=? AND blob_sha=?`).get(this.model, blobSha)?.failures ?? 1;
  }

  /** Blobs that failed on device at least `after` times: never embedded locally again (the cloud tier may still take
   *  them). A new version of the file is a new blob, so an edit gets a fresh try. */
  quarantined(after: number): Set<string> {
    return new Set(this.db.prepare(`SELECT blob_sha FROM embed_failures WHERE model=? AND failures>=?`).all(this.model, after).map((r: any) => r.blob_sha));
  }

  scope(): string | null {
    return this.db.prepare(`SELECT value FROM meta WHERE key='scope'`).get()?.value ?? null;
  }

  static open(dbPath: string, model: string, dim: number): CodeVectorStore {
    return new CodeVectorStore(new Database(dbPath) as unknown as Db, model, dim);
  }

  putChunks(rows: ChunkRow[]): void {
    const ins = this.db.prepare(
      `INSERT INTO chunks(model, blob_sha, chunk, line_start, line_end, vec, source, updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(model, blob_sha, chunk) DO UPDATE SET line_start=excluded.line_start, line_end=excluded.line_end,
         vec=excluded.vec, source=excluded.source, updated_at=excluded.updated_at`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const r of rows) {
        if (r.vec.length !== this.dim) throw new Error(`${this.model} vectors have ${this.dim} dims, got ${r.vec.length}`);
        ins.run(this.model, r.blobSha, r.chunk, r.lineStart, r.lineEnd, Buffer.from(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength), r.source, now);
      }
    })();
    this.cache = null;
  }

  hasBlob(blobSha: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM chunks WHERE model=? AND blob_sha=? LIMIT 1`).get(this.model, blobSha);
  }

  /** Record what a path holds now. Returns true when the content changed (or the path is new). */
  setFile(root: string, path: string, blobSha: string, mtimeMs: number, size: number): boolean {
    const prev = this.db.prepare(`SELECT blob_sha FROM files WHERE root=? AND path=?`).get(root, path);
    this.db
      .prepare(
        `INSERT INTO files(root, path, blob_sha, mtime_ms, size) VALUES (?,?,?,?,?)
         ON CONFLICT(root, path) DO UPDATE SET blob_sha=excluded.blob_sha, mtime_ms=excluded.mtime_ms, size=excluded.size`,
      )
      .run(root, path, blobSha, Math.round(mtimeMs), size);
    return prev?.blob_sha !== blobSha;
  }

  removeFile(root: string, path: string): void {
    this.db.prepare(`DELETE FROM files WHERE root=? AND path=?`).run(root, path);
  }

  fileEntry(root: string, path: string): { blobSha: string; mtimeMs: number; size: number } | null {
    const r = this.db.prepare(`SELECT blob_sha, mtime_ms, size FROM files WHERE root=? AND path=?`).get(root, path);
    return r ? { blobSha: r.blob_sha, mtimeMs: r.mtime_ms, size: r.size } : null;
  }

  /** Roots indexed before (so a restart can keep them fresh without waiting for a grep). */
  roots(): string[] {
    return this.db.prepare(`SELECT DISTINCT root FROM files`).all().map((r) => r.root);
  }

  listFiles(root: string): Array<{ path: string; blobSha: string }> {
    return this.db.prepare(`SELECT path, blob_sha FROM files WHERE root=?`).all(root).map((r) => ({ path: r.path, blobSha: r.blob_sha }));
  }

  /** Blobs referenced by the manifest that have no vector for this model. */
  pendingBlobs(root?: string): string[] {
    const sql = `SELECT DISTINCT f.blob_sha AS b FROM files f LEFT JOIN chunks c ON c.model=? AND c.blob_sha=f.blob_sha
                 WHERE c.blob_sha IS NULL ${root ? "AND f.root=?" : ""}`;
    return this.db.prepare(sql).all(...(root ? [this.model, root] : [this.model])).map((r) => r.b);
  }

  /** Vectors no current path references (safe to drop locally; ask the cloud to drop them too). */
  orphanBlobs(): string[] {
    return this.db
      .prepare(`SELECT DISTINCT b FROM (SELECT blob_sha AS b FROM chunks WHERE model=? UNION SELECT blob_sha AS b FROM cloud_indexed WHERE model=?)
                WHERE b NOT IN (SELECT blob_sha FROM files)`)
      .all(this.model, this.model)
      .map((r) => r.b);
  }

  /** Cloud tier: blobs whose chunks were sent to the cloud to embed (no local vector). */
  markCloudIndexed(blobShas: string[]): void {
    const ins = this.db.prepare(`INSERT OR REPLACE INTO cloud_indexed(model, blob_sha, at) VALUES (?,?,?)`);
    const now = Date.now();
    this.db.transaction(() => blobShas.forEach((b) => ins.run(this.model, b, now)))();
  }

  isCloudIndexed(blobSha: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM cloud_indexed WHERE model=? AND blob_sha=?`).get(this.model, blobSha);
  }

  dropBlobs(blobShas: string[]): void {
    const del = this.db.prepare(`DELETE FROM chunks WHERE model=? AND blob_sha=?`);
    const delC = this.db.prepare(`DELETE FROM cloud_indexed WHERE model=? AND blob_sha=?`);
    this.db.transaction(() => blobShas.forEach((b) => { del.run(this.model, b); delC.run(this.model, b); }))();
    this.cache = null;
  }

  private rows() {
    if (this.cache?.model === this.model) return this.cache.rows;
    const rows = this.db
      .prepare(`SELECT blob_sha, chunk, line_start, line_end, vec, source FROM chunks WHERE model=?`)
      .all(this.model)
      .map((r) => {
        const b: Buffer = r.vec;
        const vec = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        return { key: `${r.blob_sha}:${r.chunk}`, blobSha: r.blob_sha, chunk: r.chunk, lineStart: r.line_start, lineEnd: r.line_end, vec, source: r.source };
      });
    this.cache = { model: this.model, rows };
    return rows;
  }

  /**
   * Top chunks for a query vector, resolved to current paths. Chunks whose blob no path holds any more are skipped
   * (stale), and each path appears once with its best chunk.
   */
  search(q: Float32Array, opts: { root?: string; limit?: number } = {}): CodeHit[] {
    if (q.length !== this.dim) throw new Error(`query has ${q.length} dims, expected ${this.dim}`);
    const scored: Array<{ r: ChunkRow; s: number }> = [];
    for (const r of this.rows()) {
      let s = 0;
      const v = r.vec;
      for (let i = 0; i < v.length; i++) s += v[i]! * q[i]!;
      scored.push({ r, s });
    }
    scored.sort((a, b) => b.s - a.s);
    const limit = opts.limit ?? 10;
    const byBlob = this.db.prepare(`SELECT root, path FROM files WHERE blob_sha=? ${opts.root ? "AND root=?" : ""}`);
    const seen = new Set<string>();
    const out: CodeHit[] = [];
    for (const { r, s } of scored) {
      for (const f of byBlob.all(...(opts.root ? [r.blobSha, opts.root] : [r.blobSha]))) {
        const k = `${f.root}\0${f.path}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ path: f.path, root: f.root, blobSha: r.blobSha, chunk: r.chunk, lineStart: r.lineStart, lineEnd: r.lineEnd, score: s });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  stats(): { chunks: number; files: number; pending: number } {
    const c = this.db.prepare(`SELECT COUNT(*) n FROM chunks WHERE model=?`).get(this.model).n;
    const f = this.db.prepare(`SELECT COUNT(*) n FROM files`).get().n;
    return { chunks: c, files: f, pending: this.pendingBlobs().length };
  }

  close(): void {
    this.db.close();
  }
}
