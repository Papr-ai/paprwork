/**
 * Preload for the hidden demo-render window (isolated world — the scene page never sees it).
 * Main sends captured BGRA frames; this world encodes them with WebCodecs and muxes an MP4.
 */
const { ipcRenderer } = require("electron");
const { Muxer, ArrayBufferTarget } = require("mp4-muxer");

const CODECS = [
  { codec: "avc1.4d0028", mux: "avc" }, // H.264 Main 4.0 — plays everywhere
  { codec: "avc1.42001f", mux: "avc" },
  { codec: "vp09.00.10.08", mux: "vp9" },
];

let job = null;

async function pickCodec(width, height, bitrate, framerate) {
  for (const c of CODECS) {
    const config = { codec: c.codec, width, height, bitrate, framerate, avc: c.mux === "avc" ? { format: "avc" } : undefined };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return { config, mux: c.mux };
    } catch {
      /* try next */
    }
  }
  throw new Error("No supported video codec (H.264/VP9) for WebCodecs");
}

async function start({ width, height, fps, bitrate }) {
  const { config, mux } = await pickCodec(width, height, bitrate, fps);
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: mux, width, height, frameRate: fps }, fastStart: "in-memory" });
  let error = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (error = e) });
  encoder.configure(config);
  job = { muxer, encoder, fps, width, height, codec: config.codec, getError: () => error };
  return { codec: config.codec };
}

function frame({ index, bitmap, width, height }) {
  if (!job) throw new Error("encoder not started");
  const data = new Uint8Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength);
  const vf = new VideoFrame(data, {
    format: "BGRA",
    codedWidth: width,
    codedHeight: height,
    timestamp: Math.round((index * 1e6) / job.fps),
    duration: Math.round(1e6 / job.fps),
  });
  // Keyframe every second keeps seeking/looping cheap.
  job.encoder.encode(vf, { keyFrame: index % job.fps === 0 });
  vf.close();
  if (job.getError()) throw job.getError();
  return { queued: job.encoder.encodeQueueSize };
}

async function finish() {
  if (!job) throw new Error("encoder not started");
  await job.encoder.flush();
  if (job.getError()) throw job.getError();
  job.muxer.finalize();
  const buf = job.muxer.target.buffer;
  const codec = job.codec;
  job.encoder.close();
  job = null;
  return { mp4: new Uint8Array(buf), codec };
}

const HANDLERS = { start, frame, finish };

ipcRenderer.on("demo-encode", async (_e, msg) => {
  try {
    const result = await HANDLERS[msg.type](msg.payload || {});
    ipcRenderer.send("demo-encode:reply", { id: msg.id, ok: true, result });
  } catch (err) {
    ipcRenderer.send("demo-encode:reply", { id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
});
