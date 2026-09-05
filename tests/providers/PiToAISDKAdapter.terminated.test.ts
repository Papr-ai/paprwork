import { describe, expect, it } from "vitest";
import { adaptPiStreamToAISDK } from "../../src/gateway/services/providers/PiToAISDKAdapter.js";

async function* events(list: unknown[]) {
  for (const e of list) yield e as never;
}

async function collect(stream: AsyncIterable<{ type: string }>) {
  const out: { type: string; [k: string]: unknown }[] = [];
  for await (const c of stream) out.push(c as { type: string });
  return out;
}

describe("adaptPiStreamToAISDK — terminal event guard", () => {
  it("yields STREAM_ENDED_EARLY error when the stream ends without done/error", async () => {
    const chunks = await collect(
      adaptPiStreamToAISDK(
        events([
          { type: "text_delta", delta: "Build passes. Now meetingView:" },
          // socket closed gracefully — no `done`, no `error`
        ]),
      ),
    );
    expect(chunks.map((c) => c.type)).toEqual(["text-delta", "error"]);
    expect(String(chunks[1].error)).toContain("STREAM_ENDED_EARLY");
  });

  it("does not add an error after a normal done", async () => {
    const chunks = await collect(
      adaptPiStreamToAISDK(
        events([
          { type: "text_delta", delta: "ok" },
          { type: "done", reason: "stop" },
        ]),
      ),
    );
    expect(chunks.map((c) => c.type)).toEqual(["text-delta", "finish"]);
  });

  it("does not add a second error after a pi-ai error event", async () => {
    const chunks = await collect(
      adaptPiStreamToAISDK(
        events([
          { type: "error", reason: "error", error: { errorMessage: "boom" } },
        ]),
      ),
    );
    expect(chunks.map((c) => c.type)).toEqual(["error"]);
    expect(chunks[0].error).toBe("boom");
  });
});
