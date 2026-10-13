/**
 * Gateway → Electron: record an app demo scene to MP4 (src/electron/ipc/appDemoRender.cjs).
 * Rendering needs a Chromium window + WebCodecs, which only the Electron main process has.
 */
import type { RenderResult } from "../services/appDemoVideos.js";

export const REQUEST_APP_DEMO_RENDER = "REQUEST_APP_DEMO_RENDER";
export const APP_DEMO_RENDER_RESPONSE = "APP_DEMO_RENDER_RESPONSE";
const TIMEOUT_MS = 180_000;

interface Pending {
  resolve: (r: RenderResult) => void;
  reject: (e: Error) => void;
  timeout: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
let counter = 0;
let listening = false;

export function requestAppDemoRender(request: {
  scenePath: string;
  videoPath: string;
  posterPath: string;
}): Promise<RenderResult> {
  if (!process.send) {
    return Promise.reject(new Error("Preview videos are recorded by the Paprwork desktop app."));
  }
  if (!listening) {
    listening = true;
    process.on("message", (msg: unknown) => {
      const m = msg as { type?: string; requestId?: string; response?: { success: boolean; data?: unknown; error?: string } };
      if (m?.type !== APP_DEMO_RENDER_RESPONSE || !m.requestId) return;
      const p = pending.get(m.requestId);
      if (!p) return;
      clearTimeout(p.timeout);
      pending.delete(m.requestId);
      if (m.response?.success) p.resolve(m.response.data as RenderResult);
      else p.reject(new Error(m.response?.error || "Recording the preview failed."));
    });
  }
  const requestId = `demo-${Date.now()}-${++counter}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Recording the preview timed out."));
    }, TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timeout });
    process.send!({ type: REQUEST_APP_DEMO_RENDER, requestId, request });
  });
}
