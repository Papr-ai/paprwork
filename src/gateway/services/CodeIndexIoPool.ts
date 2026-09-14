/**
 * Pool for off-main-thread code file reads (indexing hot path).
 */

import { Worker } from "node:worker_threads";
import type {
  CodeIndexIoReadResult,
  CodeIndexIoRequest,
  CodeIndexIoResponse,
} from "../workers/code-index-io-worker.js";

import { resolveCodeIndexIoPoolSize } from "./gatewayBackgroundConcurrency.js";

const READ_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (v: CodeIndexIoReadResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class IoWorker {
  private readonly worker: Worker;
  private pending = new Map<number, Pending>();
  private queue: Array<{
    req: CodeIndexIoRequest;
    resolve: (v: CodeIndexIoReadResult) => void;
    reject: (e: Error) => void;
  }> = [];
  private processing = false;
  private alive = true;

  constructor(workerUrl: URL) {
    this.worker = new Worker(workerUrl);
    this.worker.on("message", (res: CodeIndexIoResponse) => {
      const entry = this.pending.get(res.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(res.id);
      if (res.success && res.data) {
        entry.resolve(res.data);
      } else {
        entry.reject(new Error(res.error ?? "Code index I/O failed"));
      }
      this.processing = false;
      this.drain();
    });
    this.worker.on("error", (err) => {
      this.rejectAll(err instanceof Error ? err : new Error(String(err)));
    });
    this.worker.on("exit", (code) => {
      this.alive = false;
      if (code !== 0) {
        this.rejectAll(new Error(`Code index I/O worker exited (${code})`));
      }
    });
  }

  private rejectAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    for (const q of this.queue) {
      q.reject(err);
    }
    this.queue = [];
    this.processing = false;
  }

  execute(req: CodeIndexIoRequest): Promise<CodeIndexIoReadResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    if (this.processing || this.queue.length === 0 || !this.alive) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.processing = true;
    const timer = setTimeout(() => {
      this.pending.delete(next.req.id);
      next.reject(new Error(`Code index read timed out after ${READ_TIMEOUT_MS}ms`));
      this.processing = false;
      this.drain();
    }, READ_TIMEOUT_MS);
    this.pending.set(next.req.id, {
      resolve: next.resolve,
      reject: next.reject,
      timer,
    });
    this.worker.postMessage(next.req);
  }

  terminate(): void {
    this.rejectAll(new Error("Code index I/O worker terminated"));
    void this.worker.terminate();
  }
}

class CodeIndexIoPool {
  private workers: IoWorker[] = [];
  private nextId = 0;
  private roundRobin = 0;
  private readonly maxBytes: number;

  constructor(workerUrl: URL, poolSize: number, maxBytes: number) {
    this.maxBytes = maxBytes;
    for (let i = 0; i < poolSize; i++) {
      this.workers.push(new IoWorker(workerUrl));
    }
    console.log(
      `[CodeIndexIoPool] ${poolSize} worker thread(s), max read ${maxBytes} bytes`,
    );
  }

  readUtf8WithHash(filePath: string): Promise<CodeIndexIoReadResult> {
    const worker = this.pickWorker();
    const id = ++this.nextId;
    return worker.execute({
      id,
      type: "read-utf8-with-hash",
      filePath,
      maxBytes: this.maxBytes,
    });
  }

  private pickWorker(): IoWorker {
    const worker = this.workers[this.roundRobin % this.workers.length]!;
    this.roundRobin += 1;
    return worker;
  }

  terminate(): void {
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
  }
}

let poolInstance: CodeIndexIoPool | undefined;

function readMaxBytes(): number {
  const raw = process.env.CODE_INDEX_IO_MAX_BYTES?.trim();
  if (!raw) {
    return 2_000_000;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 2_000_000;
}

function readPoolSize(): number {
  return resolveCodeIndexIoPoolSize();
}

export function initializeCodeIndexIoPool(workerUrl: URL): CodeIndexIoPool {
  if (poolInstance) {
    return poolInstance;
  }
  poolInstance = new CodeIndexIoPool(workerUrl, readPoolSize(), readMaxBytes());
  return poolInstance;
}

export function getCodeIndexIoPool(): CodeIndexIoPool {
  if (!poolInstance) {
    throw new Error(
      "[CodeIndexIoPool] Not initialized — call initializeCodeIndexIoPool() first",
    );
  }
  return poolInstance;
}

export async function readCodeFileForIndex(
  filePath: string,
): Promise<CodeIndexIoReadResult> {
  return getCodeIndexIoPool().readUtf8WithHash(filePath);
}

export function terminateCodeIndexIoPool(): void {
  poolInstance?.terminate();
  poolInstance = undefined;
}
