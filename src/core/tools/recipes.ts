import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const writeRecipeSchema = z.object({
  jobId: z
    .string()
    .min(1)
    .describe("The job ID to attach the execution recipe to"),
  markdown: z
    .string()
    .min(10)
    .describe(
      "The full recipe markdown. Must include ## Intent, ## Success Criteria, ## Quality Rubric, " +
        "## Anti-Patterns, ## Edge Cases, ## Expected Output sections.",
    ),
  autoEvaluate: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Automatically evaluate each run against this recipe on completion",
    ),
  passThreshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.7)
    .describe("Minimum score (0-1) for a run to pass evaluation"),
});

const readRecipeSchema = z.object({
  jobId: z
    .string()
    .min(1)
    .describe("The job ID to read the execution recipe for"),
});

const evaluateRunSchema = z.object({
  jobId: z
    .string()
    .min(1)
    .describe("The job ID to evaluate"),
  runId: z
    .string()
    .optional()
    .describe(
      "Specific run ID to evaluate. Defaults to the last run.",
    ),
});

const listEvaluationsSchema = z.object({
  jobId: z
    .string()
    .min(1)
    .describe("The job ID to list evaluations for"),
});

type WriteRecipeArgs = z.infer<typeof writeRecipeSchema>;
type ReadRecipeArgs = z.infer<typeof readRecipeSchema>;
type EvaluateRunArgs = z.infer<typeof evaluateRunSchema>;
type ListEvaluationsArgs = z.infer<typeof listEvaluationsSchema>;

// ─── Tools ────────────────────────────────────────────────────────────────────

export const writeRecipeTool = createTool({
  id: "write_recipe",
  description:
    "Write an execution recipe for a job. The recipe defines intent, success criteria, " +
    "quality rubric, anti-patterns, and edge cases. When autoEvaluate is true, an agent " +
    "will automatically score each run against the recipe after completion. " +
    "Use this to ensure jobs consistently meet quality standards.",
  inputSchema: writeRecipeSchema,
  execute: async (input) => {
    const args = (input as { context?: WriteRecipeArgs }).context ?? input;
    const { getRecipeService } = await import(
      "../../gateway/services/jobs/RecipeService.js"
    );
    const { getJobsService } = await import(
      "../../gateway/services/JobsService.js"
    );

    const recipeService = getRecipeService();
    const jobsService = getJobsService();
    await jobsService.initialize();

    // Verify job exists
    const job = await jobsService.getJob(args.jobId);
    if (!job) {
      return { success: false, error: `Job not found: ${args.jobId}` };
    }

    // Write the recipe markdown
    await recipeService.writeRecipe(args.jobId, args.markdown);

    // Update job record with recipe config
    await jobsService.updateJob(args.jobId, {
      recipe: {
        enabled: true,
        autoEvaluate: args.autoEvaluate ?? true,
        passThreshold: args.passThreshold ?? 0.7,
      },
    });

    // Parse to validate structure
    const parsed = recipeService.parseRecipe(args.markdown);
    const warnings: string[] = [];
    if (!parsed.intent) warnings.push("Missing ## Intent section");
    if (parsed.successCriteria.length === 0)
      warnings.push("No success criteria found (use - [ ] checkboxes)");
    if (parsed.qualityRubric.length === 0)
      warnings.push(
        "No quality rubric found (will use default 3-dimension rubric)",
      );

    return {
      success: true,
      data: {
        jobId: args.jobId,
        jobName: job.name,
        recipeSections: {
          intent: !!parsed.intent,
          successCriteria: parsed.successCriteria.length,
          qualityRubric: parsed.qualityRubric.length,
          antiPatterns: parsed.antiPatterns.length,
          edgeCases: parsed.edgeCases.length,
          expectedOutput: !!parsed.expectedOutput,
        },
        autoEvaluate: args.autoEvaluate ?? true,
        passThreshold: args.passThreshold ?? 0.7,
        warnings,
      },
    };
  },
});

export const readRecipeTool = createTool({
  id: "read_recipe",
  description:
    "Read a job's execution recipe. Returns the full markdown content and parsed structure.",
  inputSchema: readRecipeSchema,
  execute: async (input) => {
    const args = (input as { context?: ReadRecipeArgs }).context ?? input;
    const { getRecipeService } = await import(
      "../../gateway/services/jobs/RecipeService.js"
    );
    const recipeService = getRecipeService();

    const markdown = await recipeService.readRecipe(args.jobId);
    if (!markdown) {
      return {
        success: false,
        error: `No execution recipe found for job ${args.jobId}`,
      };
    }

    const parsed = recipeService.parseRecipe(markdown);
    return {
      success: true,
      data: {
        jobId: args.jobId,
        markdown,
        parsed,
      },
    };
  },
});

export const evaluateRunTool = createTool({
  id: "evaluate_run",
  description:
    "Manually trigger evaluation of a job run against its execution recipe. " +
    "Returns detailed scoring across all rubric dimensions. " +
    "Use when autoEvaluate is off, or to re-evaluate a specific run.",
  inputSchema: evaluateRunSchema,
  execute: async (input) => {
    const args = (input as { context?: EvaluateRunArgs }).context ?? input;
    const { getJobsService } = await import(
      "../../gateway/services/JobsService.js"
    );
    const { evaluateJobRun } = await import(
      "../../gateway/services/jobs/RecipeEvaluator.js"
    );

    const jobsService = getJobsService();
    await jobsService.initialize();

    const job = await jobsService.getJob(args.jobId);
    if (!job) {
      return { success: false, error: `Job not found: ${args.jobId}` };
    }

    const runId = args.runId ?? job.lastExecutionId;
    if (!runId) {
      return { success: false, error: "No run ID available. Job hasn't run yet." };
    }

    // Get job output and logs
    const logs = await jobsService.getLogs(args.jobId, 32000);
    const output = job.lastOutput ?? "";

    const evaluation = await evaluateJobRun(job, runId, output, logs);
    if (!evaluation) {
      return {
        success: false,
        error: "Evaluation failed. Check that the job has a recipe with recipe.enabled=true.",
      };
    }

    return {
      success: true,
      data: evaluation,
    };
  },
});

export const listEvaluationsTool = createTool({
  id: "list_evaluations",
  description:
    "List all evaluation results for a job. Shows score history across runs.",
  inputSchema: listEvaluationsSchema,
  execute: async (input) => {
    const args = (input as { context?: ListEvaluationsArgs }).context ?? input;
    const { getRecipeService } = await import(
      "../../gateway/services/jobs/RecipeService.js"
    );

    const recipeService = getRecipeService();
    const evaluations = await recipeService.listEvaluations(args.jobId);

    return {
      success: true,
      data: {
        jobId: args.jobId,
        totalEvaluations: evaluations.length,
        evaluations,
        averageScore:
          evaluations.length > 0
            ? evaluations.reduce((sum, e) => sum + e.score, 0) /
              evaluations.length
            : null,
        passRate:
          evaluations.length > 0
            ? evaluations.filter((e) => e.passed).length / evaluations.length
            : null,
      },
    };
  },
});

export const recipeTools = [
  writeRecipeTool,
  readRecipeTool,
  evaluateRunTool,
  listEvaluationsTool,
];
