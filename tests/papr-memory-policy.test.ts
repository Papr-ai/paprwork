import { describe, expect, it } from "vitest";
import {
  buildAddPolicy,
  buildCodeIndexAddPolicy,
  buildSearchPolicy,
  normalizeSignalDomainId,
} from "../src/gateway/utils/paprMemoryPolicy.js";

describe("paprMemoryPolicy", () => {
  it("normalizes legacy default domain to general", () => {
    expect(normalizeSignalDomainId("default")).toBe("general");
    expect(normalizeSignalDomainId("code")).toBe("code");
  });

  it("buildAddPolicy uses transform_embedding when signalDomain is set", () => {
    const policy = buildAddPolicy({
      signalDomain: "cosqa",
    });
    expect(policy?.transform_embedding).toEqual({
      mode: "auto",
      domain_id: "cosqa",
    });
  });

  it("buildCodeIndexAddPolicy uses code domain and graph schema", () => {
    const policy = buildCodeIndexAddPolicy("schema-abc");
    expect(policy.transform_embedding).toEqual({
      mode: "auto",
      domain_id: "code",
    });
    expect(policy.graph).toEqual({
      mode: "auto",
      schema_id: "schema-abc",
    });
  });

  it("buildSearchPolicy defaults code category searches to code domain", () => {
    const policy = buildSearchPolicy({ defaultDomain: "code" });
    expect(policy?.vector).toEqual({
      mode: "enhanced",
      domain_id: "code",
    });
  });

  it("buildSearchPolicy maps vectorPolicy to SDK vector policy", () => {
    const policy = buildSearchPolicy({
      vectorPolicy: {
        domainId: "general",
        returnSignalScores: true,
        signalThresholds: { topic: 0.8 },
      },
    });
    expect(policy?.vector).toEqual({
      mode: "enhanced",
      domain_id: "general",
      return_signal_scores: true,
      signal_thresholds: { topic: 0.8 },
    });
  });
});
