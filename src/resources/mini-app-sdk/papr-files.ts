/**
 * App Files for mini-apps — four calls, no buckets or chunks in sight.
 *
 *   import { papr } from '/__papr__/papr-files.js';
 *
 *   const { id } = await papr.files.upload(file, { onProgress: p => … });
 *   const { url } = await papr.files.url(id);
 *   const files   = await papr.files.list();
 *   await papr.files.remove(id);
 *
 * Bytes go from the browser straight to object storage. They never pass
 * through the gateway, which is what makes a 10 GB recording possible at all:
 * a gateway relay would need memory or disk proportional to the file, and
 * would double the bandwidth bill for every upload.
 *
 * `upload()` accepts a Blob or File. A File is just a Blob with a name, and
 * neither holds bytes in memory — they are handles to data on disk, sliced
 * lazily as the upload progresses.
 */

/** GCS requires chunks in multiples of 256 KiB (except the last). */
const CHUNK_SIZE = 8 * 1024 * 1024;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;

export interface FileProgress {
  uploadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export interface UploadOptions {
  name?: string;
  mime?: string;
  /** 'user' keeps the file private to the uploader, even on a public app. */
  scope?: "app" | "user";
  onProgress?: (p: FileProgress) => void;
  signal?: AbortSignal;
}

export interface UploadResult {
  id: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  /** True when the bytes already existed and nothing was transferred. */
  deduped: boolean;
  verified: boolean;
}

export interface AppFile {
  id: string;
  file_name: string;
  size_bytes: number;
  mime: string | null;
  upload_state: "pending" | "uploading" | "verified" | "failed";
  scope: "app" | "user";
  created_at: number;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`App Files ${path} failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * SHA-256 of a Blob, hashed in chunks.
 *
 * WebCrypto has no streaming digest, so a full-file hash would need the whole
 * blob in memory — fatal at 10 GB. Instead the server dedupes on the object
 * key it derives itself; we send a cheap content fingerprint and let the
 * server verify the real MD5 after the bytes land.
 */
async function fingerprint(blob: Blob): Promise<string> {
  // Sample head, tail and size: enough to distinguish files cheaply without
  // ever reading the middle of a multi-GB video.
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const tail = new Uint8Array(
    await blob.slice(Math.max(0, blob.size - 65536)).arrayBuffer(),
  );
  const sizeTag = new TextEncoder().encode(String(blob.size));
  const joined = new Uint8Array(head.length + tail.length + sizeTag.length);
  joined.set(head, 0);
  joined.set(tail, head.length);
  joined.set(sizeTag, head.length + tail.length);
  const digest = await crypto.subtle.digest("SHA-256", joined);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseCommitted(range: string | null): number {
  if (!range) return 0;
  const m = /bytes=\d+-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, so retries do not synchronise. */
function backoff(attempt: number): number {
  return Math.round(Math.min(60_000, 1000 * 2 ** (attempt - 1)) * Math.random());
}

/** Ask GCS how much it already has — the only authority on real progress. */
async function probe(sessionUri: string, total: number): Promise<number> {
  const res = await fetch(sessionUri, {
    method: "PUT",
    headers: { "Content-Range": `bytes */${total}` },
  });
  if (res.status === 200 || res.status === 201) return total;
  return parseCommitted(res.headers.get("Range"));
}

/**
 * PUT one slice, retrying transient failures.
 *
 * The slice is a lazy view onto the file — creating it reads nothing, so peak
 * memory stays at one chunk regardless of whether the file is 8 MiB or 10 GB.
 */
async function putChunk(
  sessionUri: string,
  blob: Blob,
  offset: number,
  total: number,
  signal?: AbortSignal,
): Promise<{ done: boolean; committed: number }> {
  const end = Math.min(offset + CHUNK_SIZE, total);
  const slice = blob.slice(offset, end);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(sessionUri, {
        method: "PUT",
        body: slice,
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}` },
        signal,
      });
      if (res.status === 200 || res.status === 201) {
        return { done: true, committed: total };
      }
      if (res.status === 308) {
        const committed = parseCommitted(res.headers.get("Range"));
        return { done: false, committed: committed > offset ? committed : end };
      }
      if (!RETRYABLE.has(res.status) || attempt >= MAX_ATTEMPTS) {
        throw new Error(`Upload failed (${res.status}) at byte ${offset}`);
      }
    } catch (err) {
      // Aborting is a decision, not a failure — never retry through it.
      if (signal?.aborted) throw err;
      if (attempt >= MAX_ATTEMPTS) throw err;
    }
    await sleep(backoff(attempt));
  }
}

export const papr = {
  files: {
    /**
     * Store a Blob or File in App Files.
     *
     * Resumable and chunked: a dropped connection costs one chunk, not the
     * whole transfer.
     */
    async upload(blob: Blob, options: UploadOptions = {}): Promise<UploadResult> {
      const name =
        options.name ?? (blob as File).name ?? `upload-${Date.now()}`;
      const total = blob.size;

      const ticket = await api<{
        id: string;
        objectKey: string;
        uploadUrl: string | null;
        alreadyExists: boolean;
        sha256: string;
      }>("/api/files/ticket", {
        fileName: name,
        sizeBytes: total,
        mime: options.mime ?? blob.type ?? null,
        scope: options.scope ?? "app",
        fingerprint: await fingerprint(blob),
      });

      if (ticket.alreadyExists || !ticket.uploadUrl) {
        return {
          id: ticket.id,
          objectKey: ticket.objectKey,
          sha256: ticket.sha256,
          sizeBytes: total,
          deduped: true,
          verified: true,
        };
      }

      const startedAt = Date.now();
      let offset = await probe(ticket.uploadUrl, total);

      while (offset < total) {
        if (options.signal?.aborted) throw new Error("Upload aborted");
        const step = await putChunk(
          ticket.uploadUrl,
          blob,
          offset,
          total,
          options.signal,
        );
        offset = step.done ? total : step.committed;

        if (options.onProgress) {
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = elapsed > 0 ? offset / elapsed : 0;
          options.onProgress({
            uploadedBytes: offset,
            totalBytes: total,
            bytesPerSecond: rate,
            etaSeconds: rate > 0 ? Math.round((total - offset) / rate) : null,
          });
        }
      }

      // The server verifies stored size and MD5 before trusting the bytes —
      // the client's word is never enough to mark a file verified.
      return api<UploadResult>("/api/files/commit", {
        id: ticket.id,
        objectKey: ticket.objectKey,
        sizeBytes: total,
      });
    },

    /** Resolve a file id to something a browser can load. */
    async url(id: string): Promise<{ url: string; location: string }> {
      const res = await api<{ url?: string; location: { kind: string; path?: string } }>(
        "/api/files/url",
        { id },
      );
      return {
        url: res.url ?? res.location.path ?? "",
        location: res.location.kind,
      };
    },

    /** Every file this app can see. */
    async list(): Promise<AppFile[]> {
      const res = await api<{ files: AppFile[] }>("/api/files");
      return res.files;
    },

    /** Forget a file. Removes the row and the stored object. */
    async remove(id: string): Promise<boolean> {
      const res = await api<{ deleted: boolean }>("/api/files/delete", { id });
      return res.deleted;
    },
  },
};

export default papr;
