import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test } from "vitest";
import { TemplateService } from "../src/gateway/services/TemplateService.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function setup(): Promise<{
  templateService: TemplateService;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-template-test-"));
  tmpRoots.push(root);
  process.env.HOME = root;
  const templateService = new TemplateService();
  return { templateService };
}

describe("TemplateService", () => {
  test("creates pipeline template with app + python job + sqlite scaffold", async () => {
    const { templateService } = await setup();
    const result = await templateService.createPipelineTemplate({
      name: "Orders Pipeline",
    });

    expect(result.app.title).toBe("Orders Pipeline");
    expect(result.job.type).toBe("python");
    expect(result.dbPath.endsWith(path.join("data", "data.db"))).toBe(true);

    expect(result.jobPath).toBeTruthy();
    const mainPy = await fs.readFile(path.join(result.jobPath, "code", "main.py"), "utf8");
    expect(mainPy).toContain("CREATE TABLE IF NOT EXISTS events");
  });
});
