import { describe, expect, test } from "vitest";
import { inferJobProvider, isKnownOllamaModelId } from "../../src/core/utils/ollamaModelFit.js";

describe("inferJobProvider", () => {
  test("local model ids infer ollama", () => {
    for (const id of ["inkling-2-mini:latest", "inkling-2-mini:26b-a5b", "flint:40b", "gemma4:e4b", "gemma3:27b", "qwen3.5:latest", "qwen3.5:9b"])
      expect(inferJobProvider(undefined, id)).toBe("ollama");
  });
  test("explicit provider always wins", () => {
    expect(inferJobProvider("openai", "inkling-2-mini:latest")).toBe("openai");
  });
  test("hosted / missing ids are left alone", () => {
    for (const id of ["gpt-5.5", "claude-opus-5", "gemini-3.8-flash", undefined]) expect(inferJobProvider(undefined, id)).toBeUndefined();
    expect(isKnownOllamaModelId("")).toBe(false);
  });
});
