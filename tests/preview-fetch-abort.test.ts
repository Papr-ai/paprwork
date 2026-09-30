import { describe, expect, it } from "vitest";
import { isBenignPreviewFetchAbortMessage } from "../ui/utils/previewFetchAbort";

describe("previewFetchAbort", () => {
  it("matches preview fetch gate abort messages", () => {
    expect(
      isBenignPreviewFetchAbortMessage(
        "Unhandled rejection: Preview became visible — stale background fetches aborted",
      ),
    ).toBe(true);
    expect(isBenignPreviewFetchAbortMessage("Unhandled rejection: Preview evicted")).toBe(
      true,
    );
  });

  it("does not match real app failures", () => {
    expect(
      isBenignPreviewFetchAbortMessage("Unhandled rejection: Database query failed"),
    ).toBe(false);
    expect(isBenignPreviewFetchAbortMessage("Cannot GET /apps/foo/index.html")).toBe(
      false,
    );
  });
});
