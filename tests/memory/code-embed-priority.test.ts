/**
 * Indexing is background work: the ONNX embed process runs at nice 10 with no thread spinning, and Neural Engine
 * indexing requests are tagged so the helper runs them at utility QoS while search queries stay user-initiated.
 */
import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { EMBED_NICE, EMBED_THREADS, WorkerOnnxEmbedder, lowerPriority, onnxSessionOptions } from "../../src/core/tools/codeEmbed/embedder.js";

const FAKE_CHILD = path.join(__dirname, "../fixtures/fake-embed-child.mjs");
const tok = { encode: (t: string) => ({ ids: Array.from({ length: Math.max(1, t.length >> 2) }, (_, i) => i) }) };
const kill: Array<() => void> = [];
afterEach(() => { kill.splice(0).forEach((k) => k()); });

describe("background priority", () => {
  test("the ONNX embed process starts at nice 10", async () => {
    const e = await WorkerOnnxEmbedder.start("/nonexistent", { entry: FAKE_CHILD, tok });
    kill.push(() => void e.close());
    expect(os.getPriority(e.pid!)).toBe(EMBED_NICE);
    expect((await e.embedQuery("where is retry")).length).toBe(1024);
  });

  test("lowerPriority only lowers, and never throws for a gone process", () => {
    const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
    kill.push(() => p.kill());
    lowerPriority(p.pid, 15);
    expect(os.getPriority(p.pid!)).toBe(15);
    lowerPriority(p.pid, 5); // does not raise it back
    expect(os.getPriority(p.pid!)).toBe(15);
    expect(() => lowerPriority(999_999_9)).not.toThrow();
    expect(() => lowerPriority(undefined)).not.toThrow();
  });

  test("ONNX session: no spinning threads, one inter-op thread, no growing arena", () => {
    const o: any = onnxSessionOptions(EMBED_THREADS);
    expect(o.extra.session.intra_op.allow_spinning).toBe("0");
    expect(o.extra.session.inter_op.allow_spinning).toBe("0");
    expect(o.interOpNumThreads).toBe(1);
    expect(o.intraOpNumThreads).toBe(EMBED_THREADS);
    expect(EMBED_THREADS).toBeGreaterThanOrEqual(1);
    expect(EMBED_THREADS).toBeLessThanOrEqual(4);
    expect(o.enableCpuMemArena).toBe(false);
  });
});

describe("Neural Engine QoS", () => {
  test("documents are sent as background work, queries are not", async () => {
    const { CoreMLEmbedder } = await import("../../src/core/tools/codeEmbed/coremlEmbedder.js");
    const sent: any[] = [];
    const listeners: Record<string, Array<(...a: any[]) => void>> = {};
    const stdout = new (await import("stream")).PassThrough();
    const proc: any = {
      stdout, stderr: new (await import("stream")).PassThrough(),
      stdin: { write: (l: string) => { const r = JSON.parse(l); sent.push(r); setImmediate(() => stdout.write(JSON.stringify({ id: r.id, embedding: Array(1024).fill(0.03) }) + "\n")); return true; }, end: () => {} },
      on: (ev: string, f: any) => { (listeners[ev] ??= []).push(f); return proc; },
      once: (ev: string, f: any) => proc.on(ev, f), kill: () => {},
    };
    const e: any = Reflect.construct(CoreMLEmbedder as any, [proc, tok, 1024, null]);
    await e.embedQuery("where is retry");
    await e.embedDocuments(["export const a = 1"]);
    expect(sent[0].bg).toBeUndefined();
    expect(sent[1].bg).toBe(true);
  });
});
