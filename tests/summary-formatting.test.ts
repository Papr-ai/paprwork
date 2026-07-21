import { describe, expect, it } from "vitest";
import {
  extractEnhancedFields,
  formatSummaryForLLM,
  serializeEnhancedFields,
  deserializeEnhancedFields,
} from "../src/gateway/services/storage/summaryFormatting.js";

describe("summaryFormatting", () => {
  it("extracts enhanced_fields from compress response", () => {
    const enhanced = extractEnhancedFields({
      session_id: "chat-1",
      summaries: {
        short_term: "Recent work",
        medium_term: "Medium",
        long_term: "Long",
        topics: ["auth"],
      },
      enhanced_fields: {
        session_intent: "Build JWT auth",
        key_decisions: ["Use httpOnly cookies"],
        current_state: "Login works, refresh pending",
        next_steps: ["Add RBAC"],
        technical_details: ["Token expiry: 3600s"],
        files_accessed: {
          read: ["src/auth.ts"],
          modified: [{ path: "src/auth.ts", description: "Added JWT helper" }],
        },
        project_context: {
          project_name: "Task App",
          tech_stack: ["React", "TypeScript"],
        },
      },
    });

    expect(enhanced?.session_intent).toBe("Build JWT auth");
    expect(enhanced?.key_decisions).toEqual(["Use httpOnly cookies"]);
    expect(enhanced?.files_accessed?.read).toEqual(["src/auth.ts"]);
    expect(enhanced?.project_context?.project_name).toBe("Task App");
  });

  it("round-trips enhanced fields through SQLite JSON storage", () => {
    const enhanced = {
      session_intent: "Ship dashboard",
      next_steps: ["Deploy to Vercel"],
    };
    const serialized = serializeEnhancedFields(enhanced);
    expect(deserializeEnhancedFields(serialized)).toEqual(enhanced);
  });

  it("injects enhanced fields into LLM summary block", () => {
    const prompt = formatSummaryForLLM({
      tiers: {
        short_term: "Short",
        medium_term: "Medium",
        long_term: "Long",
        topics: ["ui"],
        last_updated: "2026-06-08T00:00:00.000Z",
      },
      enhanced: {
        session_intent: "Redesign sidebar",
        next_steps: ["Replace emojis with SVG icons"],
      },
      chatFilePath: "~/Papr/Chats/chat-1.txt",
    });

    expect(prompt).toContain("SESSION INTENT: Redesign sidebar");
    expect(prompt).toContain("NEXT STEPS:");
    expect(prompt).toContain("Replace emojis with SVG icons");
    expect(prompt).not.toContain("messages total");
    expect(prompt).not.toContain("older messages archived");
  });
});
