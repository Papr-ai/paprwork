import { describe, expect, it } from "vitest";

import {
  addStreamUsage,
  EMPTY_STREAM_USAGE,
  readAiSdkStepUsage,
  readAiSdkTotalUsage,
  readPiAiStreamUsage,
} from "../src/gateway/services/agent/streamUsageReport.js";

/**
 * Verbatim from a logged 4-step `claude-opus-5` turn (chat
 * 01eed089-5bc8-4a82-a762-6deae264daf2). `inputTokens` is the provider's total,
 * so it already contains the cached portion — hence read + write + 2 fresh.
 */
const LOGGED_STEPS = [
  { read: 0, write: 384_388, fresh: 2, out: 247 },
  { read: 384_388, write: 463, fresh: 2, out: 113 },
  { read: 384_851, write: 1_019, fresh: 2, out: 150 },
  { read: 386_581, write: 1_497, fresh: 2, out: 340 },
];

function aiSdkStepChunk(step: (typeof LOGGED_STEPS)[number]) {
  const inputTokens = step.read + step.write + step.fresh;
  return {
    usage: {
      inputTokens,
      outputTokens: step.out,
      totalTokens: inputTokens + step.out,
      inputTokenDetails: {
        cacheReadTokens: step.read,
        cacheWriteTokens: step.write,
      },
      cachedInputTokens: step.read,
    },
    providerMetadata: {
      anthropic: {
        cacheReadInputTokens: step.read,
        cacheCreationInputTokens: step.write,
      },
    },
  };
}

describe("stream usage reporting", () => {
  it("sums every step of a multi-step stream, not just the last", () => {
    let running = EMPTY_STREAM_USAGE;
    for (const step of LOGGED_STEPS) {
      const parsed = readAiSdkStepUsage(aiSdkStepChunk(step));
      expect(parsed).not.toBeNull();
      running = addStreamUsage(running, parsed!);
    }

    // 0 + 384,388 + 384,851 + 386,581
    expect(running.cacheReadTokens).toBe(1_155_820);
    // 384,388 + 463 + 1,019 + 1,497
    expect(running.cacheWriteTokens).toBe(387_367);
    expect(running.completionTokens).toBe(850);
    expect(running.promptTokens).toBe(1_543_195);
  });

  it("does not report the final step as the stream total", () => {
    // The defect: the stored row held exactly step 4 — read 386,581, write
    // 1,497, output 340 — for a turn that made four billed requests.
    let running = EMPTY_STREAM_USAGE;
    for (const step of LOGGED_STEPS) {
      running = addStreamUsage(running, readAiSdkStepUsage(aiSdkStepChunk(step))!);
    }
    const lastStep = readAiSdkStepUsage(
      aiSdkStepChunk(LOGGED_STEPS[LOGGED_STEPS.length - 1]),
    )!;

    expect(running.cacheReadTokens).toBeGreaterThan(lastStep.cacheReadTokens);
    expect(running.cacheWriteTokens).toBeGreaterThan(lastStep.cacheWriteTokens);
    expect(running.completionTokens).toBeGreaterThan(lastStep.completionTokens);
  });

  it("proves the step reports are incremental: cache write decreases", () => {
    // This is what disproved the "each report is already a running total"
    // premise. A cumulative counter cannot decrease, and this one falls from
    // 384,388 to 463 between step 1 and step 2.
    const writes = LOGGED_STEPS.map(
      (step) => readAiSdkStepUsage(aiSdkStepChunk(step))!.cacheWriteTokens,
    );
    expect(writes[1]).toBeLessThan(writes[0]);
  });

  it("leaves a single-step stream unchanged", () => {
    const single = readAiSdkStepUsage(aiSdkStepChunk(LOGGED_STEPS[0]))!;
    expect(addStreamUsage(EMPTY_STREAM_USAGE, single)).toEqual(single);
  });

  describe("readAiSdkTotalUsage", () => {
    it("reads the SDK's own cross-step sum", () => {
      const total = readAiSdkTotalUsage({
        totalUsage: {
          inputTokens: 1_543_195,
          outputTokens: 850,
          totalTokens: 1_544_045,
          inputTokenDetails: {
            cacheReadTokens: 1_155_820,
            cacheWriteTokens: 387_367,
          },
        },
      });

      expect(total).toEqual({
        promptTokens: 1_543_195,
        completionTokens: 850,
        totalTokens: 1_544_045,
        cacheReadTokens: 1_155_820,
        cacheWriteTokens: 387_367,
      });
    });

    it("ignores providerMetadata, which carries only the last step", () => {
      // The SDK sums `usage` across steps but keeps the final step's provider
      // metadata. Falling back to it would report one request's cache figures
      // as the whole stream's — the defect this module closes.
      const total = readAiSdkTotalUsage({
        totalUsage: {
          inputTokens: 1_543_195,
          outputTokens: 850,
          totalTokens: 1_544_045,
        },
        providerMetadata: {
          anthropic: {
            cacheReadInputTokens: 386_581,
            cacheCreationInputTokens: 1_497,
          },
        },
      } as Parameters<typeof readAiSdkTotalUsage>[0]);

      expect(total?.cacheReadTokens).toBe(0);
      expect(total?.cacheWriteTokens).toBe(0);
    });

    it("falls back to cachedInputTokens, which the SDK does sum", () => {
      const total = readAiSdkTotalUsage({
        totalUsage: {
          inputTokens: 900,
          outputTokens: 100,
          totalTokens: 1_000,
          cachedInputTokens: 600,
        },
      });

      expect(total?.cacheReadTokens).toBe(600);
    });

    it("returns null when the chunk carries no total", () => {
      expect(readAiSdkTotalUsage({})).toBeNull();
      expect(
        readAiSdkTotalUsage({ totalUsage: { inputTokens: 0, outputTokens: 0 } }),
      ).toBeNull();
    });
  });

  describe("readPiAiStreamUsage", () => {
    it("reads pi-ai's already-accumulated total", () => {
      // pi-ai sums its own tool loop and emits one report per stream, so it
      // needs no folding — which is why the old rule worked on that route and
      // failed on the other.
      const total = readPiAiStreamUsage({
        usage: {
          promptTokens: 8,
          completionTokens: 850,
          totalTokens: 1_544_045,
          cacheReadTokens: 1_155_820,
          cacheWriteTokens: 387_367,
        },
      });

      expect(total?.cacheReadTokens).toBe(1_155_820);
      expect(total?.cacheWriteTokens).toBe(387_367);
    });

    it("returns null for an all-zero report", () => {
      expect(
        readPiAiStreamUsage({
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        }),
      ).toBeNull();
    });
  });

  it("prefers the SDK total over a pi-ai reading on the same chunk", () => {
    // Only one of the two shapes is ever present, but the order matters: the
    // SDK's figure is computed by the SDK, ours is folded from step reports.
    const chunk = {
      totalUsage: {
        inputTokens: 1_543_195,
        outputTokens: 850,
        totalTokens: 1_544_045,
        inputTokenDetails: {
          cacheReadTokens: 1_155_820,
          cacheWriteTokens: 387_367,
        },
      },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };

    const resolved = readAiSdkTotalUsage(chunk) ?? readPiAiStreamUsage(chunk);
    expect(resolved?.cacheReadTokens).toBe(1_155_820);
  });
});
