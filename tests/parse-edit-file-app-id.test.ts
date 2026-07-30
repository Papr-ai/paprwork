import { describe, expect, it } from "vitest";
import { parseAppIdFromEditFilePath } from "../ui/utils/parseEditFileAppId";
import {
  resolveAppIdForAutoOpen,
  shouldAutoOpenArtifactTab,
} from "../ui/utils/resolveAppIdForAutoOpen";

describe("parseAppIdFromEditFilePath", () => {
  it("parses app id from Papr apps path", () => {
    expect(
      parseAppIdFromEditFilePath("~/Papr/apps/abc-123/index.html"),
    ).toBe("abc-123");
    expect(
      parseAppIdFromEditFilePath("/Users/me/Papr/apps/abc-123/app.ts"),
    ).toBe("abc-123");
  });

  it("parses app id from org/namespace Papr apps path", () => {
    expect(
      parseAppIdFromEditFilePath(
        "~/Papr/orgs/org-1/namespaces/ns-1/apps/abc-123/index.html",
      ),
    ).toBe("abc-123");
  });

  it("parses app id from $PAPR_HOME shorthand", () => {
    expect(
      parseAppIdFromEditFilePath(
        "$PAPR_HOME/apps/aa07a65e-147f-480b-b287-79ce016acab9/data-sources.json",
      ),
    ).toBe("aa07a65e-147f-480b-b287-79ce016acab9");
  });

  it("returns undefined for non-app paths", () => {
    expect(
      parseAppIdFromEditFilePath("~/Documents/GitHub/paprwork-v2/foo.ts"),
    ).toBeUndefined();
  });
});

describe("resolveAppIdForAutoOpen", () => {
  it("prefers args.appId", () => {
    expect(
      resolveAppIdForAutoOpen({
        toolName: "edit_app_file_lines",
        args: { appId: "from-args", path: "$PAPR_HOME/apps/other-id/x.ts" },
      }),
    ).toBe("from-args");
  });

  it("reads appId from edit result data", () => {
    expect(
      resolveAppIdForAutoOpen({
        toolName: "edit_file",
        args: {
          path: "$PAPR_HOME/apps/ignored/data.json",
        },
        parsedResult: {
          success: false,
          data: { appId: "from-result", filename: "data.json" },
        },
      }),
    ).toBe("from-result");
  });
});

describe("shouldAutoOpenArtifactTab", () => {
  it("opens merged tab for app edits even when validation failed", () => {
    expect(
      shouldAutoOpenArtifactTab({
        toolName: "edit_file",
        hasError: false,
        hasResult: true,
        parsedResult: { success: false, error: "Icon must be SVG" },
      }),
    ).toBe(true);
  });

  it("does not open when tool errored before execution", () => {
    expect(
      shouldAutoOpenArtifactTab({
        toolName: "write_file",
        hasError: true,
        hasResult: false,
        parsedResult: null,
      }),
    ).toBe(false);
  });

  it("requires success for create_app", () => {
    expect(
      shouldAutoOpenArtifactTab({
        toolName: "create_app",
        hasError: false,
        hasResult: true,
        parsedResult: { success: false },
      }),
    ).toBe(false);
  });
});
