import { promises as fs } from "fs";
import path from "path";
import { getPaprJobsRoot } from "../../../core/utils/paprRoot.js";
import type {
  RecipeEvaluation,
  RecipeEvaluationSummary,
} from "./types.js";

const RECIPE_FILENAME = "recipe.md";
const EVALUATIONS_DIR = "evaluations";

let recipeServiceInstance: RecipeService | null = null;

export function getRecipeService(): RecipeService {
  if (!recipeServiceInstance) {
    recipeServiceInstance = new RecipeService();
  }
  return recipeServiceInstance;
}

export class RecipeService {
  private jobsRootDir: string;

  constructor() {
    this.jobsRootDir = getPaprJobsRoot();
  }

  private getJobDir(jobId: string): string {
    return path.join(this.jobsRootDir, jobId);
  }

  private getRecipePath(jobId: string): string {
    return path.join(this.getJobDir(jobId), RECIPE_FILENAME);
  }

  private getEvaluationsDir(jobId: string): string {
    return path.join(this.getJobDir(jobId), EVALUATIONS_DIR);
  }

  // ─── Recipe CRUD ─────────────────────────────────────────────────────────

  async writeRecipe(jobId: string, markdown: string): Promise<void> {
    const recipePath = this.getRecipePath(jobId);
    await fs.writeFile(recipePath, markdown, "utf8");
  }

  async readRecipe(jobId: string): Promise<string | null> {
    try {
      return await fs.readFile(this.getRecipePath(jobId), "utf8");
    } catch {
      return null;
    }
  }

  async hasRecipe(jobId: string): Promise<boolean> {
    try {
      await fs.access(this.getRecipePath(jobId));
      return true;
    } catch {
      return false;
    }
  }

  async deleteRecipe(jobId: string): Promise<void> {
    try {
      await fs.unlink(this.getRecipePath(jobId));
    } catch {
      // Ignore if doesn't exist
    }
  }

  // ─── Evaluation Storage ──────────────────────────────────────────────────

  async saveEvaluation(evaluation: RecipeEvaluation): Promise<void> {
    const evalDir = this.getEvaluationsDir(evaluation.jobId);
    await fs.mkdir(evalDir, { recursive: true });
    const evalPath = path.join(evalDir, `${evaluation.runId}.json`);
    await fs.writeFile(evalPath, JSON.stringify(evaluation, null, 2), "utf8");
  }

  async getEvaluation(
    jobId: string,
    runId: string,
  ): Promise<RecipeEvaluation | null> {
    try {
      const evalPath = path.join(this.getEvaluationsDir(jobId), `${runId}.json`);
      const content = await fs.readFile(evalPath, "utf8");
      return JSON.parse(content) as RecipeEvaluation;
    } catch {
      return null;
    }
  }

  async listEvaluations(jobId: string): Promise<RecipeEvaluationSummary[]> {
    const evalDir = this.getEvaluationsDir(jobId);
    try {
      const files = await fs.readdir(evalDir);
      const summaries: RecipeEvaluationSummary[] = [];
      for (const file of files.filter((f) => f.endsWith(".json"))) {
        try {
          const content = await fs.readFile(path.join(evalDir, file), "utf8");
          const eval_ = JSON.parse(content) as RecipeEvaluation;
          summaries.push({
            runId: eval_.runId,
            score: eval_.overallScore,
            passed: eval_.passed,
            timestamp: eval_.timestamp,
          });
        } catch {
          // Skip corrupt files
        }
      }
      return summaries.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
    } catch {
      return [];
    }
  }

  // ─── Recipe Parsing ──────────────────────────────────────────────────────

