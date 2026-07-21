/** Shared onboarding chat prompt — used by sidebar, Getting Started, and Memory tab. */
export const ONBOARDING_SETUP_MESSAGE =
  "Let's get started with onboarding! I'd like you to learn about me and set things up.";

/**
 * Intent-specific first prompts — sent when the user picks what they want to do.
 * Each prompt gives Papr a concrete job so the user gets real value immediately.
 *
 * These showcase Paprwork's differentiators: agent-powered workflows with
 * persistent jobs, live mini-apps, and autonomous automation — not just chat.
 */
export const INTENT_PROMPTS = {
  explore:
    "__OPEN_COMMUNITY_APPS__",
  finish_work:
    "I have real work to finish. Ask me one question about what I need to get done, then help me complete it — use tools, create documents, search the web, whatever it takes to deliver a real result.",
  build_app:
    "I want to build an app with a backend agent that automates a workflow. For example: a social media post generator that drafts and schedules content, a deal tracker that pulls CRM updates daily, or a metrics dashboard that refreshes from live data. Ask me one question about what I'd find most useful, then build the app with a job that powers it.",
  personalize:
    ONBOARDING_SETUP_MESSAGE,
} as const;

/** Labels and examples for intent cards in the onboarding UI. */
export const INTENT_LABELS = {
  explore: {
    title: "Browse community apps",
    description: "Preview and install ready-made apps — customize them to make them yours",
    examples: ["Meeting summarizer", "Expense tracker", "Content calendar"],
  },
  finish_work: {
    title: "Finish real work",
    description: "Research, write, analyze, or organize — Papr uses tools to deliver a real result",
    examples: ["Competitive analysis", "Draft a proposal", "Summarize a PDF"],
  },
  build_app: {
    title: "Build an app with AI automation",
    description: "Create a live app powered by an agent job that runs on autopilot",
    examples: ["Social post generator", "Deal tracker", "Daily briefing dashboard"],
  },
  personalize: {
    title: "Build your AI brain",
    description: "Teach Papr about your work so it gets smarter every time you use it",
    examples: ["Your role & goals", "Writing style", "Key projects & tools"],
  },
} as const;
