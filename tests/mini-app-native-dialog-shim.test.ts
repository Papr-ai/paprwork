import { describe, expect, test } from "vitest";
import { injectMiniAppNativeDialogShim } from "../src/gateway/utils/injectMiniAppNativeDialogShim.js";

describe("injectMiniAppNativeDialogShim", () => {
  test("injects shim script at start of head", () => {
    const html = "<html><head><title>App</title></head><body></body></html>";
    const out = injectMiniAppNativeDialogShim(html);
    expect(out).toContain('<script src="/__papr__/papr-native-dialog-shim.js"></script>');
    expect(out.indexOf("papr-native-dialog-shim.js")).toBeLessThan(out.indexOf("<title>"));
  });

  test("does not duplicate shim when already present", () => {
    const html =
      '<html><head><script src="/__papr__/papr-native-dialog-shim.js"></script></head></html>';
    expect(injectMiniAppNativeDialogShim(html)).toBe(html);
  });
});
