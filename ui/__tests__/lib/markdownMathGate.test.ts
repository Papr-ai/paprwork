import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { inspect } from "node:util";
import { escapeNumericEmphasis } from "../../lib/markdown/escapeNumericEmphasis";
import { looksLikeIntentionalLatex } from "../../lib/markdown/looksLikeIntentionalLatex";
import { remarkMathGate } from "../../lib/markdown/remarkMathGate";

describe("looksLikeIntentionalLatex", () => {
  it("accepts real LaTeX", () => {
    expect(looksLikeIntentionalLatex("E = mc^2")).toBe(true);
    expect(looksLikeIntentionalLatex("C_L")).toBe(true);
    expect(looksLikeIntentionalLatex("\\frac{1}{2}")).toBe(true);
    expect(looksLikeIntentionalLatex("n")).toBe(true);
    expect(looksLikeIntentionalLatex("x")).toBe(true);
  });

  it("rejects prose and ratio-like content", () => {
    expect(looksLikeIntentionalLatex("0.275tradeshowvs.0.069")).toBe(false);
    expect(looksLikeIntentionalLatex("0.275 tradeshow vs 0.069")).toBe(false);
    expect(looksLikeIntentionalLatex("100")).toBe(false);
    expect(looksLikeIntentionalLatex("0.275 + 0.069")).toBe(false);
  });
});

describe("escapeNumericEmphasis", () => {
  it("escapes emphasis markers between numeric segments", () => {
    expect(escapeNumericEmphasis("0.275*tradeshowvs*.0.069")).toBe(
      "0.275\\*tradeshowvs\\*.0.069",
    );
  });

  it("leaves normal emphasis untouched", () => {
    expect(escapeNumericEmphasis("compare *tradeshow* vs PPC")).toBe(
      "compare *tradeshow* vs PPC",
    );
  });
});

describe("remarkMathGate", () => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkMathGate);

  function nodeTypes(markdown: string): string[] {
    const tree = processor.parse(markdown);
    processor.runSync(tree);
    const types: string[] = [];
    function walk(node: { type?: string; children?: unknown[] }): void {
      if (node.type) types.push(node.type);
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          if (child && typeof child === "object") {
            walk(child as { type?: string; children?: unknown[] });
          }
        }
      }
    }
    walk(tree);
    return types;
  }

  it("downgrades accidental inline math to plain text", () => {
    const types = nodeTypes("The $0.275tradeshowvs.0.069$ PPC return is tagged");
    expect(types).not.toContain("inlineMath");
    expect(types).toContain("text");
  });

  it("keeps real inline math nodes", () => {
    const types = nodeTypes("Lift coefficient $C_L$ and energy $E = mc^2$");
    expect(types).toContain("inlineMath");
  });

  it("downgrades prose wrapped in display math", () => {
    const tree = processor.parse("$$\n0.275 tradeshow vs 0.069\n$$");
    processor.runSync(tree);
    expect(inspect(tree)).not.toContain("type: 'math'");
  });
});
