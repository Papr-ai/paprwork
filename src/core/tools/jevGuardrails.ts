/**
 * Input limits for jev_decide — keep state small and questions bounded.
 * Aligns with TypeSafe System One usage (compact state, typed questions).
 */

import type { JevQuestion, JevState } from "./jevClient.js";

/** ~8k tokens of state is plenty for triage; prevents dumping full chats. */
export const JEV_MAX_STATE_CHARS = 32_000;

export const JEV_MAX_QUESTIONS = 20;

export const JEV_MAX_QUESTION_KEY_CHARS = 64;

export const JEV_MAX_INSTRUCTIONS_CHARS = 4_000;

/** TypeSafe UI catalog allows up to 255 choice labels. */
export const JEV_MAX_CHOICE_OPTIONS = 255;

export const JEV_MAX_SCORE_LEVELS = 32;

export const JEV_MAX_CRITERION_CHARS = 512;

function stateCharLength(state: JevState): number {
  if (typeof state === "string") {
    return state.length;
  }
  try {
    return JSON.stringify(state).length;
  } catch {
    throw new Error("state must be a string, JSON object, or JSON array");
  }
}

function assertNonEmptyState(state: JevState): void {
  if (typeof state === "string") {
    if (state.trim().length === 0) {
      throw new Error("state must not be empty — pass only the text needed for the questions");
    }
    return;
  }
  if (Array.isArray(state)) {
    if (state.length === 0) {
      throw new Error("state array must not be empty");
    }
    return;
  }
  if (state && typeof state === "object") {
    if (Object.keys(state).length === 0) {
      throw new Error("state object must not be empty");
    }
    return;
  }
  throw new Error("state must be a string, object, or array");
}

export function assertJevInputWithinGuardrails(input: {
  state: JevState;
  questions: Record<string, JevQuestion>;
}): { stateChars: number; questionCount: number } {
  assertNonEmptyState(input.state);

  const stateChars = stateCharLength(input.state);
  if (stateChars > JEV_MAX_STATE_CHARS) {
    throw new Error(
      `state is ${stateChars} chars (max ${JEV_MAX_STATE_CHARS}). ` +
        "Summarize or extract only the fields Jev needs — do not paste the full chat.",
    );
  }

  const questionKeys = Object.keys(input.questions);
  if (questionKeys.length === 0) {
    throw new Error("questions must contain at least one typed question");
  }
  if (questionKeys.length > JEV_MAX_QUESTIONS) {
    throw new Error(
      `Too many questions (${questionKeys.length}, max ${JEV_MAX_QUESTIONS}). ` +
        "Split into multiple jev_decide calls or drop low-value gates.",
    );
  }

  for (const key of questionKeys) {
    if (key.length > JEV_MAX_QUESTION_KEY_CHARS) {
      throw new Error(`Question key '${key.slice(0, 20)}…' exceeds ${JEV_MAX_QUESTION_KEY_CHARS} chars`);
    }
    const q = input.questions[key];
    if (q.instructions.length > JEV_MAX_INSTRUCTIONS_CHARS) {
      throw new Error(`Question '${key}' instructions exceed ${JEV_MAX_INSTRUCTIONS_CHARS} chars`);
    }
    if (q.type === "choice") {
      const options = Object.keys(q.criteria ?? {});
      if (options.length > JEV_MAX_CHOICE_OPTIONS) {
        throw new Error(
          `Question '${key}' has ${options.length} choice options (max ${JEV_MAX_CHOICE_OPTIONS})`,
        );
      }
      for (const [opt, def] of Object.entries(q.criteria ?? {})) {
        if (opt.length > JEV_MAX_CRITERION_CHARS || (def && def.length > JEV_MAX_CRITERION_CHARS)) {
          throw new Error(`Question '${key}' choice label/definition too long (max ${JEV_MAX_CRITERION_CHARS} chars)`);
        }
      }
    }
    if (q.type === "score") {
      if (q.criteria.length > JEV_MAX_SCORE_LEVELS) {
        throw new Error(
          `Question '${key}' has ${q.criteria.length} score levels (max ${JEV_MAX_SCORE_LEVELS})`,
        );
      }
      for (const level of q.criteria) {
        if (level.length > JEV_MAX_CRITERION_CHARS) {
          throw new Error(`Question '${key}' score level text too long (max ${JEV_MAX_CRITERION_CHARS} chars)`);
        }
      }
    }
  }

  return { stateChars, questionCount: questionKeys.length };
}
