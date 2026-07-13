import { describe, expect, test } from "vitest";
import {
  CHAT_PICKER_EXCLUDED_MODEL_IDS,
  PICKER_DEFAULT_MODEL_IDS,
  getAllPickerToggleModelIds,
  getPickerModels,
  isChatPickerModelId,
  isPickerDefaultModelId,
  resolveEnabledPickerModelIds,
} from "../ui/constants/modelPicker";

describe("modelPicker", () => {
  test("uses curated defaults when no user override", () => {
    expect(resolveEnabledPickerModelIds(null)).toEqual([
      ...PICKER_DEFAULT_MODEL_IDS,
    ]);
    expect(resolveEnabledPickerModelIds([])).toEqual([
      ...PICKER_DEFAULT_MODEL_IDS,
    ]);
  });

  test("default list includes Opus 4.8 and nine cloud models", () => {
    expect(PICKER_DEFAULT_MODEL_IDS).toHaveLength(9);
    expect(PICKER_DEFAULT_MODEL_IDS).toContain("claude-opus-4-8");
    expect(PICKER_DEFAULT_MODEL_IDS).toContain("gpt-5-6-sol");
  });

  test("getPickerModels resolves known model metadata", () => {
    const models = getPickerModels(["claude-sonnet-4-6", "gpt-5-6-sol"]);
    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("claude-sonnet-4-6");
    expect(models[1]?.name).toBe("GPT-5.6 Sol");
  });

  test("filters unknown ids and migrates retired gpt-5.5 from user override", () => {
    const ids = resolveEnabledPickerModelIds([
      "claude-sonnet-4-6",
      "gpt-5.5",
      "not-a-real-model",
    ]);
    expect(ids).toEqual(["claude-sonnet-4-6", "gpt-5-6-sol"]);
  });

  test("migrates legacy gpt-5.5 picker ids to gpt-5-6-sol", () => {
    expect(resolveEnabledPickerModelIds(["gpt-5.5-high"])).toEqual([
      "gpt-5-6-sol",
    ]);
  });

  test("isPickerDefaultModelId marks curated defaults", () => {
    expect(isPickerDefaultModelId("glm-5.2-max")).toBe(true);
    expect(isPickerDefaultModelId("claude-haiku-4-5")).toBe(false);
  });

  test("hides retired gpt-5.5 models from chat picker", () => {
    expect(CHAT_PICKER_EXCLUDED_MODEL_IDS).toContain("gpt-5.5");
    expect(isChatPickerModelId("gpt-5.5")).toBe(false);
    expect(getAllPickerToggleModelIds()).not.toContain("gpt-5.5");
    expect(getPickerModels(["gpt-5.5", "gpt-5-6-sol"]).map((m) => m.id)).toEqual([
      "gpt-5-6-sol",
    ]);
  });
});
