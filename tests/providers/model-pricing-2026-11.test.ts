import { describe, expect, it } from "vitest";
import {
  MODEL_PRICING,
  calculateCostWithCache,
  resolveModelPricing,
} from "../../src/gateway/services/CostCalculation.js";

/**
 * Issue #900: the table had drifted from the provider pricing pages. Each case
 * pins a figure read from the page on 2026-11-17, at 1M tokens so the expected
 * dollar amount is the per-MTok rate itself.
 */
const M = 1_000_000;
const input = (model: string, at?: Date) =>
  calculateCostWithCache(model, { promptTokens: M, completionTokens: 0 }, at);
const output = (model: string, at?: Date) =>
  calculateCostWithCache(model, { promptTokens: 0, completionTokens: M }, at);
const cacheRead = (model: string, at?: Date) =>
  calculateCostWithCache(
    model,
    { promptTokens: M, completionTokens: 0, cacheReadTokens: M },
    at,
  );

describe("Anthropic rates (docs.anthropic.com pricing)", () => {
  it.each([
    ["claude-sonnet-5", 2, 10, 0.2],
    ["claude-sonnet-5-5", 2, 10, 0.1],
    ["claude-opus-5-5", 4, 20, 0.2],
    ["claude-opus-4-6", 5, 25, 0.5],
    ["claude-haiku-4-5", 1, 5, 0.1],
    ["claude-fable-5-1", 10, 50, 0.25],
    ["claude-fable-5-2", 8, 40, 0.2],
  ])("%s: $%d in / $%d out / $%d cache hit", (model, inp, out, hit) => {
    expect(input(model)).toBeCloseTo(inp, 6);
    expect(output(model)).toBeCloseTo(out, 6);
    expect(cacheRead(model)).toBeCloseTo(hit, 6);
  });
});

describe("OpenAI rates (developers.openai.com pricing, Standard)", () => {
  it.each([
    ["gpt-5-6-sol", 4, 20],
    ["gpt-5-6-sol-high", 4, 20],
    ["gpt-5-6-terra", 2, 12],
    ["gpt-5-6-luna", 0.2, 1.2],
    ["gpt-6-astra", 10, 50],
  ])("%s: $%d in / $%d out, cached input 0.1×", (model, inp, out) => {
    expect(input(model)).toBeCloseTo(inp, 6);
    expect(output(model)).toBeCloseTo(out, 6);
    expect(cacheRead(model)).toBeCloseTo(inp * 0.1, 6);
  });
});

describe("dated intro pricing expires on its own", () => {
  const lastIntroDay = new Date("2026-11-30T23:59:59Z");
  const firstStandardDay = new Date("2026-12-01T00:00:00Z");

  it("Gemini 4 Argon moves from $2/$10 to $4/$20 on 2026-12-01", () => {
    expect(input("gemini-4-argon", lastIntroDay)).toBeCloseTo(2, 6);
    expect(output("gemini-4-argon", lastIntroDay)).toBeCloseTo(10, 6);
    expect(input("gemini-4-argon", firstStandardDay)).toBeCloseTo(4, 6);
    expect(output("gemini-4-argon", firstStandardDay)).toBeCloseTo(20, 6);
    expect(cacheRead("gemini-4-argon", firstStandardDay)).toBeCloseTo(0.2, 6);
  });

  it("Gemini 3.8 Flash moves from $0.75/$3.75 to $1.50/$7.50 on 2027-01-01", () => {
    expect(input("gemini-3.8-flash", new Date("2026-12-31T12:00:00Z"))).toBeCloseTo(0.75, 6);
    expect(input("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"))).toBeCloseTo(1.5, 6);
    expect(output("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"))).toBeCloseTo(7.5, 6);
  });

  it("an entry with no `until` answers the same at any date", () => {
    expect(resolveModelPricing("claude-sonnet-5", new Date("2030-01-01"))).toEqual(
      resolveModelPricing("claude-sonnet-5", new Date("2026-01-01")),
    );
  });

  it("every `until` is a real date and every `then` is a full rate", () => {
    for (const [model, entry] of Object.entries(MODEL_PRICING)) {
      if (!entry.until) continue;
      expect(entry.until, model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(entry.until)), model).toBe(false);
      expect(entry.then?.input, model).toBeGreaterThan(0);
      expect(entry.then?.output, model).toBeGreaterThan(0);
    }
  });
});

describe("table format", () => {
  it("keeps each entry on one line so the weekly drift check can read it", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../../src/gateway/services/CostCalculation.ts", import.meta.url),
      "utf8",
    );
    for (const model of Object.keys(MODEL_PRICING)) {
      const line = source.split("\n").find((l) => l.trimStart().startsWith(`"${model}":`));
      expect(line, model).toMatch(/input: [\d.]+, output: [\d.]+/);
    }
  });
});

describe("Gemini 4 family (aistudio.google.com/docs/pricing, 2026-11-23)", () => {
  it("Carbon matches Argon: $2/$10 intro, $4/$20 from 2026-12-01", () => {
    expect(input("gemini-4-carbon", new Date("2026-11-30T12:00:00Z"))).toBeCloseTo(2, 6);
    expect(input("gemini-4-carbon", new Date("2026-12-01T00:00:00Z"))).toBeCloseTo(4, 6);
  });
  it.each([
    ["gemini-4-neon", 3, 15],
    ["gemini-4-hydrogen", 1.5, 7.5],
  ])("%s: $%d in / $%d out", (model, inp, out) => {
    expect(input(model)).toBeCloseTo(inp, 6);
    expect(output(model)).toBeCloseTo(out, 6);
  });
});
