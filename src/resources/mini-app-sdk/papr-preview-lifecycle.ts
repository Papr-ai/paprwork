/**
 * Parent ↔ mini-app preview tab lifecycle (hidden / visible / evicting).
 *
 * Paprwork posts these when the preview tab is backgrounded or LRU-evicted.
 * Import once in app bootstrap, or rely on side-effect init below.
 *
 *   import { onPreviewLifecycle } from '/__papr__/papr-preview-lifecycle.ts';
 *   onPreviewLifecycle((phase) => { if (phase === 'hidden') pausePollers(); });
 */

export type PreviewLifecyclePhase = "visible" | "hidden" | "evicting";

export interface PausablePreviewResource {
  pause: () => void;
  resume: () => void;
}

const pausables = new Set<PausablePreviewResource>();
const lifecycleListeners = new Set<(phase: PreviewLifecyclePhase) => void>();

let currentPhase: PreviewLifecyclePhase = "visible";
let bridgeInstalled = false;

function setPhase(phase: PreviewLifecyclePhase): void {
  if (currentPhase === phase) {
    return;
  }
  currentPhase = phase;
  for (const listener of lifecycleListeners) {
    listener(phase);
  }
  if (phase === "hidden" || phase === "evicting") {
    for (const resource of pausables) {
      resource.pause();
    }
    if (phase === "evicting") {
      window.dispatchEvent(new CustomEvent("papr:preview-evicting"));
    }
    return;
  }
  for (const resource of pausables) {
    resource.resume();
  }
}

export function getPreviewLifecyclePhase(): PreviewLifecyclePhase {
  return currentPhase;
}

export function onPreviewLifecycle(
  listener: (phase: PreviewLifecyclePhase) => void,
): () => void {
  lifecycleListeners.add(listener);
  listener(currentPhase);
  return () => {
    lifecycleListeners.delete(listener);
  };
}

/** Register SSE/pollers to pause while the preview tab is backgrounded. */
export function registerPausablePreviewResource(
  resource: PausablePreviewResource,
): () => void {
  pausables.add(resource);
  if (currentPhase === "hidden" || currentPhase === "evicting") {
    resource.pause();
  }
  return () => {
    pausables.delete(resource);
  };
}

export function installPreviewLifecycleBridge(): void {
  if (bridgeInstalled || typeof window === "undefined") {
    return;
  }
  bridgeInstalled = true;

  window.addEventListener("message", (event: MessageEvent) => {
    const type = event.data?.type;
    if (type === "papr:preview-hidden") {
      setPhase("hidden");
    } else if (type === "papr:preview-visible") {
      setPhase("visible");
    } else if (type === "papr:preview-evicting") {
      setPhase("evicting");
    }
  });
}

installPreviewLifecycleBridge();
