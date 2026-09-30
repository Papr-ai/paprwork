/**
 * Open a Memory entity from outside the Memory page (e.g. ⌘K results).
 * The Memory tab may not be mounted yet, so the request is parked until WikiLibrary takes it.
 */
import type { WikiNode } from "../types/wiki";

export const MEMORY_OPEN_ENTITY_EVENT = "papr-memory-open-entity";

let pending: WikiNode | null = null;

export function requestMemoryEntity(node: WikiNode): void {
  pending = node;
  window.dispatchEvent(new CustomEvent(MEMORY_OPEN_ENTITY_EVENT));
}

export function takePendingMemoryEntity(): WikiNode | null {
  const node = pending;
  pending = null;
  return node;
}
