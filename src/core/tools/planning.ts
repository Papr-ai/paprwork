/**
 * Planning Tools - create_plan / update_plan
 *
 * Allows the agent to create and update step-by-step plans
 * that render as PlanCards in the UI.
 *
 * Plans are persisted to SQLite and associated with chatId so:
 * - Plans survive app restarts
 * - Agent can resume where it left off
 * - Plan history is maintained per chat
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const planStepSchema = z.object({
  id: z.string().min(1).describe("Unique step identifier"),
  description: z.string().min(1).describe("Step description"),
});

const createPlanSchema = z.object({
  chatId: z
    .string()
    .min(1)
    .optional()
    .describe("Chat ID (auto-detected if not provided)"),
  title: z.string().min(1).describe("Plan title"),
  steps: z.array(planStepSchema).min(1).describe("Ordered plan steps"),
});

const stepUpdateSchema = z.object({
  stepId: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "skipped"]),
});

const updatePlanSchema = z.object({
  planId: z.string().min(1).describe("Plan ID returned by create_plan"),
  updates: z.array(stepUpdateSchema).min(1).describe("Step status updates"),
});

type CreatePlanArgs = z.infer<typeof createPlanSchema>;
type UpdatePlanArgs = z.infer<typeof updatePlanSchema>;

// Re-export types for compatibility
export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}

export interface Plan {
  planId: string;
  chatId: string;
  title: string;
  steps: PlanStep[];
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export const createPlanTool = createTool({
  id: "create_plan",
  description:
    "Create a step-by-step plan that will be shown to the user as a progress card. Plans are persisted and associated with the chat. Returns the plan with step statuses.",
  inputSchema: createPlanSchema,
  execute: async (input) => {
    const args = (input as { context?: CreatePlanArgs }).context ?? input;
    const { getPlanService } =
      await import("../../gateway/services/PlanService.js");
    const { getCurrentChatId } = await import("./context.js");

    const planService = getPlanService();
    await planService.initialize();

    // Get chatId from args or ambient context
    const chatId = args.chatId || getCurrentChatId();
    if (!chatId) {
      throw new Error(
        "chatId is required but not provided and not available in context",
      );
    }

    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const steps: PlanStep[] = args.steps.map((s) => ({
      id: s.id,
      description: s.description,
      status: "pending" as const,
    }));

    const plan = await planService.createPlan(
      planId,
      chatId,
      args.title,
      steps,
    );

    return {
      success: true,
      data: plan,
    };
  },
});

export const updatePlanTool = createTool({
  id: "update_plan",
  description:
    "Update step statuses in an existing plan. Use this to mark steps as in_progress, completed, or skipped. Plans are persisted to disk.",
  inputSchema: updatePlanSchema,
  execute: async (input) => {
    const args = (input as { context?: UpdatePlanArgs }).context ?? input;
    const { getPlanService } =
      await import("../../gateway/services/PlanService.js");
    const planService = getPlanService();
    await planService.initialize();

    const plan = await planService.getPlan(args.planId);
    if (!plan) {
      throw new Error(`Plan not found: ${args.planId}`);
    }

    // Update step statuses
    for (const update of args.updates) {
      const step = plan.steps.find((s) => s.id === update.stepId);
      if (step) {
        step.status = update.status;
      }
    }

    // Check if all steps are completed
    const allCompleted = plan.steps.every(
      (s) => s.status === "completed" || s.status === "skipped",
    );

    // Update plan in database
    const updatedPlan = await planService.updatePlan(args.planId, plan.steps);

    // Mark plan as completed if all steps are done
    if (allCompleted && updatedPlan) {
      await planService.updatePlanStatus(args.planId, "completed");
      updatedPlan.status = "completed";
    }

    return {
      success: true,
      data: updatedPlan,
    };
  },
});

export const planningTools = [createPlanTool, updatePlanTool];
