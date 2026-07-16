/** Shared onboarding chat prompt — used by sidebar, Getting Started, and Memory tab. */
export const ONBOARDING_SETUP_MESSAGE =
  "Let's get started with onboarding! I'd like you to learn about me and set things up.";

/**
 * Intent-specific first prompts — sent when the user picks what they want to do.
 * Each prompt gives Pen a concrete job so the user gets real value immediately.
 *
 * These showcase Paprwork's differentiators: agent-powered workflows with
 * persistent jobs, live mini-apps, and autonomous automation — not just chat.
 */
export const INTENT_PROMPTS = {
  finish_work:
    "I have real work to finish. Ask me one question about what I need to get done, then help me complete it — use tools, create documents, search the web, whatever it takes to deliver a real result.",
  build_tool:
    "I want to build something useful. Ask me one question about a workflow I repeat or data I track, then create a mini-app with a backend job that automates part of it and shows results in a live dashboard.",
  automate:
    "I want to automate something I do repeatedly. Ask me one question about what I repeat most, then build an agent job that handles it autonomously on a schedule — and create a mini-app dashboard so I can see what it did.",
  personalize:
    ONBOARDING_SETUP_MESSAGE,
  explore:
    "__OPEN_COMMUNITY_APPS__",
} as const;

/** Labels for intent cards in the onboarding UI. */
export const INTENT_LABELS = {
  finish_work: {
    title: "Finish real work",
    description: "Research, write, analyze, or organize — Pen uses tools to deliver a real result, not just a chat response",
  },
  build_tool: {
    title: "Build an automated workflow",
    description: "Create a mini-app backed by an agent job — a live dashboard that updates itself",
  },
  automate: {
    title: "Automate repeated work",
    description: "Set up an agent that runs on a schedule, takes actions, and reports results in a live app",
  },
  personalize: {
    title: "Personalize Pen",
    description: "Tell me about your work so I can help you better every time",
  },
  explore: {
    title: "Browse community apps",
    description: "Preview and install ready-made apps built by the community — customize them to make them yours",
  },
} as const;
