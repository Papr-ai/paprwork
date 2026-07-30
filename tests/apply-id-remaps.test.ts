import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIdRemapsToDirectory } from "../src/gateway/utils/applyIdRemaps.js";

describe("applyIdRemapsToDirectory", () => {
  test("rewrites publisher app id in source files but skips lineage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "papr-remap-"));
    const oldId = "6564707e-c810-47ef-b9ce-c8a83c0cd16c";
    const newId = "bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c";

    await writeFile(
      join(dir, "app.ts"),
      `const APP_ID = '${oldId}';\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "papr-cloud-lineage.json"),
      JSON.stringify({ source: { appId: oldId } }),
      "utf8",
    );

    const { remappedFiles } = await applyIdRemapsToDirectory(
      dir,
      new Map([[oldId, newId]]),
    );

    expect(remappedFiles).toEqual(["app.ts"]);
    const appSource = await readFile(join(dir, "app.ts"), "utf8");
    expect(appSource).toContain(newId);
    const lineage = await readFile(join(dir, "papr-cloud-lineage.json"), "utf8");
    expect(lineage).toContain(oldId);
  });
});
