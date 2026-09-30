import { describe, expect, it } from "vitest";
import type { MemoryObject } from "@papr/memory/resources/shared.js";
import {
  decideExperimentArm,
  experimentEnvKeys,
} from "../src/core/utils/experimentArm.js";
import {
  gateCatalogWithJev,
  type CatalogScorer,
} from "../src/gateway/services/jevMemoryCatalogGate.js";

const noEnv: NodeJS.ProcessEnv = {};

describe("decideExperimentArm", () => {
  const base = { name: "jev_catalog", defaultTreatmentRate: 0.1, defaultControlRate: 0.1 };

  it("is off when both rates are zero", () => {
    expect(
      decideExperimentArm({ ...base, defaultTreatmentRate: 0, defaultControlRate: 0, random: () => 0, env: noEnv }),
    ).toBeNull();
  });

  it("assigns treatment, control, then null by roll", () => {
    expect(decideExperimentArm({ ...base, random: () => 0.05, env: noEnv })).toBe("treatment");
    expect(decideExperimentArm({ ...base, random: () => 0.15, env: noEnv })).toBe("control");
    expect(decideExperimentArm({ ...base, random: () => 0.5, env: noEnv })).toBeNull();
  });

  it("reads rates from env and ignores malformed values", () => {
    const keys = experimentEnvKeys("jev_catalog");
    expect(keys.treatment).toBe("PAPR_EXP_JEV_CATALOG_TREATMENT_RATE");
    const env = { [keys.treatment]: "0.5", [keys.control]: "banana" };
    expect(decideExperimentArm({ ...base, random: () => 0.4, env })).toBe("treatment");
    expect(decideExperimentArm({ ...base, random: () => 0.55, env })).toBe("control");
  });
});

function mem(id: string, content: string, category = "fact"): MemoryObject {
  return { id, content, category } as MemoryObject;
}

describe("gateCatalogWithJev", () => {
  const scorerFrom =
    (table: Record<string, number>): CatalogScorer =>
    async (_msg, items) =>
      Object.fromEntries(
        Object.entries(items).map(([k, text]) => [
          k,
          Object.entries(table).find(([needle]) => text.includes(needle))?.[1] ?? 0,
        ]),
      );

  it("keeps only items at or above minLevel, best first, deduped", () => {
    const candidates = [
      mem("a", "alpha about jev"),
      mem("b", "beta noise"),
      mem("a", "alpha about jev"),
      mem("c", "gamma very relevant"),
    ];
    return gateCatalogWithJev("q", candidates, {
      scorer: scorerFrom({ alpha: 2.1, gamma: 2.9, beta: 0.3 }),
    }).then((res) => {
      expect(res).not.toBeNull();
      expect(res!.candidates).toBe(3);
      expect(res!.kept.map((m) => m.id)).toEqual(["c", "a"]);
    });
  });

  it("returns empty kept (not null) when nothing clears the bar", async () => {
    const res = await gateCatalogWithJev("q", [mem("a", "x"), mem("b", "y")], {
      scorer: async (_m, items) => Object.fromEntries(Object.keys(items).map((k) => [k, 0.4])),
    });
    expect(res?.kept).toEqual([]);
  });

  it("returns null on scorer failure so caller can fall back", async () => {
    const res = await gateCatalogWithJev("q", [mem("a", "x")], {
      scorer: async () => {
        throw new Error("JEV_AUTH_MISSING");
      },
    });
    expect(res).toBeNull();
  });

  it("respects maxKeep", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => mem(`m${i}`, `item ${i}`));
    const res = await gateCatalogWithJev("q", candidates, {
      maxKeep: 2,
      scorer: async (_m, items) => Object.fromEntries(Object.keys(items).map((k) => [k, 3])),
    });
    expect(res?.kept).toHaveLength(2);
  });
});
