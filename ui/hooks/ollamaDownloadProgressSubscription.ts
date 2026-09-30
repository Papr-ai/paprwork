/**
 * Single IPC listener for ollama:download-progress; fan-out to React subscribers.
 * Avoids MaxListenersExceededWarning when many chat panes mount useOllama().
 */

export interface OllamaDownloadProgressPayload {
  modelName: string;
  status: "downloading" | "extracting" | "complete" | "error";
  percent: number;
  error?: string;
}

const subscribers = new Set<(data: OllamaDownloadProgressPayload) => void>();

const ipcHandler = (data: OllamaDownloadProgressPayload): void => {
  for (const fn of subscribers) {
    fn(data);
  }
};

let ipcRegistered = false;

function ensureIpcListener(): void {
  if (ipcRegistered || !window.electronAPI?.ollama) return;
  window.electronAPI.ollama.onDownloadProgress(ipcHandler);
  ipcRegistered = true;
}

function teardownIpcListenerIfIdle(): void {
  if (subscribers.size > 0 || !ipcRegistered || !window.electronAPI?.ollama) {
    return;
  }
  window.electronAPI.ollama.removeDownloadProgressListener(ipcHandler);
  ipcRegistered = false;
}

/** Subscribe to model download progress. Returns unsubscribe. */
export function subscribeOllamaDownloadProgress(
  listener: (data: OllamaDownloadProgressPayload) => void,
): () => void {
  subscribers.add(listener);
  ensureIpcListener();
  return () => {
    subscribers.delete(listener);
    teardownIpcListenerIfIdle();
  };
}
