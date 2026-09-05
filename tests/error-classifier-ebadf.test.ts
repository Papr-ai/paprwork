import { describe, expect, it } from "vitest";
import {
  classifyError,
  getErrorClassificationReason,
} from "../src/gateway/services/jobs/errorClassifier.js";

describe("errorClassifier spawn resource errors", () => {
  it("classifies EBADF as transient (retryable)", () => {
    expect(
      classifyError(Object.assign(new Error("spawn EBADF"), { code: "EBADF" })),
    ).toBe("transient");
  });

  it("classifies EMFILE as transient", () => {
    expect(
      classifyError(Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })),
    ).toBe("transient");
  });

  it("classifies pipe error message as transient", () => {
    expect(
      classifyError(
        new Error(
          "Could not start command — Paprwork could not open process pipes (EBADF).",
        ),
      ),
    ).toBe("transient");
  });

  it("returns spawn resource reason with retry hint", () => {
    expect(
      getErrorClassificationReason(
        Object.assign(new Error("spawn EBADF"), { code: "EBADF" }),
      ),
    ).toContain("will retry");
  });
});

describe("classifyError — dropped model stream", () => {
  it("treats undici 'terminated' and socket-drop messages as transient so agent jobs retry", () => {
    for (const msg of [
      "Agent job model error (anthropic/claude-sonnet-4-6): terminated",
      "TypeError: terminated",
      "other side closed",
      "socket hang up",
      "Premature close",
    ]) {
      expect(classifyError(new Error(msg)), msg).toBe("transient");
    }
    expect(getErrorClassificationReason(new Error("Agent job model error (anthropic/x): terminated"))).toMatch(
      /Model stream dropped mid-response/,
    );
  });

  it("still treats auth failures as permanent", () => {
    expect(classifyError(new Error("401 unauthorized"))).toBe("permanent");
    expect(classifyError(new Error("invalid api key"))).toBe("permanent");
  });
});
