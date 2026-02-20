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
  description: "Read one skill by id/name or list all skills",
  inputSchema: readSkillSchema,
  execute: async (input) => {
    const args =
      (input as { context?: z.infer<typeof readSkillSchema> }).context ?? input;
    const { getSkillService } =
      await import("../../gateway/services/SkillService.js");
    const service = getSkillService();

    if (!args.skillId && !args.name) {
      const skills = await service.listSkills();
      return { success: true, data: skills };
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
