import { describe, expect, it } from "vitest";
import {
  classifyError,
  getErrorClassificationReason,
} from "../src/gateway/services/jobs/errorClassifier.js";

describe("errorClassifier spawn resource errors", () => {
  it("classifies EBADF as permanent", () => {
    expect(
      classifyError(Object.assign(new Error("spawn EBADF"), { code: "EBADF" })),
    ).toBe("permanent");
  });

  it("classifies EMFILE as permanent", () => {
    expect(
      classifyError(Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })),
    ).toBe("permanent");
  });

  it("classifies pipe error message as permanent", () => {
    expect(
      classifyError(
        new Error(
          "Could not start command — Paprwork could not open process pipes (EBADF).",
        ),
      ),
    ).toBe("permanent");
  });

  it("returns spawn resource reason", () => {
    expect(
      getErrorClassificationReason(
        Object.assign(new Error("spawn EBADF"), { code: "EBADF" }),
      ),
    ).toContain("spawn resource");
  });
});
