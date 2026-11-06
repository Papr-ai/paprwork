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

  it("job waiting for a key raises a blue dot on its report chat, and clears when it runs", async () => {
    const src = await import("./noticeSources.js");
    const { getNoticeService } = await import("./NoticeService.js");
    const job = { id: "j1", name: "Daily digest", reportChatId: "c1", waitingPermissionKeys: ["SLACK_TOKEN"] };
    src.syncJobPermissionNotice({ ...job, status: "waiting_permission" });
    expect(getNoticeService().listOpen()[0]).toMatchObject({ mark: "blue", owner: { kind: "chat", id: "c1" } });
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

describe("proposal notices", () => {
  it("keys by request so later statuses update one notice; reviews are Priority", async () => {
    const { noticeInputFor, noticeForEvent } = await import("../cloudSync/proposalEvents.js");
    const received = noticeForEvent({ id: "1", type: "proposal.received", role: "owner", requestId: "r1", sourceAppId: "app1", title: "Fix", createdAt: "" } as never)!;
    const input = noticeInputFor(received);
    expect(input).toMatchObject({ key: "proposal:r1", level: "priority", owner: { kind: "app", id: "app1" }, source: { type: "platform" } });
    const accepted = noticeForEvent({ id: "2", type: "proposal.accepted", role: "contributor", requestId: "r1", installedAppId: "a2", title: "Fix", createdAt: "" } as never)!;
    expect(noticeInputFor(accepted)).toMatchObject({ key: "proposal:r1", level: "fyi" });
  }, 20_000); // cold import of the gateway modules takes ~5s on a busy machine
});

describe("chatName", () => {
  it("never shows an id: untitled chats read Chat", async () => {
    const { chatName } = await import("./noticeSources.js");
    const id = "7a5a52dc-687e-48fc-ab2b-e7b7138dd641";
    expect(chatName(undefined, id)).toBe("Chat");
    expect(chatName("  ", id)).toBe("Chat");
    expect(chatName(id, id)).toBe("Chat");
    expect(chatName("da910b65-8ec5-4fd0-88a0-f38b27ba74c2", id)).toBe("Chat");
    expect(chatName("Launch plan", id)).toBe("Launch plan");
  });
});
