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
import { PRODUCT_ARCHITECT_PLAN_REMINDER } from "../utils/productArchitectGate.js";

const planStepSchema = z.object({
  id: z.string().min(1).describe("Unique step identifier (e.g., 'load_docs', 'create_ui')"),
  description: z.string().min(1).describe("Step description (e.g., 'Load design system and docs')"),
});

const createPlanSchema = z.object({
  chatId: z
    .string()
    .min(1)
    .optional()
    .describe("Chat ID (auto-detected if not provided)"),
  title: z.string().min(1).describe("Plan title (e.g., 'Build Dashboard App')"),
  steps: z.array(planStepSchema).min(1).describe("Array of step objects. Each step must be an object with 'id' and 'description' fields. Example: [{ id: 'design', description: 'Design UI' }, { id: 'build', description: 'Build components' }]"),
});

const STATUS_ALIASES: Record<string, PlanStep["status"]> = {
  pending: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  started: "in_progress",
  working: "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  finished: "completed",
  skipped: "skipped",
  skip: "skipped",
};

/** Accept stepId or id — models often reuse create_plan's `id` field name. */
const stepUpdateSchema = z
  .object({
    stepId: z
      .string()
      .min(1)
      .optional()
      .describe("Step id from create_plan"),
    id: z
      .string()
      .min(1)
      .optional()
      .describe("Same as stepId (alias matching create_plan step objects)"),
    status: z.string().min(1),
  })
  .superRefine((val, ctx) => {
    const sid = val.stepId?.trim() || val.id?.trim();
    if (!sid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Provide stepId or id (must match a step id from create_plan)",
        path: ["stepId"],
      });
    }
  })
  .transform((val): { stepId: string; status: PlanStep["status"] } => {
    const stepId = (val.stepId?.trim() || val.id?.trim()) as string;
    const normalized = STATUS_ALIASES[val.status.toLowerCase().trim()];
    return {
      stepId,
      status: normalized ?? "pending",
    };
  });

const updatePlanSchema = z.object({
  planId: z.string().min(1).describe("Plan ID returned by create_plan"),
  updates: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        try { val = JSON.parse(val); } catch { /* leave as-is */ }
      }
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return [val];
      }
      return val;
    },
    z.array(stepUpdateSchema).min(1),
  ).describe("Step status updates"),
});

const deletePlanSchema = z.object({
  planId: z.string().min(1).describe("Plan ID to delete"),
});

