/**
 * Coaching copy for the freeform "Something else" prompt.
 *
 * Ported from the onboarding redesign prototype (content-chat.ts). The tips
 * reveal progressively as the sentence grows: the point is to teach what a
 * good automation request contains WHILE the user writes it, rather than
 * rejecting a bad prompt afterwards.
 */

/** `at` = characters typed before the tip appears. */
export const PROMPT_TIPS = [
  { at: 0, tip: "Start with what you want to happen, not what you want to build." },
  { at: 12, tip: "Add how often — daily, hourly, every Monday." },
  { at: 40, tip: "Say where the data comes from: a tool you use, a file, or the web." },
  { at: 70, tip: "Say how you want to read it — a ranked list, a dashboard, a short brief." },
  { at: 110, tip: "That is enough to start. Pen will ask if anything is missing." },
] as const;

/** Full examples — tapping one fills the box so the user can edit rather than stare. */
export const PROMPT_EXAMPLES = [
  "Every morning, check which of my accounts posted a job opening and show me a ranked call list",
  "Each Monday, summarize what my team shipped last week from GitHub as a short brief",
  "When a competitor changes pricing, show me the diff and what it means for us",
] as const;

/** Sentence openers — the hardest part of a blank box is the first three words. */
export const PROMPT_STARTERS = [
  "Every morning…",
  "Each Monday…",
  "Whenever something changes…",
  "Before my calls…",
] as const;
