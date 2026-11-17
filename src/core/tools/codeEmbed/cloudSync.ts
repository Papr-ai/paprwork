/**
 * Cloud side of the code index, over the existing Papr Memory routes (Papr-ai/memory#479):
 *   POST /v1/memory/code/missing  -> which blobs the cloud lacks
 *   POST /v1/memory/batch         -> code_context items (vectors embedded here; text NOT uploaded unless opted in)
 *   POST /v1/memory/search        -> code_search (cloud tier: the server embeds the query)
 *   POST /v1/memory/code/delete   -> blobs no path holds any more
 *
 * Mirrors CodeContext in @papr/memory/lib (Papr-ai/papr-TypescriptSDK#50); inlined so this works on the SDK version
 * Paprwork ships today. Every call is bounded and failure-tolerant: sync retries on the next pass, search returns [].
 */
import type { CodeVectorStore } from "./vectorStore.js";

export interface PostClient {
  post<T = any>(path: string, opts: { body: unknown; timeout?: number }): PromiseLike<T>;
}

export interface CloudHit {
  blobSha: string;
  chunk: number;
  lineStart: number;
  lineEnd: number;
  score: number;
  pathHint?: string | null;
}

const BATCH = 256;
const SHAS = 5000;

export async function cloudMissing(client: PostClient, model: string, blobShas: string[], timeout = 15_000): Promise<string[]> {
  const out: string[] = [];
  const uniq = [...new Set(blobShas)];
  for (let i = 0; i < uniq.length; i += SHAS) {
    const r: any = await client.post("/v1/memory/code/missing", { body: { embed_model: model, blob_shas: uniq.slice(i, i + SHAS) }, timeout });
    out.push(...(r?.missing ?? []));
  }
  return out;
}

/**
 * Upload vectors the cloud lacks. Only local-source chunks are uploaded (cloud rows came from there). Content is a
 * placeholder unless storeContent is on: the server needs non-empty content, never the code itself.
 */
export async function pushVectors(
  client: PostClient,
  store: CodeVectorStore,
  opts: { repoId: (blobSha: string) => string | undefined; pathHint: (blobSha: string) => string | undefined; storeContent?: (blobSha: string) => string | undefined; timeout?: number },
): Promise<{ uploaded: number; failed: number }> {
  const db: any = (store as any).db;
  const local = db
    .prepare(`SELECT blob_sha, chunk, line_start, line_end, vec FROM chunks WHERE model=? AND source='local'`)
    .all(store.model) as Array<{ blob_sha: string; chunk: number; line_start: number; line_end: number; vec: Buffer }>;
  if (!local.length) return { uploaded: 0, failed: 0 };
  const missing = new Set(await cloudMissing(client, store.model, local.map((r) => r.blob_sha), opts.timeout));
  const todo = local.filter((r) => missing.has(r.blob_sha));
  let uploaded = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    const memories = part.map((r) => {
      const text = opts.storeContent?.(r.blob_sha);
      const vec = Array.from(new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)));
      return {
        content: text ?? `code:${r.blob_sha}:${r.chunk}`,
        code_context: {
          embed_model: store.model, blob_sha: r.blob_sha, chunk: r.chunk, line_start: r.line_start, line_end: r.line_end,
          repo_id: opts.repoId(r.blob_sha), path_hint: opts.pathHint(r.blob_sha), embedding: vec, store_content: text !== undefined,
        },
      };
    });
    try {
      const res: any = await client.post("/v1/memory/batch", { body: { memories }, timeout: opts.timeout ?? 60_000 });
      uploaded += res?.total_successful ?? 0;
      failed += res?.total_failed ?? 0;
    } catch {
      failed += part.length;
    }
  }
  return { uploaded, failed };
}

/** Cloud tier: the server embeds the query with the same model; restrict to blobs this device currently holds. */
export async function cloudSearch(
  client: PostClient,
  model: string,
  query: string,
  opts: { blobShas?: string[]; repoIds?: string[]; limit?: number; queryEmbedding?: Float32Array; timeout?: number } = {},
): Promise<CloudHit[]> {
  try {
    const res: any = await client.post("/v1/memory/search", {
      body: {
        query,
        code_search: {
          embed_model: model,
          query_embedding: opts.queryEmbedding ? Array.from(opts.queryEmbedding) : undefined,
          blob_shas: opts.blobShas?.slice(0, SHAS),
          repo_ids: opts.repoIds,
          limit: opts.limit ?? 10,
        },
      },
      timeout: opts.timeout ?? 4000,
    });
    return (res?.data?.memories ?? []).map((m: any) => {
      const md = m.customMetadata ?? {};
      return { blobSha: md.blob_sha, chunk: md.chunk ?? 0, lineStart: md.line_start ?? 1, lineEnd: md.line_end ?? 1, score: md.score ?? 0, pathHint: md.path_hint };
    });
  } catch {
    return [];
  }
}

export async function cloudDelete(client: PostClient, model: string, blobShas: string[], timeout = 15_000): Promise<void> {
  for (let i = 0; i < blobShas.length; i += SHAS) {
    await client.post("/v1/memory/code/delete", { body: { embed_model: model, blob_shas: blobShas.slice(i, i + SHAS) }, timeout });
  }
}
