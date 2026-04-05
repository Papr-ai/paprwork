import { describe, expect, it } from "vitest";
import {
  bytesToRamGbRounded,
  getRecommendedGemmaModel,
  getRecommendedQwenModel,
  ollamaModelFitsHostRam,
  pickFittingOllamaModelId,
  QWEN_RAM_REQUIREMENTS,
} from "../src/core/utils/ollamaModelFit.js";

describe("ollamaModelFit", () => {
  it("bytesToRamGbRounded rounds to one decimal", () => {
    const gb = 16 * 1024 ** 3 - 500_000_000;
    expect(bytesToRamGbRounded(gb)).toBeGreaterThanOrEqual(15);
    expect(bytesToRamGbRounded(gb)).toBeLessThanOrEqual(16);
  });

  it("recommends smaller Qwen when RAM is low", () => {
    expect(getRecommendedQwenModel(4)).toBe("qwen3.5:0.8b");
    expect(getRecommendedQwenModel(8)).toBe("qwen3.5:2b");
    expect(getRecommendedQwenModel(32)).toBe("qwen3.5:27b");
  });

  it("recommends fitting Gemma tier", () => {
    expect(getRecommendedGemmaModel(4)).toBe("gemma3:1b");
    expect(getRecommendedGemmaModel(12)).toBe("gemma3:4b-it-qat"); // Updated: QAT preferred
  });

  it("ollamaModelFitsHostRam uses minimum total RAM from table", () => {
    expect(ollamaModelFitsHostRam("qwen3.5:latest", 16)).toBe(true);
    expect(
      QWEN_RAM_REQUIREMENTS["qwen3.5:latest"] !== undefined &&
        QWEN_RAM_REQUIREMENTS["qwen3.5:latest"] <= 16,
    ).toBe(true);
    expect(ollamaModelFitsHostRam("qwen3.5:27b", 16)).toBe(false);
  });

  it("pickFittingOllamaModelId falls back to smallest when none fit", () => {
    const id = pickFittingOllamaModelId(
      QWEN_RAM_REQUIREMENTS,
      [
        "qwen3.5:27b",
        "qwen3.5:latest",
        "qwen3.5:4b",
        "qwen3.5:2b",
        "qwen3.5:0.8b",
      ],
      2,
    );
    expect(id).toBe("qwen3.5:0.8b");
  });
});
