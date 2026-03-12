import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const readSkillSchema = z.object({
  skillId: z.string().optional(),
  name: z.string().optional(),
});

const createSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string().min(1),
});

export const readSkillTool = createTool({
  id: "read_skill",
  description:
    "Read a skill's full content by ID/name, or list ALL installed skills. Call with NO arguments to discover all 26+ available skills (returns just name/description). Example: read_skill() returns directory, read_skill({ skillId: 'preloaded-social-media-auth' }) loads full content.",
  inputSchema: readSkillSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof readSkillSchema> }).context ?? input;
    const { getSkillService } =
      await import("../../gateway/services/SkillService.js");
    const service = getSkillService();

    if (!args.skillId && !args.name) {
      // List mode: Return summary without full content
      const skills = await service.listSkills();
      const summary = skills
        .filter((s) => s.enabled)
        .map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          enabled: s.enabled,
          source: s.source,
        }));
      return { success: true, data: summary, count: summary.length };
    }

    if (args.skillId) {
      const skill = await service.getSkill(args.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${args.skillId}`);
      }
      return { success: true, data: skill };
    }

    const skills = await service.listSkills();
    const skill = skills.find((item) => item.name === args.name);
    if (!skill) {
      throw new Error(`Skill not found by name: ${args.name}`);
    }
    return { success: true, data: skill };
  },
});

export const createSkillTool = createTool({
  id: "create_skill",
  description: "Create a new reusable skill",
  inputSchema: createSkillSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof createSkillSchema> }).context ??
      input;
    const { getSkillService } =
      await import("../../gateway/services/SkillService.js");
    const service = getSkillService();
    const skill = await service.createSkill({
      name: args.name,
      description: args.description ?? "",
      content: args.content,
    });
    return { success: true, data: skill };
  },
});

export const skillsTools = [readSkillTool, createSkillTool];