  /** Parse a recipe.md into structured sections for the evaluator */
  parseRecipe(markdown: string): ParsedRecipe {
    const sections: ParsedRecipe = {
      intent: "",
      successCriteria: [],
      qualityRubric: [],
      antiPatterns: [],
      edgeCases: [],
      expectedOutput: "",
    };

    let currentSection = "";
    const lines = markdown.split("\n");

    for (const line of lines) {
      const headerMatch = line.match(/^##\s+(.+)/);
      if (headerMatch) {
        const header = headerMatch[1].toLowerCase().trim();
        if (header.includes("intent") || header.includes("purpose")) {
          currentSection = "intent";
        } else if (header.includes("success") || header.includes("criteria")) {
          currentSection = "criteria";
        } else if (header.includes("quality") || header.includes("rubric")) {
          currentSection = "rubric";
        } else if (header.includes("anti-pattern") || header.includes("antipattern")) {
          currentSection = "antipatterns";
        } else if (header.includes("edge case")) {
          currentSection = "edgecases";
        } else if (header.includes("expected") || header.includes("output")) {
          currentSection = "output";
        }
        continue;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      switch (currentSection) {
        case "intent":
          sections.intent += (sections.intent ? "\n" : "") + trimmed;
          break;
        case "criteria": {
          const criterionMatch = trimmed.match(/^-\s*\[.\]\s*(.+)/);
          if (criterionMatch) {
            sections.successCriteria.push(criterionMatch[1]);
          }
          break;
        }
        case "rubric": {
          const rubricMatch = trimmed.match(
            /^\|\s*([^|]+)\s*\|\s*(\d+)%?\s*\|\s*([^|]+)\s*\|/,
          );
          if (rubricMatch && !rubricMatch[1].includes("---")) {
            sections.qualityRubric.push({
              dimension: rubricMatch[1].trim(),
              weight: parseInt(rubricMatch[2], 10) / 100,
              description: rubricMatch[3].trim(),
            });
          }
          break;
        }
        case "antipatterns": {
          const apMatch = trimmed.match(/^-\s+(.+)/);
          if (apMatch) sections.antiPatterns.push(apMatch[1]);
          break;
        }
        case "edgecases": {
          const ecMatch = trimmed.match(/^-\s+(.+)/);
          if (ecMatch) sections.edgeCases.push(ecMatch[1]);
          break;
        }
        case "output":
          sections.expectedOutput +=
            (sections.expectedOutput ? "\n" : "") + trimmed;
          break;
      }
    }

    return sections;
  }

  // ─── Evaluation Prompt Builder ───────────────────────────────────────────

  /** Build the evaluation prompt for the evaluator agent */
  buildEvaluationPrompt(
    recipe: string,
    parsedRecipe: ParsedRecipe,
    jobOutput: string,
    jobLogs: string,
  ): string {
    return `You are an Execution Recipe Evaluator. Your job is to evaluate a job run against its recipe spec.

## The Recipe
${recipe}

## Job Output
\`\`\`
${jobOutput.slice(0, 16000)}
\`\`\`

## Job Logs (last 8KB)
\`\`\`
${jobLogs.slice(-8000)}
\`\`\`

## Your Task
Evaluate this run against the recipe. Return a JSON object with this exact structure:

{
  "overallScore": <number 0-1>,
  "criteria": [
${parsedRecipe.qualityRubric
  .map(
    (r) =>
      `    { "name": "${r.dimension}", "score": <number 0-1>, "weight": ${r.weight}, "passed": <boolean>, "notes": "<brief explanation>" }`,
  )
  .join(",\n")}
  ],
  "summary": "<2-3 sentence summary of the evaluation>",
  "antiPatternViolations": [<list of any anti-patterns that were violated, or empty array>],
  "edgeCasesHandled": [<list of edge cases that were properly handled, or empty array>]
}

${parsedRecipe.successCriteria.length > 0 ? `\n## Success Criteria to Check\n${parsedRecipe.successCriteria.map((c) => `- ${c}`).join("\n")}` : ""}

${parsedRecipe.antiPatterns.length > 0 ? `\n## Anti-Patterns to Watch For\n${parsedRecipe.antiPatterns.map((a) => `- ${a}`).join("\n")}` : ""}

Respond with ONLY the JSON object, no markdown fencing.`;
  }
}

export interface ParsedRecipe {
  intent: string;
  successCriteria: string[];
  qualityRubric: RubricEntry[];
  antiPatterns: string[];
  edgeCases: string[];
  expectedOutput: string;
}

export interface RubricEntry {
  dimension: string;
  weight: number;
  description: string;
}
