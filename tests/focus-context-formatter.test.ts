import { describe, expect, it } from "vitest";
import {
  AGENT_FOCUS_CONTEXT_PREFIX,
  formatAgentFocusContext,
  mergeUiAndServerFocus,
} from "../src/gateway/services/agent/focusContextFormatter.js";

describe("formatAgentFocusContext", () => {
  it("returns undefined when no active app or edits", () => {
    expect(formatAgentFocusContext(undefined)).toBeUndefined();
    expect(formatAgentFocusContext({})).toBeUndefined();
  });

  it("formats active mini-app with file list", () => {
    const text = formatAgentFocusContext({
      activeApp: {
        appId: "abc-123",
        title: "Dashboard",
        files: ["index.html", "app.ts", "base.css"],
      },
    });

    expect(text).toContain(AGENT_FOCUS_CONTEXT_PREFIX);
    expect(text).toContain("abc-123");
    expect(text).toContain("index.html");
    expect(text).toContain("edit_file");
    expect(text).toContain("Skip `list_apps`");
  });

  it("formats active job with file list", () => {
    const text = formatAgentFocusContext({
      activeJob: {
        jobId: "job-456",
        name: "Daily Scraper",
        files: ["code/scraper.py", "requirements.txt"],
      },
    });

    expect(text).toContain(AGENT_FOCUS_CONTEXT_PREFIX);
    expect(text).toContain("job-456");
    expect(text).toContain("scraper.py");
    expect(text).toContain("edit_file");
    expect(text).toContain("Skip `list_jobs`");
  });

  it("formats recent edits", () => {
    const text = formatAgentFocusContext({
      lastEdited: [
        {
          kind: "repo_file",
          path: "src/core/agents/SystemPrompt.ts",
          repoRoot: "/Users/dev/paprwork-v2",
          editedAt: "2026-07-10T00:00:00.000Z",
        },
      ],
    });

    expect(text).toContain("Recently edited files");
    expect(text).toContain("SystemPrompt.ts");
    expect(text).toContain("postEditSnippet");
  });

  it("discourages bulk re-reads when active app is set", () => {
    const text = formatAgentFocusContext({
      activeApp: {
        appId: "abc-123",
        title: "Dashboard",
        files: ["index.html"],
      },
    });

    expect(text).toContain("Do not bulk");
  });
});

describe("mergeUiAndServerFocus", () => {
  it("prefers UI active app from ui payload", () => {
    const merged = mergeUiAndServerFocus(
      { activeApp: { appId: "ui-app", title: "UI App" } },
      {
        activeApp: { appId: "stale", title: "Stale" },
        lastEdited: [],
      },
    );

    expect(merged?.activeApp?.appId).toBe("ui-app");
  });
});
