import { describe, expect, test } from "vitest";
import {
  getImportableMiniAppSdkModules,
  getPrimaryMiniAppSdkModule,
  MINI_APP_SDK_MODULES,
  PAPR_SDK_ENTRY_ROUTE,
} from "../src/resources/mini-app-sdk/sdk-manifest.js";

describe("mini-app SDK discovery", () => {
  test("routes are unique", () => {
    const routes = MINI_APP_SDK_MODULES.map((module) => module.route);
    expect(new Set(routes).size).toBe(routes.length);
  });

  test("discovers papr-sdk as primary ESM entry", () => {
    const sdk = getPrimaryMiniAppSdkModule();
    expect(sdk.file).toBe("papr-sdk.ts");
    expect(sdk.route).toBe(PAPR_SDK_ENTRY_ROUTE);
    expect(sdk.format).toBe("esm");
    expect(sdk.appImportable).toBe(true);
  });

  test("discovers papr-dialog and preview lifecycle modules", () => {
    const dialog = MINI_APP_SDK_MODULES.find(
      (module) => module.file === "papr-dialog.ts",
    );
    expect(dialog?.route).toBe("/__papr__/papr-dialog.ts");
    expect(dialog?.format).toBe("esm");

    const lifecycle = MINI_APP_SDK_MODULES.find(
      (module) => module.file === "papr-preview-lifecycle.ts",
    );
    expect(lifecycle?.route).toBe("/__papr__/papr-preview-lifecycle.ts");
  });

  test("importable catalog excludes platform-injected modules", () => {
    const importable = getImportableMiniAppSdkModules();
    expect(importable.some((m) => m.file === "papr-sdk.ts")).toBe(true);
    expect(
      importable.some((m) => m.file === "papr-native-dialog-shim.ts"),
    ).toBe(false);
  });

  test("auto-discovers every papr-*.ts file on disk", () => {
    const discovered = MINI_APP_SDK_MODULES.map((module) => module.file);
    expect(discovered).toContain("papr-sdk.ts");
    expect(discovered).toContain("papr-version-check.ts");
    expect(discovered).not.toContain("sdk-manifest.ts");
  });
});
