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
    `);
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
      .prepare(`SELECT DISTINCT c.blob_sha AS b FROM chunks c LEFT JOIN files f ON f.blob_sha=c.blob_sha WHERE c.model=? AND f.blob_sha IS NULL`)
      .all(this.model)
      .map((r) => r.b);
  }

  dropBlobs(blobShas: string[]): void {
    const del = this.db.prepare(`DELETE FROM chunks WHERE model=? AND blob_sha=?`);
    this.db.transaction(() => blobShas.forEach((b) => del.run(this.model, b)))();
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
