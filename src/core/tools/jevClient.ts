/**
 * TypeSafe Jev HTTP client.
 * Jev returns typed decisions (noul / choice / score), not generated text.
 */

export const JEV_KEY_NAME = "TYPESAFE_API_KEY";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: Record<string, string | null>;
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export type JevState = string | Record<string, unknown> | unknown[];

export interface JevEvaluateInput {
  state: JevState;
  questions: Record<string, JevQuestion>;
  model?: string;
  endpoint?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface JevEvaluateResult {
  model: string;
  answers: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export async function resolveJevApiKey(): Promise<string | null> {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const { getCustomKeysService } = await import(
      "../../gateway/services/CustomKeysService.js"
    );
    const service = getCustomKeysService();
    const value = await service.getKeyByName(JEV_KEY_NAME);
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  } catch {
    // Unit tests and processes without the gateway still work via env.
  }

  return null;
}

function assertQuestions(questions: Record<string, JevQuestion>): void {
  const keys = Object.keys(questions);
  if (keys.length === 0) {
    throw new Error("questions must contain at least one typed question");
  }

  for (const [key, question] of Object.entries(questions)) {
    if (!question || typeof question !== "object") {
      throw new Error(`Question '${key}' is invalid`);
    }
    if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length < 2) {
        throw new Error(
          `Question '${key}' (choice) needs at least 2 criteria options`,
        );
      }
    }
    if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
        throw new Error(
          `Question '${key}' (score) needs at least 2 rubric levels`,
        );
      }
    }
  }
}

export function normalizeQuestionType(type: string): JevQuestionType {
  if (type === "boolean" || type === "noul") {
    return "noul";
  }
  if (type === "choice" || type === "score") {
    return type;
  }
  throw new Error(
    `Unsupported Jev question type '${type}'. Use noul, choice, or score.`,
  );
}

export async function evaluateJev(
  input: JevEvaluateInput,
): Promise<JevEvaluateResult> {
  assertQuestions(input.questions);

  const endpoint = input.endpoint ?? JEV_DEFAULT_ENDPOINT;
  const model = input.model ?? JEV_DEFAULT_MODEL;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        state: input.state,
        questions: input.questions,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Jev HTTP ${response.status}: ${rawText.slice(0, 500)}`);
    }

    const parsed = JSON.parse(rawText) as JevEvaluateResult;
    if (!parsed || typeof parsed !== "object" || !parsed.answers) {
      throw new Error("Jev response missing answers");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Jev request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
