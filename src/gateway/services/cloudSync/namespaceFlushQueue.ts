/**
 * Serialized namespace app flush queue — manual uploads jump ahead of auto.
 */

import type { FlushNowOptions } from "./coordinatorTypes.js";

export type FlushTrigger = NonNullable<FlushNowOptions["trigger"]>;

export interface NamespaceFlushQueueItem {
  appId: string;
  trigger: FlushTrigger;
  enqueuedAt: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function flushPriority(trigger: FlushTrigger): number {
  if (trigger === "manual") {
    return 0;
  }
  if (trigger === "contribute") {
    return 1;
  }
  return 2;
}

export function compareFlushQueueItems(
  a: NamespaceFlushQueueItem,
  b: NamespaceFlushQueueItem,
): number {
  const priorityDelta = flushPriority(a.trigger) - flushPriority(b.trigger);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return a.enqueuedAt - b.enqueuedAt;
}

export function sortFlushQueue(items: NamespaceFlushQueueItem[]): void {
  items.sort(compareFlushQueueItems);
}

export function boostFlushQueueItemToManual(
  items: NamespaceFlushQueueItem[],
  appId: string,
): boolean {
  const item = items.find((entry) => entry.appId === appId);
  if (!item || item.trigger === "manual") {
    return false;
  }
  item.trigger = "manual";
  sortFlushQueue(items);
  return true;
}
