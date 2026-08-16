import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test } from "vitest";
import { SkillService } from "../src/gateway/services/SkillService.js";
import { useIsolatedPaprWorkspace } from "./setup/isolatedWorkspace.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function setupService(): Promise<SkillService> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-skills-test-"));
  tmpRoots.push(root);
  process.env.HOME = root;
  const service = new SkillService();
  await service.initialize();
  return service;
}

describe("SkillService", () => {
  // Redirects HOME/PAPR_HOME to a temp dir so fixtures never land in
  // the developer's real ~/Papr workspace.
  useIsolatedPaprWorkspace("skill-service");

  test("preloads baseline skills for all users", async () => {
    const service = await setupService();
    const listed = await service.listSkills();
    expect(listed.length).toBeGreaterThan(0);
    expect(
      listed.some((skill) => skill.source === "preloaded"),
    ).toBe(true);
  });

  test("creates and lists skills", async () => {
    const service = await setupService();
    const created = await service.createSkill({
      name: "reviewer",
      description: "Review code for regressions",
      content: "Always check tests and edge cases.",
    });
    const listed = await service.listSkills();
    expect(listed.some((skill) => skill.id === created.id)).toBe(true);
  });

  test("loads consolidated design system skill from disk", async () => {
    const service = await setupService();
    const listed = await service.listSkills();
    const designSystem = listed.find(
      (skill) => skill.id === "preloaded-paprwork-design-system",
    );
    expect(designSystem).toBeDefined();
    expect(designSystem?.name).toBe("Paprwork Design System");
    expect(designSystem?.source).toBe("preloaded");
    expect(designSystem?.content).toContain("Liquid Glass");

    // Old skills should NOT exist (they were consolidated)
    const oldLiquid = listed.find(
      (skill) => skill.id === "preloaded-liquid-glass-design",
    );
    const oldWeb = listed.find(
      (skill) => skill.id === "preloaded-web-design-guidelines",
    );
    const oldFrontend = listed.find(
      (skill) => skill.id === "preloaded-frontend-design",
    );
    expect(oldLiquid).toBeUndefined();
    expect(oldWeb).toBeUndefined();
    expect(oldFrontend).toBeUndefined();

    // DOCX creation skill should also be gone
    const oldDocx = listed.find(
      (skill) => skill.id === "preloaded-docx-creation",
    );
    expect(oldDocx).toBeUndefined();
  });

  test("updates and deletes skills", async () => {
    const service = await setupService();
    const created = await service.createSkill({
      name: "planner",
      description: "Plan implementation steps",
      content: "Break down work into chunks.",
    });
    const updated = await service.updateSkill(created.id, {
      description: "Plan work with priorities",
    });
    expect(updated?.description).toBe("Plan work with priorities");
    const deleted = await service.deleteSkill(created.id);
    expect(deleted).toBe(true);
    const remaining = await service.listSkills();
    expect(remaining.some((skill) => skill.id === created.id)).toBe(false);
  });
});
