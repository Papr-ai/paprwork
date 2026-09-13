import { describe, expect, it } from "vitest";
import { getModelById } from "../ui/constants/models";
import { getUnavailableModelMessage } from "../ui/utils/modelAvailabilityMessage";

describe("getUnavailableModelMessage", () => {
  it("returns Claude-specific copy for Anthropic models", () => {
    const model = getModelById("claude-opus-5");
    expect(model).toBeDefined();
    expect(getUnavailableModelMessage(model!)).toBe(
      "This model needs Claude OAuth or an API key.",
    );
  });

  it("returns OpenAI-specific copy for GPT models", () => {
    const model = getModelById("gpt-5-6-sol");
    expect(model).toBeDefined();
    expect(getUnavailableModelMessage(model!)).toBe(
      "This model needs ChatGPT OAuth or an OpenAI API key.",
    );
  });
});
