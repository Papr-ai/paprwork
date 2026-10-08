/**
 * Single source of truth for the mini-app design directive.
 *
 * Injected at every point BEFORE UI code is written:
 *   1. product-architect system prompt (plans the 4-state UI before build)
 *   2. create_app tool description (read when the model decides to call it)
 *   3. main system prompt design section (always in context)
 *   4. create_app _designReminder (governs follow-up edits)
 * The long-form version lives in src/resources/skills/paprwork-design-system.md
 * ("Design Directive" section) — keep them in sync.
 */

/** One-paragraph intent — the user-facing brief, verbatim spirit. */
export const DESIGN_DIRECTIVE_INTENT =
  "Use the Papr Liquid Glass design skill. Less is more: minimalist, modern, simple. " +
  "Focus on ONE job-to-be-done. Steve Jobs meets Elon Musk — taste + first-principles " +
  "(delete every element that does not serve the job, then simplify what remains). " +
  "Apply cognitive-neuroscience UX research to make it instantly intuitive in empty AND filled " +
  "states, dark AND light mode, small AND large screens.";

/** Concrete, checkable rules the model can self-verify against (research → rule). */
export const DESIGN_DIRECTIVE_RULES = [
  "One screen = one job, one primary action (Hick's law: every extra choice adds decision time).",
  "Primary action findable in <2s: largest, highest-contrast, in the natural F/Z scan path; big target (Fitts's law).",
  "Working memory holds ~4 chunks: max 3 sections per screen, group related items, progressive disclosure for the rest.",
  "Recognition over recall: visible labels + icons, no hidden gestures, no jargon.",
  "Use pre-attentive cues sparingly (one accent color, size, position) to point at what matters — never decoration.",
  "Empty state is the onboarding: one sentence of value, one CTA to first success, optional example/sample data — never a blank table.",
  "Filled state: scannable hierarchy, sensible default sort, key number first, details on demand.",
  "Loading = skeletons matching final layout (no spinners on whole page); errors say what happened + one fix action.",
  "Dark + light: both via prefers-color-scheme + Liquid Glass tokens; WCAG AA contrast on glass in both.",
  "Small (<=640px) + large (>=1280px): mobile-first single column, 44px touch targets, content max-width on wide screens, no horizontal overflow.",
  "Motion 150-250ms, transform/opacity only, respects prefers-reduced-motion; feedback within 100ms of every action.",
  "Goal / progress / metrics pages are visual-first (Apple Photos, Fitness): one payoff number, one chart of progress over time on a shared baseline with a target line, real profile pictures and company logos (never invented), evidence as tiles — read_skill({ skillId: \"preloaded-goal-page-design\" }).",
] as const;

/** Compact form for tool descriptions / reminders. */
export const DESIGN_DIRECTIVE_SHORT =
  `DESIGN DIRECTIVE: ${DESIGN_DIRECTIVE_INTENT} ` +
  "Before writing UI, design all 4 states: empty/filled x dark/light, and verify at 390px and 1440px widths.";

/** Full block for system prompts. */
export const DESIGN_DIRECTIVE_BLOCK =
  `${DESIGN_DIRECTIVE_INTENT}\n\nRules (self-check every screen):\n` +
  DESIGN_DIRECTIVE_RULES.map((r) => `- ${r}`).join("\n");
