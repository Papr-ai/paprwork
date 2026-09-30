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

/**
 * Pills above the "Something else" box — tap fills the full prompt. Chosen to
 * show range: multi-source apps with scheduled jobs, not one-off summaries.
 */
export const PROMPT_PILLS = [
  {
    label: "Pipeline command center",
    prompt:
      "Build a pipeline dashboard that pulls my open deals from HubSpot every morning, scores which ones are going cold, and drafts a personalized follow-up email for each",
  },
  {
    label: "Competitor intel tracker",
    prompt:
      "Track 5 competitors' websites, pricing pages and LinkedIn every day, log every change in a searchable app, and send me a weekly brief on what it means for us",
  },
  {
    label: "Meeting prep + CRM notes",
    prompt:
      "Before every meeting on my calendar, research the attendees and their company and write a one-page brief — then after the call turn my notes into CRM updates and next steps",
  },
  {
    label: "Recruiting pipeline",
    prompt:
      "Build a recruiting app that pulls applicants from my inbox, scores each one against the job description, and gives me a ranked shortlist with interview questions every day",
  },
  {
    label: "Content engine",
    prompt:
      "Turn my weekly notes into a LinkedIn post, a newsletter and a short thread, keep a content calendar app, and track which posts performed best",
  },
] as const;

/** Sentence openers — the hardest part of a blank box is the first three words. */
export const PROMPT_STARTERS = [
  "Every morning…",
  "Each Monday…",
  "Whenever something changes…",
  "Before my calls…",
] as const;
