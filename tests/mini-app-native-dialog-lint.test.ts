import { describe, expect, test } from "vitest";
import { checkMiniAppNativeDialogPatterns } from "../src/gateway/utils/miniAppNativeDialogLint.js";

describe("checkMiniAppNativeDialogPatterns", () => {
  test("errors on window.prompt in app source", () => {
    const files = new Map<string, string>([
      [
        "pages/settings.ts",
        `const name = window.prompt('Enter name:');`,
      ],
    ]);
    const issues = checkMiniAppNativeDialogPatterns(files);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule).toBe("no-native-dialogs");
    expect(issues[0]?.severity).toBe("error");
  });

  test("errors on bare confirm() and alert()", () => {
    const files = new Map<string, string>([
      ["app.ts", `if (!confirm('Delete?')) return;\nalert('Done');`],
    ]);
    const issues = checkMiniAppNativeDialogPatterns(files);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.rule === "no-native-dialogs")).toBe(true);
  });

  test("passes askConfirm and confirmDialog helpers", () => {
    const files = new Map<string, string>([
      [
        "pages/settings.ts",
        `import { askConfirm } from '/__papr__/papr-dialog.ts';
if (!await askConfirm('Remove?')) return;
await confirmDialog({ title: 'Submit' });`,
      ],
    ]);
    const issues = checkMiniAppNativeDialogPatterns(files);
    expect(issues).toHaveLength(0);
  });

  test("ignores native dialog mentions in comments", () => {
    const files = new Map<string, string>([
      [
        "app.ts",
        `// Do not use window.prompt() here
export const ok = true;`,
      ],
    ]);
    const issues = checkMiniAppNativeDialogPatterns(files);
    expect(issues).toHaveLength(0);
  });
});
