import { describe, expect, it } from "vitest";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import {
  filterCatalogNoise,
  isCatalogNoiseMemory,
} from "../src/gateway/services/memoryGraphCatalog.js";
import {
  isExperimentEnabled,
  EXPERIMENT_SETTINGS_VERSION,
  mergeExperimentSettings,
  resolveExperimentRates,
} from "../src/core/types/experimentSettings.js";

const mem = (over: Partial<MemoryObject> & { customMetadata?: Record<string, unknown> }) =>
  ({ id: "x", content: "User prefers dark mode", category: "preference", ...over }) as MemoryObject;

describe("isCatalogNoiseMemory", () => {
  it("drops conversation batch summaries by content_type", () => {
    expect(isCatalogNoiseMemory(mem({ customMetadata: { content_type: "conversation_batch" } }))).toBe(true);
  });
  it("drops job-session memories by chatId prefix", () => {
    expect(isCatalogNoiseMemory(mem({ customMetadata: { chatId: "job:abc" } }))).toBe(true);
  });
  it("drops by content heading when metadata is missing", () => {
    expect(isCatalogNoiseMemory(mem({ content: "  # Conversation Batch 1\nSession: ..." }))).toBe(true);
  });
  it("keeps human memories", () => {
    expect(isCatalogNoiseMemory(mem({ customMetadata: { chatId: "3873f9e6" } }))).toBe(false);
    expect(filterCatalogNoise([mem({}), mem({ customMetadata: { content_type: "daily_log" } })])).toHaveLength(1);
  });
});

describe("experiment settings", () => {
  it("defaults on for every registered experiment with a 50/50 split", () => {
    const s = mergeExperimentSettings(undefined);
    expect(s.enabled).toBe(true);
    expect(s.flags.JEV_CATALOG).toBe(true);
    expect(resolveExperimentRates(s, "JEV_CATALOG")).toEqual({ treatmentRate: 0.5, controlRate: 0.5 });
  });
  it("an opt-out saved against the current version persists", () => {
    const v = EXPERIMENT_SETTINGS_VERSION;
    expect(resolveExperimentRates(mergeExperimentSettings({ enabled: false, version: v }), "JEV_CATALOG"))
      .toEqual({ treatmentRate: 0, controlRate: 0 });
    expect(resolveExperimentRates(mergeExperimentSettings({ flags: { JEV_CATALOG: false }, version: v }), "JEV_CATALOG"))
      .toEqual({ treatmentRate: 0, controlRate: 0 });
  });
  it("settings persisted by an older build are re-defaulted, not treated as opt-out", () => {
    const stale = mergeExperimentSettings({ enabled: false, flags: {} }); // no version = v0
    expect(stale.enabled).toBe(true);
    expect(stale.flags.JEV_CATALOG).toBe(true);
    expect(stale.version).toBe(EXPERIMENT_SETTINGS_VERSION);
    const older = mergeExperimentSettings({ enabled: false, flags: {}, version: EXPERIMENT_SETTINGS_VERSION - 1 });
    expect(older.enabled).toBe(true);
  });
  it("requires both master and per-experiment flag", () => {
    expect(isExperimentEnabled({ enabled: false, flags: { JEV_CATALOG: true } }, "JEV_CATALOG")).toBe(false);
    expect(isExperimentEnabled({ enabled: true, flags: {} }, "JEV_CATALOG")).toBe(false);
    const on = { enabled: true, flags: { JEV_CATALOG: true } };
    expect(isExperimentEnabled(on, "JEV_CATALOG")).toBe(true);
    expect(resolveExperimentRates(on, "JEV_CATALOG")).toEqual({ treatmentRate: 0.5, controlRate: 0.5 });
  });
  it("unknown experiment ids resolve to zero", () => {
    expect(resolveExperimentRates({ enabled: true, flags: { NOPE: true } }, "NOPE")).toEqual({ treatmentRate: 0, controlRate: 0 });
  });
});
