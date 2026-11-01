import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../StorageManager.js", () => ({
  getStorageManager: () => ({ getChat: async (id: string) => ({ id, title: `Chat ${id}` }) }),
}));

describe("noticeSources", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "notice-src-"));
    process.env.PAPR_HOME = dir;
    vi.resetModules();
  });
  afterEach(async () => {
    const { resetNoticeServiceForWorkspaceSwitch } = await import("./NoticeService.js");
    resetNoticeServiceForWorkspaceSwitch();
    rmSync(dir, { recursive: true, force: true });
  });

  it("chat done raises a green notice named after the chat; job and delegation chats don't", async () => {
    const src = await import("./noticeSources.js");
    const { getNoticeService } = await import("./NoticeService.js");
    await src.noticeChatDone("abc");
    await src.noticeChatDone("job:1:2");
    await src.noticeChatDone("delegation:9");
    const open = getNoticeService().listOpen();
    expect(open.map((n) => [n.key, n.mark, n.owner.name])).toEqual([["chat.done:abc", "green", "Chat abc"]]);
  });

  it("job waiting for a key raises amber on its report chat, and clears when it runs", async () => {
    const src = await import("./noticeSources.js");
    const { getNoticeService } = await import("./NoticeService.js");
    const job = { id: "j1", name: "Daily digest", reportChatId: "c1", waitingPermissionKeys: ["SLACK_TOKEN"] };
    src.syncJobPermissionNotice({ ...job, status: "waiting_permission" });
    expect(getNoticeService().listOpen()[0]).toMatchObject({ mark: "amber", owner: { kind: "chat", id: "c1" } });
    src.syncJobPermissionNotice({ ...job, status: "running" });
    expect(getNoticeService().listOpen()).toHaveLength(0);
  });

  it("a key request clears when that key is added", async () => {
    const src = await import("./noticeSources.js");
    const { getNoticeService } = await import("./NoticeService.js");
    await src.noticeKeyRequested("c1", "GITHUB_TOKEN");
    await src.noticeKeyRequested(null, "IGNORED");
    expect(getNoticeService().listOpen()).toHaveLength(1);
    src.noticeKeyAdded("GITHUB_TOKEN");
    expect(getNoticeService().listOpen()).toHaveLength(0);
  });

  it("deleting a chat clears its notices", async () => {
    const src = await import("./noticeSources.js");
    const { getNoticeService } = await import("./NoticeService.js");
    await src.noticeChatDone("abc");
    await src.noticeKeyRequested("abc", "X");
    src.noticeChatDeleted("abc");
    expect(getNoticeService().listOpen()).toHaveLength(0);
  });
});
