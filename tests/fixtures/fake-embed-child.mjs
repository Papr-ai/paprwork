// Speaks embedWorker.ts's IPC protocol without a model. A document containing "CRASH" aborts the process with
// SIGTRAP, the way onnxruntime does when BFCArena::Extend fails.
process.on("disconnect", () => process.exit(0));
process.send({ ready: true });
process.on("message", (r) => {
  if (r.op === "close") { process.send({ id: r.id, ok: true }); process.exit(0); }
  if ((r.texts ?? []).some((t) => t.includes("CRASH"))) process.kill(process.pid, "SIGTRAP");
  const v = () => { const a = new Float32Array(1024).fill(0); a[0] = 1; return a; };
  process.send({ id: r.id, ok: true, vecs: r.op === "query" ? [v()] : (r.texts ?? []).map(v) });
});
