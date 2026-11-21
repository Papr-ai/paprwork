import { describe, expect, it } from "vitest";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { executeToolCall } from "../../src/gateway/services/providers/PiCodexStreamWithToolLoop.js";
import { toolCallIdFromExecuteContext } from "../../src/core/tools/context.js";

// The Pi tool loop (Claude/Codex via pi-ai) runs tools itself. Search tools tag
// their QueryLog searchId by tool call id, so the id must reach the tool here
// exactly as it does on the AI SDK loop.
describe("Pi tool loop passes the tool call id to tools", () => {
  it("a Mastra tool sees ctx.agent.toolCallId", async () => {
    let seen: string | undefined;
    const probe = createTool({
      id: "probe",
      description: "probe",
      inputSchema: z.object({ q: z.string() }),
      execute: async (_input, ctx) => {
        seen = toolCallIdFromExecuteContext(ctx);
        return { ok: true };
      },
    });
    const out = await executeToolCall(
      { toolCallId: "toolu_abc", toolName: "probe", args: { q: "x" } } as never,
      { probe } as never,
      [],
      { chatId: "chat-1" },
    );
    expect(out.toolCallId).toBe("toolu_abc");
    expect(seen).toBe("toolu_abc");
  });
});
