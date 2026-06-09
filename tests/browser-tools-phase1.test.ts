import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  browserParseHtmlTool,
  browserFillFormTool,
  browserScrollTool,
} from "../src/core/tools/browser.js";
import { pageWaitForTool } from "../src/core/tools/pageWait.js";
import { spawn } from "child_process";

// Mock child_process for Python execution tests
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

describe("Browser Tools Phase 1", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("browserParseHtmlTool", () => {
    it("should have correct id and schema", () => {
      expect(browserParseHtmlTool.id).toBe("browser_parse_html");
      expect(browserParseHtmlTool.description).toContain("BeautifulSoup");
      expect(browserParseHtmlTool.inputSchema).toBeDefined();
    });

    it("should validate required code parameter", () => {
      const schema = browserParseHtmlTool.inputSchema;
      expect(() => schema.parse({})).toThrow();
      expect(() => schema.parse({ code: "" })).toThrow();
      expect(() =>
        schema.parse({ code: "soup = BeautifulSoup(html, 'html.parser')" }),
      ).not.toThrow();
    });

    it("should have optional timeout with default", () => {
      const schema = browserParseHtmlTool.inputSchema;
      const parsed = schema.parse({ code: "result = 'test'" });
      expect(parsed.timeout).toBe(30000);
    });

    it("should accept custom timeout", () => {
      const schema = browserParseHtmlTool.inputSchema;
      const parsed = schema.parse({ code: "result = 'test'", timeout: 60000 });
      expect(parsed.timeout).toBe(60000);
    });
  });

  describe("pageWaitForTool", () => {
    it("should have correct id and schema", () => {
      expect(pageWaitForTool.id).toBe("page_wait_for");
      expect(pageWaitForTool.description).toContain("mini_app");
      expect(pageWaitForTool.description).toContain("browser");
      expect(pageWaitForTool.inputSchema).toBeDefined();
    });

    it("should require target and accept wait parameters", () => {
      const schema = pageWaitForTool.inputSchema;

      expect(() => schema.parse({ target: "browser", text: "Sign in" })).not.toThrow();
      expect(() => schema.parse({ target: "mini_app", time: 2 })).not.toThrow();
      expect(() => schema.parse({ text: "Sign in" })).toThrow();
    });

    it("should have default timeout of 30000ms", () => {
      const schema = pageWaitForTool.inputSchema;
      const parsed = schema.parse({ target: "browser", text: "test" });
      expect(parsed.timeout).toBe(30000);
    });
  });

  describe("browserFillFormTool", () => {
    it("should have correct id and schema", () => {
      expect(browserFillFormTool.id).toBe("browser_fill_form");
      expect(browserFillFormTool.description).toContain("multiple form fields");
      expect(browserFillFormTool.inputSchema).toBeDefined();
    });

    it("should require at least one field", () => {
      const schema = browserFillFormTool.inputSchema;

      expect(() => schema.parse({ fields: [] })).toThrow();
      expect(() =>
        schema.parse({
          fields: [{ selector: "#email", value: "test@example.com" }],
        }),
      ).not.toThrow();
    });

    it("should have clear field default to true", () => {
      const schema = browserFillFormTool.inputSchema;
      const parsed = schema.parse({
        fields: [{ selector: "#email", value: "test@example.com" }],
      });
      expect(parsed.fields[0].clear).toBe(true);
    });

    it("should validate field structure", () => {
      const schema = browserFillFormTool.inputSchema;

      expect(() =>
        schema.parse({
          fields: [{ selector: "#email" }],
        }),
      ).toThrow(); // Missing value

      expect(() =>
        schema.parse({
          fields: [{ value: "test" }],
        }),
      ).toThrow(); // Missing selector
    });
  });

  describe("browserScrollTool", () => {
    it("should have correct id and schema", () => {
      expect(browserScrollTool.id).toBe("browser_scroll");
      expect(browserScrollTool.description).toContain("off-screen");
      expect(browserScrollTool.inputSchema).toBeDefined();
    });

    it("should accept selector for scrolling into view", () => {
      const schema = browserScrollTool.inputSchema;
      expect(() => schema.parse({ selector: "#footer" })).not.toThrow();
    });

    it("should accept direction and amount", () => {
      const schema = browserScrollTool.inputSchema;
      expect(() =>
        schema.parse({ direction: "down", amount: 500 }),
      ).not.toThrow();
      expect(() =>
        schema.parse({ direction: "up", amount: 300 }),
      ).not.toThrow();
    });

    it("should accept deltaX and deltaY", () => {
      const schema = browserScrollTool.inputSchema;
      expect(() => schema.parse({ deltaX: 100, deltaY: 200 })).not.toThrow();
    });

    it("should have default amount of 300", () => {
      const schema = browserScrollTool.inputSchema;
      const parsed = schema.parse({ direction: "down" });
      expect(parsed.amount).toBe(300);
    });

    it("should validate direction enum", () => {
      const schema = browserScrollTool.inputSchema;
      expect(() => schema.parse({ direction: "down" })).not.toThrow();
      expect(() => schema.parse({ direction: "invalid" })).toThrow();
    });
  });
});

describe("Manual Testing Checklist", () => {
  it("documents manual testing scenarios", () => {
    const manualTests = [
      {
        tool: "browser_parse_html",
        scenario: "Navigate to Amazon, parse product listings",
        expected:
          "Successfully extracts product names, prices, ratings as JSON",
      },
      {
        tool: "page_wait_for",
        scenario: "Navigate to GitHub, wait for 'Sign in' button",
        expected: "Waits with target browser before timing out",
      },
      {
        tool: "browser_fill_form",
        scenario: "Fill multi-field login form",
        expected: "All fields filled in single tool call",
      },
      {
        tool: "browser_scroll",
        scenario: "Scroll to footer element and click",
        expected: "Element brought into view before click succeeds",
      },
    ];

    expect(manualTests).toHaveLength(4);
  });
});
