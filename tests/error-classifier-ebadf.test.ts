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
