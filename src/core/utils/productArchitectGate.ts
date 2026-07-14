/** Stable id for the built-in Product Architect sub-agent profile */
export const PRODUCT_ARCHITECT_ID = "product-architect";

/** Soft recommendation on create_app / create_job (not a blocker). */
export const PRODUCT_ARCHITECT_REMINDER =
  "Recommendation: For app+job automation (shared DB, pipelines, agent jobs, multi-screen UI), " +
  "consider delegate_task({ useAgentId: \"product-architect\", ... }) for a brief + architecture doc " +
  "before heavy build work — unless you already ran it and the user approved. " +
  "Simple tweaks can proceed without it.";

/** Soft recommendation appended to every create_plan success (not a blocker). */
export const PRODUCT_ARCHITECT_PLAN_REMINDER =
  "Recommendation: If you have not run product-architect yet for this work, consider delegating first " +
  "(brief + architecture: scope, schema, jobs, data flow — lightweight PRD). " +
  "After user approves Phase 1, align this plan with that phase, then build. " +
  "Reference: src/resources/agent-docs/EXAMPLE_APP_ARCHITECTURE_PLAN.md";
