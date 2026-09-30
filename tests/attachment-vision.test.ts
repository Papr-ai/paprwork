import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  injectAttachmentVisionIntoMessages,
  isVisionEligibleAttachment,
  modelSupportsVision,
} from "../src/gateway/services/agent/attachmentVision.js";
import type { AIModelMessage } from "../src/gateway/services/agent/historyFormatter.js";
import type { StoredMessageAttachment } from "../src/gateway/services/storage/IStorageProvider.js";

describe("attachmentVision", () => {
  it("detects vision-capable cloud models", () => {
    expect(modelSupportsVision("openai", "gpt-5.4")).toBe(true);
    expect(modelSupportsVision("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(modelSupportsVision("ollama", "qwen3.5:latest")).toBe(false);
    expect(modelSupportsVision("anthropic", "claude-haiku-4-5")).toBe(false);
  });

  it("accepts raster images and rejects svg", () => {
    expect(
      isVisionEligibleAttachment({
        id: "1",
        name: "shot.png",
        kind: "file",
        mimeType: "image/png",
        filePath: "/tmp/shot.png",
      }),
    ).toBe(true);
    expect(
      isVisionEligibleAttachment({
        id: "2",
        name: "icon.svg",
        kind: "file",
        mimeType: "image/svg+xml",
        filePath: "/tmp/icon.svg",
      }),
    ).toBe(false);
  });

  it("injects base64 image parts into user messages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "papr-vision-"));
    const pngPath = path.join(dir, "paste.png");
    await writeFile(pngPath, Buffer.from("fake-png-bytes"));

    const attachment: StoredMessageAttachment = {
      id: "att-1",
      name: "paste.png",
      kind: "file",
      mimeType: "image/png",
      filePath: pngPath,
    };

    const messages: AIModelMessage[] = [
      {
        role: "user",
        content: "What's in this screenshot?",
        attachments: [attachment],
      },
    ];

    const count = await injectAttachmentVisionIntoMessages(messages);
    expect(count).toBe(1);

    const userMsg = messages[0];
    expect(userMsg.role).toBe("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    if (!Array.isArray(userMsg.content)) return;

    expect(userMsg.content[0]).toEqual({
      type: "text",
      text: "What's in this screenshot?",
    });
    expect(userMsg.content[1]?.type).toBe("image");
    if (userMsg.content[1]?.type === "image") {
      expect(userMsg.content[1].mediaType).toBe("image/png");
      expect(userMsg.content[1].image).toBe(
        Buffer.from("fake-png-bytes").toString("base64"),
      );
    }
    expect(
      (userMsg as { attachments?: StoredMessageAttachment[] }).attachments,
    ).toBeUndefined();
  });
});
