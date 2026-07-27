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

  test("default list includes Sonnet 5 and eight cloud models", () => {
    expect(PICKER_DEFAULT_MODEL_IDS).toHaveLength(8);
    expect(PICKER_DEFAULT_MODEL_IDS).toContain("claude-sonnet-5");
    expect(PICKER_DEFAULT_MODEL_IDS).not.toContain("claude-sonnet-4-6");
    expect(PICKER_DEFAULT_MODEL_IDS).not.toContain("claude-opus-5");
    expect(PICKER_DEFAULT_MODEL_IDS).toContain("gpt-5-6-sol");
  });

  test("getPickerModels resolves known model metadata", () => {
    const models = getPickerModels(["claude-sonnet-5", "gpt-5-6-sol"]);
    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("claude-sonnet-5");
    expect(models[1]?.name).toBe("GPT-5.6 Sol");
  });

  test("filters unknown ids and migrates retired gpt-5.5 from user override", () => {
    const ids = resolveEnabledPickerModelIds([
      "claude-sonnet-4-6",
      "gpt-5.5",
      "not-a-real-model",
    ]);
    expect(ids).toEqual(["claude-sonnet-5", "gpt-5-6-sol"]);
  });

  test("upgrades exact legacy default picker list to Sonnet 5 defaults", () => {
    expect(
      resolveEnabledPickerModelIds([
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-opus-4-8",
        "gpt-5-6-sol",
        "glm-5.2-max",
        "qwen/qwen3-32b",
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.1-pro-preview",
      ]),
    ).toEqual([...PICKER_DEFAULT_MODEL_IDS]);
  });

  test("swaps Sonnet 4.6 for Sonnet 5 in customized picker lists", () => {
    expect(
      resolveEnabledPickerModelIds([
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "gpt-5-6-sol",
        "gpt-5-6-luna",
      ]),
    ).toEqual([
      "claude-sonnet-5",
      "claude-opus-4-6",
      "gpt-5-6-sol",
      "gpt-5-6-luna",
    ]);
  });

  test("migrates legacy gpt-5.5 picker ids to gpt-5-6-sol", () => {
    expect(resolveEnabledPickerModelIds(["gpt-5.5-high"])).toEqual([
      "gpt-5-6-sol",
    ]);
  });

  test("migrates retired Opus 4.8 picker id to Opus 5", () => {
    expect(resolveEnabledPickerModelIds(["claude-opus-4-8"])).toEqual([
      "claude-opus-5",
    ]);
  });

  test("legacy Sonnet 4.6 and Opus 5 remain available in settings catalog", () => {
    const toggleIds = getAllPickerToggleModelIds();
    expect(toggleIds).toContain("claude-sonnet-4-6");
    expect(toggleIds).toContain("claude-opus-5");
    expect(isPickerDefaultModelId("claude-sonnet-4-6")).toBe(false);
    expect(isPickerDefaultModelId("claude-opus-5")).toBe(false);
    expect(isPickerDefaultModelId("claude-sonnet-5")).toBe(true);
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
