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

  it("reads app id from create_app result even when validation failed", () => {
    expect(
      resolveAppIdForAutoOpen({
        toolName: "create_app",
        parsedResult: {
          success: false,
          data: { id: "new-app-id", title: "Todos" },
        },
      }),
    ).toBe("new-app-id");
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
        args: { path: "$PAPR_HOME/apps/abc-123/app.ts" },
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

  it("opens create_app when artifact id exists despite validation failure", () => {
    expect(
      shouldAutoOpenArtifactTab({
        toolName: "create_app",
        hasError: false,
        hasResult: true,
        parsedResult: {
          success: false,
          data: { id: "e32e573c-9de3-4dee-90ed-5f98627df0f5", title: "Todos" },
        },
      }),
    ).toBe(true);
  });

  it("does not open create_app when gate blocked with no artifact id", () => {
    expect(
      shouldAutoOpenArtifactTab({
        toolName: "create_app",
        hasError: false,
        hasResult: true,
        parsedResult: { success: false, error: "Product architect gate blocked" },
      }),
    ).toBe(false);
  });

  it("opens validate_app when appId is in args even when validation failed", () => {
    expect(
      shouldAutoOpenArtifactTab({
        toolName: "validate_app",
        hasError: false,
        hasResult: true,
        parsedResult: { success: false, error: "validation failed" },
        args: { appId: "e32e573c-9de3-4dee-90ed-5f98627df0f5" },
      }),
    ).toBe(true);
  });

  it("does not auto-open app tab for webview_launch_app (inline chat preview instead)", () => {
    expect(
      shouldAutoOpenArtifactTab({
        toolName: "webview_launch_app",
        hasError: false,
        hasResult: true,
        parsedResult: { success: true, data: { webviewId: "wv-1" } },
        args: { appId: "e32e573c-9de3-4dee-90ed-5f98627df0f5" },
      }),
    ).toBe(false);
  });

  it("does not open webview_launch_app when launch failed", () => {
    expect(
      shouldAutoOpenArtifactTab({
        toolName: "webview_launch_app",
        hasError: false,
        hasResult: true,
        parsedResult: { success: false, error: "launch failed" },
        args: { appId: "e32e573c-9de3-4dee-90ed-5f98627df0f5" },
      }),
    ).toBe(false);
  });
});
