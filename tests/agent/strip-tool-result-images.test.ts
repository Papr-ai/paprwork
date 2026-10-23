import { describe, expect, it } from "vitest";
import {
  IMAGE_OMITTED_PLACEHOLDER,
  stripInlineImagesFromText,
  stripInlineImagesFromValue,
} from "../../src/gateway/services/agent/stripToolResultImages.js";
import { truncateToolResultForModelContext } from "../../src/gateway/services/agent/toolResultTruncation.js";
import { formatHistoryMessagesForModel } from "../../src/gateway/services/agent/historyFormatter.js";
import { measureTools } from "../../src/gateway/services/agent/requestPerformanceDiagnostics.js";

// Same shape as a real webview_snapshot result on Tip Split (2026-10-13):
// ~93.6K base64 screenshot BEFORE the page text, so the 40K cap cut the text.
const SHOT = "data:image/png;base64," + "iVBORw0KGgo".padEnd(93_576, "A");
const snapshot = {
  success: true,
  data: {
    webviewId: "webview-1",
    url: "http://localhost:18789/apps/x/index.html",
    screenshot: SHOT,
    pageStats: { sections: 1, elements: 7 },
    content: "## (top of page) Each person pays $0.00 Bill Tip 15% 18% 20% 25% People 1",
    elements: '[0] input:text "0.00" [1] radio "15%" [5] button "Fewer people" [6] button "More people"',
  },
};

describe("stripToolResultImages", () => {
  it("before: the 40K cap keeps the base64 and drops the page text (the bug)", () => {
    const capped = truncateToolResultForModelContext(JSON.stringify(snapshot), "c1", "webview_snapshot");
    expect(capped).not.toContain("Fewer people");
  });

  it("after: page text survives, image is a short placeholder, result is tiny", () => {
    const text = stripInlineImagesFromText(JSON.stringify(snapshot));
    const capped = truncateToolResultForModelContext(text, "c1", "webview_snapshot");
    expect(capped).toContain("Fewer people");
    expect(capped).toContain(IMAGE_OMITTED_PLACEHOLDER);
    expect(capped).not.toContain("base64,iVBOR");
    expect(capped.length).toBeLessThan(1_000);
  });

  it("strips previewScreenshot (validate_app) and screenshots[] in structured values", () => {
    const out = stripInlineImagesFromValue({
      data: { valid: true, previewScreenshot: SHOT, screenshots: [SHOT, SHOT] },
    });
    expect(out.data.valid).toBe(true);
    expect(out.data.previewScreenshot).toBe(IMAGE_OMITTED_PLACEHOLDER);
    expect(out.data.screenshots).toEqual([IMAGE_OMITTED_PLACEHOLDER, IMAGE_OMITTED_PLACEHOLDER]);
  });

  it("does not mutate the stored result (chat card still gets the PNG)", () => {
    const stored = structuredClone(snapshot);
    stripInlineImagesFromValue(stored);
    expect(stored.data.screenshot).toBe(SHOT);
  });

  it("leaves tiny icon data URIs and image-free results untouched", () => {
    const icon = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    const value = { icon, n: 1 };
    expect(stripInlineImagesFromValue(value)).toBe(value);
    expect(stripInlineImagesFromText(JSON.stringify(value))).toBe(JSON.stringify(value));
  });

  it("history path: prior-turn tool results are stripped before formatting", () => {
    const messages = formatHistoryMessagesForModel([
      { role: "user", content: "check it" },
      {
        role: "assistant",
        content: "done",
        tool_calls: [{ id: "c1", name: "webview_snapshot", args: {}, result: snapshot }],
      },
    ] as any);
    const json = JSON.stringify(messages);
    expect(json).not.toContain("base64,iVBOR");
  });

  it("API-key path: measureTools adds toModelOutput that strips images", async () => {
    const tools = measureTools(
      { webview_snapshot: { execute: async () => snapshot } as any },
      { chatId: "t" } as any,
    );
    const tool = tools.webview_snapshot as any;
    const raw = await tool.execute({}, { toolCallId: "c1", messages: [] });
    expect(raw.data.screenshot).toBe(SHOT); // UI/SQLite copy untouched
    const modelOut = await tool.toModelOutput({ toolCallId: "c1", input: {}, output: raw });
    expect(modelOut.type).toBe("json");
    expect(JSON.stringify(modelOut.value)).not.toContain("base64,iVBOR");
    expect(JSON.stringify(modelOut.value)).toContain("Fewer people");
  });
});

describe("webview_snapshot see: true", () => {
  const seeing = { ...snapshot, data: { ...snapshot.data, seeScreenshot: true } };

  it("extractSeeImage only fires when the tool opted in", async () => {
    const { extractSeeImage } = await import("../../src/gateway/services/agent/stripToolResultImages.js");
    expect(extractSeeImage(snapshot)).toBeNull();
    const img = extractSeeImage(seeing)!;
    expect(img.mimeType).toBe("image/png");
    expect(img.data.startsWith("iVBORw0KGgo")).toBe(true);
  });

  it("AI SDK path: vision model gets text + a real media part, no base64 in the text", async () => {
    const tools = measureTools(
      { webview_snapshot: { execute: async () => seeing } as any },
      { chatId: "t", provider: "anthropic", model: "claude-sonnet-5-5" } as any,
    );
    const out = await (tools.webview_snapshot as any).toModelOutput({ toolCallId: "c", input: {}, output: seeing });
    expect(out.type).toBe("content");
    expect(out.value[0].text).toContain("Fewer people");
    expect(out.value[0].text).not.toContain("base64,iVBOR");
    expect(out.value[1]).toMatchObject({ type: "media", mediaType: "image/png" });
  });

  it("AI SDK path: non-vision model (Haiku) gets stripped JSON, no image", async () => {
    const tools = measureTools(
      { webview_snapshot: { execute: async () => seeing } as any },
      { chatId: "t", provider: "anthropic", model: "claude-haiku-4-5" } as any,
    );
    const out = await (tools.webview_snapshot as any).toModelOutput({ toolCallId: "c", input: {}, output: seeing });
    expect(out.type).toBe("json");
    expect(JSON.stringify(out.value)).not.toContain("base64,iVBOR");
  });
});
