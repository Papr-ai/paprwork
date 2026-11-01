import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

function fakeWs() {
  const sent: Array<{ id: string; success: boolean; data?: unknown; error?: string }> = [];
  const ws = { readyState: 1, OPEN: 1, send: (s: string) => sent.push(JSON.parse(s)) } as unknown as WebSocket;
  return { ws, sent };
}

describe("notifications:* websocket", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "notices-ws-"));
    process.env.PAPR_HOME = dir;
    vi.resetModules();
  });
  afterEach(async () => {
    (await import("../services/notifications/NoticeService.js")).resetNoticeServiceForWorkspaceSwitch();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists, marks seen via viewing (split view), and resolves", async () => {
    const { setupNotificationHandlers } = await import("./notifications.js");
    const { getNoticeService } = await import("../services/notifications/NoticeService.js");
    const svc = getNoticeService();
    const pen = { type: "agent" as const, id: "pen", name: "Pen" };
    svc.notify({ key: "chat.done:a", kind: "chat.done", level: "fyi", title: "t", source: pen, owner: { kind: "chat", id: "a", name: "A" } });
    svc.notify({ key: "chat.done:b", kind: "chat.done", level: "fyi", title: "t", source: pen, owner: { kind: "chat", id: "b", name: "B" } });
    svc.notify({ key: "key.request:c:X", kind: "key.request", type: "condition", level: "priority", title: "t", source: pen,
      owner: { kind: "chat", id: "c", name: "C" } });
    const { ws, sent } = fakeWs();

    await setupNotificationHandlers(ws, { id: "1", type: "notifications:list" });
    expect((sent[0].data as unknown[]).length).toBe(3);

    await setupNotificationHandlers(ws, { id: "2", type: "notifications:viewing",
      payload: { owners: [{ kind: "chat", id: "a" }, { kind: "chat", id: "b" }, { kind: "bogus", id: "z" }], foreground: true } });
    expect(svc.listOpen().map((n) => n.key)).toEqual(["key.request:c:X"]);

    await setupNotificationHandlers(ws, { id: "3", type: "notifications:resolve", payload: { key: "key.request:c:X" } });
    expect(svc.listOpen()).toHaveLength(0);

    await setupNotificationHandlers(ws, { id: "4", type: "notifications:seen", payload: {} });
    expect(sent.at(-1)).toMatchObject({ id: "4", success: false });
  });
});
