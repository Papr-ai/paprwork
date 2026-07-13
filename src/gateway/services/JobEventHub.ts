/**
 * In-process pub/sub for job lifecycle and progress events.
 * Gateway wires this to WebSocket broadcast; mini-apps consume via SSE.
 */

import type { JobEvent } from "../../core/types/jobEvents.js";

export type JobEventListener = (event: JobEvent) => void;

export class JobEventHub {
  private readonly listeners = new Set<JobEventListener>();

  subscribe(listener: JobEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: JobEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[JobEventHub] listener error:", err);
      }
    }
  }
}

let hubInstance: JobEventHub | null = null;

export function getJobEventHub(): JobEventHub {
  if (!hubInstance) {
    hubInstance = new JobEventHub();
  }
  return hubInstance;
}

/** Test-only reset */
export function resetJobEventHubForTests(): void {
  hubInstance = null;
}
