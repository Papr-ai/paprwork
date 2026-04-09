import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RecipeService } from "../src/gateway/services/jobs/RecipeService.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

const TEST_JOB_ID = "test-recipe-job-" + Date.now();
const JOBS_ROOT = path.join(os.homedir(), "Papr", "jobs");
const JOB_DIR = path.join(JOBS_ROOT, TEST_JOB_ID);

const SAMPLE_RECIPE = `# Execution Recipe: Test Job

## Intent
Monitor /r/rag for new posts and send personalized welcome DMs.

## Success Criteria
- [ ] New posts detected within the last 24 hours
- [ ] DM sent to each new poster
- [ ] No duplicate DMs sent

## Quality Rubric
| Dimension | Weight | Description |
|-----------|--------|-------------|
| Personalization | 35% | DM references the poster's specific topic |
| Warmth | 25% | Friendly, genuine tone |
| Accuracy | 40% | Correct information about the community |

## Anti-Patterns
- Never use generic copy-paste templates
- Never mention competing communities
- Never be pushy about scheduling

## Edge Cases
- If user has DMs disabled → skip, log reason
- If post is a crosspost → check original sub first
- If poster is a bot → skip silently

## Expected Output
A log of all DMs sent with poster username, post title, and DM content.
`;

describe("RecipeService", () => {
  let service: RecipeService;

  beforeEach(async () => {
    service = new RecipeService();
    await fs.mkdir(JOB_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(JOB_DIR, { recursive: true, force: true });
  });

  describe("Recipe CRUD", () => {
    it("should write and read a recipe", async () => {
      await service.writeRecipe(TEST_JOB_ID, SAMPLE_RECIPE);
      const content = await service.readRecipe(TEST_JOB_ID);
      expect(content).toBe(SAMPLE_RECIPE);
    });

    it("should return null for non-existent recipe", async () => {
      const content = await service.readRecipe("nonexistent-job-id");
      expect(content).toBeNull();
    });

    it("should detect recipe existence", async () => {
      expect(await service.hasRecipe(TEST_JOB_ID)).toBe(false);
      await service.writeRecipe(TEST_JOB_ID, SAMPLE_RECIPE);
      expect(await service.hasRecipe(TEST_JOB_ID)).toBe(true);
    });

    it("should delete a recipe", async () => {
      await service.writeRecipe(TEST_JOB_ID, SAMPLE_RECIPE);
      await service.deleteRecipe(TEST_JOB_ID);
      expect(await service.hasRecipe(TEST_JOB_ID)).toBe(false);
    });
  });

  describe("Recipe Parsing", () => {
    it("should parse intent section", () => {
      const parsed = service.parseRecipe(SAMPLE_RECIPE);
      expect(parsed.intent).toContain("Monitor /r/rag");
    });

    it("should parse success criteria", () => {
      const parsed = service.parseRecipe(SAMPLE_RECIPE);
      expect(parsed.successCriteria).toHaveLength(3);
      expect(parsed.successCriteria[0]).toContain("New posts detected");
    });

    it("should parse quality rubric with weights", () => {
      const parsed = service.parseRecipe(SAMPLE_RECIPE);
      expect(parsed.qualityRubric).toHaveLength(3);

      const personalization = parsed.qualityRubric.find(r => r.dimension === "Personalization");
      expect(personalization).toBeDefined();
      expect(personalization!.weight).toBe(0.35);

      const accuracy = parsed.qualityRubric.find(r => r.dimension === "Accuracy");
      expect(accuracy).toBeDefined();
      expect(accuracy!.weight).toBe(0.40);
    });

    it("should parse anti-patterns", () => {
      const parsed = service.parseRecipe(SAMPLE_RECIPE);
      expect(parsed.antiPatterns).toHaveLength(3);
      expect(parsed.antiPatterns[0]).toContain("generic copy-paste");
    });

    it("should parse edge cases", () => {
      const parsed = service.parseRecipe(SAMPLE_RECIPE);
      expect(parsed.edgeCases).toHaveLength(3);
      expect(parsed.edgeCases[0]).toContain("DMs disabled");
    });

    it("should parse expected output", () => {
      const parsed = service.parseRecipe(SAMPLE_RECIPE);
      expect(parsed.expectedOutput).toContain("log of all DMs");
    });

    it("should handle empty/minimal recipe", () => {
      const parsed = service.parseRecipe("# Minimal Recipe\n\n## Intent\nDo something.");
      expect(parsed.intent).toBe("Do something.");
      expect(parsed.successCriteria).toHaveLength(0);
      expect(parsed.qualityRubric).toHaveLength(0);
    });
  });

  describe("Evaluation Storage", () => {
    it("should save and retrieve evaluations", async () => {
      const evaluation = {
        runId: "run-001",
        jobId: TEST_JOB_ID,
        timestamp: new Date().toISOString(),
        overallScore: 0.85,
        passed: true,
        criteria: [
          { name: "Personalization", score: 0.9, weight: 0.35, passed: true, notes: "Good" },
          { name: "Warmth", score: 0.8, weight: 0.25, passed: true, notes: "Friendly" },
          { name: "Accuracy", score: 0.85, weight: 0.40, passed: true, notes: "Correct" },
        ],
        summary: "Run met quality bar.",
        antiPatternViolations: [],
        edgeCasesHandled: ["DMs disabled - skipped"],
        evaluatorModel: "claude-sonnet-4-6",
        durationMs: 1234,
      };

      await service.saveEvaluation(evaluation);
      const retrieved = await service.getEvaluation(TEST_JOB_ID, "run-001");
      expect(retrieved).toEqual(evaluation);
    });

    it("should list evaluations sorted by timestamp", async () => {
      const base = {
        jobId: TEST_JOB_ID,
        passed: true,
        criteria: [],
        summary: "ok",
        antiPatternViolations: [],
        edgeCasesHandled: [],
        evaluatorModel: "test",
        durationMs: 100,
      };

      await service.saveEvaluation({
        ...base, runId: "run-001", overallScore: 0.7,
        timestamp: "2026-01-01T00:00:00Z",
      });
      await service.saveEvaluation({
        ...base, runId: "run-002", overallScore: 0.9,
        timestamp: "2026-01-02T00:00:00Z",
      });

      const list = await service.listEvaluations(TEST_JOB_ID);
      expect(list).toHaveLength(2);
      expect(list[0].runId).toBe("run-002"); // newest first
      expect(list[0].score).toBe(0.9);
    });

    it("should return empty list for job with no evaluations", async () => {
      const list = await service.listEvaluations(TEST_JOB_ID);
      expect(list).toHaveLength(0);
    });
  });

  describe("Evaluation Prompt Builder", () => {
    it("should build a complete evaluation prompt", () => {
      const parsed = service.parseRecipe(SAMPLE_RECIPE);
      const prompt = service.buildEvaluationPrompt(
        SAMPLE_RECIPE,
        parsed,
        "Sent DM to user123 about their RAG pipeline question",
        "[INFO] Processing post abc123...\n[INFO] DM sent successfully",
      );

      expect(prompt).toContain("Execution Recipe Evaluator");
      expect(prompt).toContain("Personalization");
      expect(prompt).toContain("Sent DM to user123");
      expect(prompt).toContain("DM sent successfully");
      expect(prompt).toContain("0.35"); // weight
    });
  });
});
