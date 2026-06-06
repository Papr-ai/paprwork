import { describe, expect, test } from "vitest";
import { getAllToolIds } from "../src/core/tools/index.js";

describe("Browser diagnostics tool registry", () => {
  test("registers browser test and diagnostics tools", () => {
    const ids = getAllToolIds();
    expect(ids).toContain("browser_console_logs");
    expect(ids).toContain("browser_network_logs");
    expect(ids).toContain("browser_test_script");
    expect(ids).toContain("webview_launch_app");
    expect(ids).toContain("webview_wait_for");
    expect(ids).toContain("webview_snapshot");
    expect(ids).toContain("webview_execute");
    expect(ids).toContain("webview_get_console");
    expect(ids).toContain("webview_get_network");
    expect(ids).toContain("webview_list");
    expect(ids).toContain("webview_close");
  });
});
