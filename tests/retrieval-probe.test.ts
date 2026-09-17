/**
 * Randomised-exposure holdout (A13) — arm assignment must be independent of
 * everything except the roll, and must never override an explicit caller
 * argument.
 *
 * The probe exists because agent-derived retrieval labels are otherwise
 * confounded: the agent chose the query AND saw a ranking produced by the
 * reranker we want to evaluate, so "cited" cannot be separated from "was put
 * on top". More logs do not fix that — they estimate the biased quantity more
 * precisely. Randomising exposure on a small slice is the only clean fix.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTROL_RATE,
  DEFAULT_PROBE_RATE,
  armDisablesReranking,
  decideRetrievalProbeArm,
} from "../src/core/utils/retrievalProbe.js";

const noEnv: NodeJS.ProcessEnv = {};

describe("decideRetrievalProbeArm", () => {
  it("assigns the treatment arm on a low roll", () => {
    const arm = decideRetrievalProbeArm({
      callerChoseProvider: false,
      random: () => 0.001,
      env: noEnv,
    });
    expect(arm).toBe("rerank_off");
    expect(armDisablesReranking(arm)).toBe(true);
  });

  it("assigns a matched control arm just above the treatment band", () => {
    const arm = decideRetrievalProbeArm({
      callerChoseProvider: false,
      random: () => DEFAULT_PROBE_RATE + DEFAULT_CONTROL_RATE / 2,
      env: noEnv,
    });
    expect(arm).toBe("control");
    // Control must NOT disable reranking — it is the comparison group, so it
    // has to receive the ordinary treatment path.
    expect(armDisablesReranking(arm)).toBe(false);
  });

  it("leaves the vast majority of searches unassigned", () => {
    expect(
      decideRetrievalProbeArm({
        callerChoseProvider: false,
        random: () => 0.9,
        env: noEnv,
      }),
    ).toBeNull();
  });

  it("never overrides an explicit rerankingProvider", () => {
    // Even on a roll that would otherwise land in the treatment band.
    expect(
      decideRetrievalProbeArm({
        callerChoseProvider: true,
        random: () => 0,
        env: noEnv,
      }),
    ).toBeNull();
  });

  it("can be switched off entirely via env", () => {
    expect(
      decideRetrievalProbeArm({
        callerChoseProvider: false,
        random: () => 0,
        env: {
          PAPR_RETRIEVAL_PROBE_RATE: "0",
          PAPR_RETRIEVAL_CONTROL_RATE: "0",
        },
      }),
    ).toBeNull();
  });

  it("ignores a malformed rate instead of silently maxing out the experiment", () => {
    // A bad env value must fall back to the default, not to 100% treatment.
    // Getting this wrong would degrade every search in production.
    for (const bad of ["abc", "-1", "2", "NaN", ""]) {
      const arm = decideRetrievalProbeArm({
        callerChoseProvider: false,
        random: () => 0.5,
        env: { PAPR_RETRIEVAL_PROBE_RATE: bad },
      });
      expect(arm, `rate=${bad}`).toBeNull();
    }
  });

  it("honours a raised rate", () => {
    const arm = decideRetrievalProbeArm({
      callerChoseProvider: false,
      random: () => 0.4,
      env: { PAPR_RETRIEVAL_PROBE_RATE: "0.5" },
    });
    expect(arm).toBe("rerank_off");
  });

  it("keeps the default slice small — this costs real result quality", () => {
    // Guard against someone bumping the default. 2% is the agreed price.
    expect(DEFAULT_PROBE_RATE).toBeLessThanOrEqual(0.02);
    expect(DEFAULT_CONTROL_RATE).toBeLessThanOrEqual(0.02);
  });
});
