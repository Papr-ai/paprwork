/**
 * Worker thread that owns the ONNX embedder. onnxruntime-node's session.run() is synchronous native work wrapped in
 * setImmediate, so on the gateway's main thread a 2k-token file would freeze every request for seconds. Here it only
 * blocks this thread.
 *
 * Protocol (parentPort): { id, op: "query"|"docs"|"count"|"close", text?, texts? } -> { id, ok, vecs?, n?, error? }
 * First message out: { ready: true } or { ready: false, error }.
 */
import { parentPort, workerData } from "node:worker_threads";
import { loadEmbedder, type Embedder } from "./embedder.js";

type Req = { id: number; op: "query" | "docs" | "count" | "close"; text?: string; texts?: string[] };

const port = parentPort!;
let emb: Embedder | null = null;

(async () => {
  try {
    emb = await loadEmbedder(workerData.root as string, { threads: workerData.threads as number | undefined });
    port.postMessage({ ready: true });
  } catch (e) {
    port.postMessage({ ready: false, error: (e as Error)?.message ?? String(e) });
    return;
  }
  port.on("message", async (r: Req) => {
    try {
      if (r.op === "close") {
        await emb?.close();
        port.postMessage({ id: r.id, ok: true });
        process.exit(0);
      }
      if (r.op === "count") return port.postMessage({ id: r.id, ok: true, n: emb!.countTokens(r.text ?? "") });
      const vecs = r.op === "query" ? [await emb!.embedQuery(r.text ?? "")] : await emb!.embedDocuments(r.texts ?? []);
      // Transfer the buffers instead of copying 4 KB per vector.
      port.postMessage({ id: r.id, ok: true, vecs }, vecs.map((v) => v.buffer as ArrayBuffer));
    } catch (e) {
      port.postMessage({ id: r.id, ok: false, error: (e as Error)?.message ?? String(e) });
    }
  });
})();
