import { getRecipeService } from "./RecipeService.js";
import type {
  RecipeEvaluation,
  RecipeEvalCriterion,
  JobRecord,
} from "./types.js";

/**
 * Evaluates a job run against its execution recipe using an LLM.
 * Called automatically after job completion when recipe.autoEvaluate is true.
 */
export async function evaluateJobRun(
  job: JobRecord,
  runId: string,
  jobOutput: string,
  jobLogs: string,
): Promise<RecipeEvaluation | null> {
  const recipeService = getRecipeService();
  const recipe = await recipeService.readRecipe(job.id);
  if (!recipe || !job.recipe?.enabled) return null;

  const startTime = performance.now();
  const parsedRecipe = recipeService.parseRecipe(recipe);

  // If no rubric dimensions defined, create a default one
  if (parsedRecipe.qualityRubric.length === 0) {
    parsedRecipe.qualityRubric = [
      {
        dimension: "Intent Fulfillment",
        weight: 0.5,
        description: "Did the job accomplish what the recipe intended?",
      },
      {
        dimension: "Output Quality",
        weight: 0.3,
        description: "Is the output complete and well-formed?",
      },
      {
        dimension: "Error Handling",
        weight: 0.2,
        description: "Were errors handled gracefully?",
      },
    ];
  }

  const evalPrompt = recipeService.buildEvaluationPrompt(
    recipe,
    parsedRecipe,
    jobOutput,
    jobLogs,
  );

  try {
    const { getAgentService } = await import("../AgentService.js");
    const agentService = getAgentService();

    // Use structured output for reliable JSON parsing
    const evalSchema = {
      type: "object" as const,
      properties: {
        overallScore: { type: "number" as const },
        criteria: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              name: { type: "string" as const },
              score: { type: "number" as const },
              weight: { type: "number" as const },
              passed: { type: "boolean" as const },
              notes: { type: "string" as const },
            },
            required: ["name", "score", "weight", "passed", "notes"],
          },
        },
        summary: { type: "string" as const },
        antiPatternViolations: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        edgeCasesHandled: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: [
        "overallScore",
        "criteria",
        "summary",
        "antiPatternViolations",
        "edgeCasesHandled",
      ],
    };

    // Resolve evaluator model (recipe config > job config > system default)
    const provider = (job.recipe?.evaluatorProvider ?? job.provider) as
      | "openai"
      | "anthropic"
      | "google"
      | "ollama"
      | undefined;
    const model = job.recipe?.evaluatorModel ?? job.model;

    const result = await agentService.runStructuredJobSession({
      jobId: job.id,
      runId: `eval-${runId}`,
      prompt: evalPrompt,
      outputSchema: evalSchema,
      schemaName: "recipe_evaluation",
      schemaDescription: "Execution recipe evaluation result",
      provider,
      model,
    });

    const evalResult = result.object as {
      overallScore: number;
      criteria: RecipeEvalCriterion[];
      summary: string;
      antiPatternViolations: string[];
      edgeCasesHandled: string[];
    };

    const passThreshold = job.recipe?.passThreshold ?? 0.7;
    const durationMs = performance.now() - startTime;

    const evaluation: RecipeEvaluation = {
      runId,
      jobId: job.id,
      timestamp: new Date().toISOString(),
      overallScore: evalResult.overallScore,
      passed: evalResult.overallScore >= passThreshold,
      criteria: evalResult.criteria,
      summary: evalResult.summary,
      antiPatternViolations: evalResult.antiPatternViolations,
      edgeCasesHandled: evalResult.edgeCasesHandled,
      evaluatorModel: model ?? "default",
      durationMs,
    };

    // Persist the evaluation
    await recipeService.saveEvaluation(evaluation);

    console.log(
      `[RecipeEvaluator] Job ${job.id} run ${runId}: score=${evaluation.overallScore.toFixed(2)} passed=${evaluation.passed} (${durationMs.toFixed(0)}ms)`,
    );

    return evaluation;
  } catch (error) {
    console.error(
      `[RecipeEvaluator] Failed to evaluate job ${job.id} run ${runId}:`,
      error,
    );
    return null;
  }
}
