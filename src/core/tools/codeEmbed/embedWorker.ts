/**
 * Child process that owns the ONNX embedder (forked by WorkerOnnxEmbedder). onnxruntime-node's session.run() is
 * synchronous native work, and it aborts the whole process when an allocation fails. Here either one only affects this
 * process: the gateway sees the exit, rejects pending calls and falls back.
 *
 * Protocol (IPC, advanced serialization): { id, op: "query"|"docs"|"count"|"close", text?, texts? }
 *   -> { id, ok, vecs?, n?, error? }. First message out: { ready: true } or { ready: false, error }.
 */
import { EMBED_NICE, loadEmbedder, lowerPriority, type Embedder } from "./embedder.js";

type Req = { id: number; op: "query" | "docs" | "count" | "close"; text?: string; texts?: string[] };

const send = (m: unknown) => process.send?.(m);
let emb: Embedder | null = null;

// The gateway went away (crash, quit): never linger as an orphan holding the model in memory.
process.on("disconnect", () => process.exit(0));

(async () => {
  // Background work: below the app so indexing never competes with what the user is doing.
  lowerPriority(process.pid, EMBED_NICE);
  try {
    const threads = Number(process.env.PAPR_EMBED_THREADS) || undefined;
    emb = await loadEmbedder(process.env.PAPR_EMBED_ROOT as string, { threads });
    send({ ready: true });
  } catch (e) {
    send({ ready: false, error: (e as Error)?.message ?? String(e) });
    process.exit(1);
  }
  process.on("message", async (r: Req) => {
    try {
      if (r.op === "close") {
        await emb?.close();
        send({ id: r.id, ok: true });
        process.exit(0);
      }
      if (r.op === "count") {
        send({ id: r.id, ok: true, n: emb!.countTokens(r.text ?? "") });
        return;
      }
      // Test hook: simulate onnxruntime's native abort (SIGTRAP) on a marked document.
      if (process.env.PAPR_EMBED_TEST_CRASH_ON && (r.texts ?? []).some((t) => t.includes(process.env.PAPR_EMBED_TEST_CRASH_ON!)))
        process.kill(process.pid, "SIGTRAP");
      const vecs = r.op === "query" ? [await emb!.embedQuery(r.text ?? "")] : await emb!.embedDocuments(r.texts ?? []);
      send({ id: r.id, ok: true, vecs });
    } catch (e) {
      send({ id: r.id, ok: false, error: (e as Error)?.message ?? String(e) });
    }
  });
})();
