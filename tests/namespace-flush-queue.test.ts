import { describe, expect, it } from "vitest";
import {
  boostFlushQueueItemToManual,
  compareFlushQueueItems,
  moveFlushQueueItemToFront,
  sortFlushQueue,
  type NamespaceFlushQueueItem,
} from "../src/gateway/services/cloudSync/namespaceFlushQueue.js";

function item(
  appId: string,
  trigger: NamespaceFlushQueueItem["trigger"],
  enqueuedAt: number,
): NamespaceFlushQueueItem {
  return {
    appId,
    trigger,
    enqueuedAt,
    resolve: () => undefined,
    reject: () => undefined,
  };
}

describe("namespaceFlushQueue", () => {
  it("orders manual flushes before auto flushes", () => {
    const queue = [
      item("auto-a", "auto", 100),
      item("manual-b", "manual", 200),
      item("auto-c", "auto", 50),
    ];
    sortFlushQueue(queue);
    expect(queue.map((entry) => entry.appId)).toEqual([
      "manual-b",
      "auto-c",
      "auto-a",
    ]);
  });

  it("boosts queued auto flush to manual priority and front of line", () => {
    const queue = [
      item("manual-a", "manual", 100),
      item("auto-b", "auto", 200),
    ];
    expect(boostFlushQueueItemToManual(queue, "auto-b")).toBe(true);
    expect(queue.map((entry) => entry.appId)).toEqual(["auto-b", "manual-a"]);
    expect(queue[0]?.trigger).toBe("manual");
  });

  it("moves manual flush ahead of other manual flushes", () => {
    const queue = [
      item("manual-a", "manual", 100),
      item("manual-b", "manual", 200),
      item("manual-c", "manual", 300),
    ];
    expect(moveFlushQueueItemToFront(queue, "manual-c")).toBe(true);
    expect(queue.map((entry) => entry.appId)).toEqual([
      "manual-c",
      "manual-a",
      "manual-b",
    ]);
  });

  it("compareFlushQueueItems preserves FIFO within same priority", () => {
    expect(
      compareFlushQueueItems(
        item("a", "auto", 10),
        item("b", "auto", 20),
      ),
    ).toBeLessThan(0);
  });
});