type CreatePlanArgs = z.infer<typeof createPlanSchema>;
type UpdatePlanArgs = z.infer<typeof updatePlanSchema>;
type DeletePlanArgs = z.infer<typeof deletePlanSchema>;

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
    "REQUIRED for any multi-step task, especially app/job creation or updates. Create a step-by-step plan shown to the user as a progress card. Plans are persisted and associated with the chat. Use BEFORE starting any mini-app or job work (creating OR updating). " +
    "**Recommendation (not required):** If you have not run product-architect yet, consider delegating for a brief + architecture before building — then align this plan with approved Phase 1. " +
    "**ENFORCED: Only ONE active plan per chat** - if an active plan exists, this tool will return it instead of creating a duplicate. To start a new plan, first complete or delete the existing one using update_plan (mark all steps completed) or delete_plan. " +
    "Example: create_plan({ title: 'Build Dashboard', steps: [{ id: 'design', description: 'Design UI layout' }, { id: 'build', description: 'Build components' }] })",
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

    // CHECK FOR EXISTING ACTIVE PLAN (enforcement)
    const activePlans = await planService.getActivePlansForChat(chatId);
    if (activePlans.length > 0) {
      const existingPlan = activePlans[0];
      const completedCount = existingPlan.steps.filter(
        (s) => s.status === "completed" || s.status === "skipped"
      ).length;
      
      console.log(
        `[create_plan] Active plan already exists for chat ${chatId}: "${existingPlan.title}" (${existingPlan.planId}). Returning existing plan instead of creating duplicate.`
      );
      
      const message = `⚠ Active plan already exists: "${existingPlan.title}" (${completedCount}/${existingPlan.steps.length} steps complete)\nPlan ID: ${existingPlan.planId}\n\nUse update_plan to mark progress on this plan, or delete_plan to remove it and start fresh.\n\nExisting steps:\n${existingPlan.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.description}`).join('\n')}`;
      
      return JSON.stringify({
        success: false,
        existingPlan: true,
        message,
        data: existingPlan,
      });
    }

    // No active plan exists, create new one
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

    // Return formatted message for LLM + data for UI
    // The message is shown to the agent, data is parsed by PlanCard
    const message =
      `✓ Plan created: "${args.title}" with ${steps.length} steps\nPlan ID: ${planId}\n\nNext: Start working on the first step, then call update_plan after completing each step.\n\n${PRODUCT_ARCHITECT_PLAN_REMINDER}`;

    return JSON.stringify({
      success: true,
      message,
      data: plan,
      _architectReminder: PRODUCT_ARCHITECT_PLAN_REMINDER,
    });
  },
});

export const updatePlanTool = createTool({
  id: "update_plan",
  description:
    "Update step statuses in an existing plan. CRITICAL: Call this AFTER EACH STEP completes, not at the end. This shows real-time progress to the user. Mark steps as in_progress when starting, completed when done. Plans are persisted to disk. Each update must include the step id: use `id` or `stepId` — same value as each step's `id` from create_plan.",
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

    const validStepIds = plan.steps.map((s) => s.id);
    const matched: string[] = [];
    const unmatched: string[] = [];

    for (const update of args.updates) {
      const step = plan.steps.find((s) => s.id === update.stepId);
      if (step) {
        step.status = update.status;
        matched.push(`${update.stepId} → ${update.status}`);
      } else {
        unmatched.push(update.stepId);
      }
    }

    if (unmatched.length > 0) {
      console.warn(
        `[update_plan] Step ID mismatch for plan ${args.planId}: ` +
          `provided=[${unmatched.join(", ")}], valid=[${validStepIds.join(", ")}]`,
      );
    }

    if (matched.length > 0) {
      console.log(
        `[update_plan] Updated ${matched.length} step(s): ${matched.join(", ")}`,
      );
    }

    // Only write to DB if at least one step was actually updated
    let updatedPlan: Plan | null = plan as Plan;
    if (matched.length > 0) {
      const allCompleted = plan.steps.every(
        (s) => s.status === "completed" || s.status === "skipped",
      );

      updatedPlan = await planService.updatePlan(args.planId, plan.steps);

      if (allCompleted && updatedPlan) {
        await planService.updatePlanStatus(args.planId, "completed");
        updatedPlan.status = "completed";
      }
    }

    const completedCount = plan.steps.filter(
      (s) => s.status === "completed" || s.status === "skipped",
    ).length;

    const parts: string[] = [];
    if (matched.length > 0) {
      parts.push(`Updated: ${matched.join(", ")}`);
    }
    if (unmatched.length > 0) {
      parts.push(
        `WARNING: stepId(s) not found: [${unmatched.join(", ")}]. Valid IDs are: [${validStepIds.join(", ")}]`,
      );
    }
    parts.push(`Progress: ${completedCount}/${plan.steps.length} complete`);

    const allDone = plan.steps.every(
      (s) => s.status === "completed" || s.status === "skipped",
    );

    const message = `${matched.length > 0 ? "✓" : "⚠"} Plan "${plan.title}" — ${parts.join(". ")}${allDone ? " (All done!)" : ""}`;

    return JSON.stringify({
      success: matched.length > 0,
      message,
      data: updatedPlan,
    });
  },
});

export const deletePlanTool = createTool({
  id: "delete_plan",
  description:
    "Delete an existing plan to start fresh. Use this when you need to create a completely new plan but there's already an active plan for this chat. After deleting, you can call create_plan to start a new plan. Only delete plans when explicitly needed - if you just want to update the approach, use update_plan instead.",
  inputSchema: deletePlanSchema,
  execute: async (input) => {
    const args = (input as { context?: DeletePlanArgs }).context ?? input;
    const { getPlanService } =
      await import("../../gateway/services/PlanService.js");
    const planService = getPlanService();
    await planService.initialize();

    const plan = await planService.getPlan(args.planId);
    if (!plan) {
      return JSON.stringify({
        success: false,
        message: `Plan not found: ${args.planId}`,
      });
    }

    const deleted = await planService.deletePlan(args.planId);
    
    if (deleted) {
      console.log(`[delete_plan] Deleted plan ${args.planId}: "${plan.title}"`);
      return JSON.stringify({
        success: true,
        message: `✓ Plan deleted: "${plan.title}"\n\nYou can now create a new plan with create_plan.`,
        data: {
          planId: args.planId,
          title: plan.title,
          steps: plan.steps,
          deleted: true,
        },
      });
    } else {
      return JSON.stringify({
        success: false,
        message: `Failed to delete plan: ${args.planId}`,
      });
    }
  },
});

export const planningTools = [createPlanTool, updatePlanTool, deletePlanTool];
