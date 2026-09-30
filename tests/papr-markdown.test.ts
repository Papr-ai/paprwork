import { describe, expect, it } from "vitest";
import { renderMarkdownToHtml } from "../src/resources/mini-app-sdk/papr-markdown.js";

describe("renderMarkdownToHtml", () => {
  it("renders bold, lists, and headings", () => {
    const html = renderMarkdownToHtml(
      "**SQA Talent Assessment**\n\n## Overview\n\n- Item one\n- Item two\n\n1. First\n2. Second",
    );
    expect(html).toContain("<strong>SQA Talent Assessment</strong>");
    expect(html).toContain("<h2>Overview</h2>");
    expect(html).toContain("<ul><li>Item one</li><li>Item two</li></ul>");
    expect(html).toContain("<ol><li>First</li><li>Second</li></ol>");
  });

  it("escapes raw HTML", () => {
    const html = renderMarkdownToHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders fenced code blocks", () => {
    const html = renderMarkdownToHtml("```typescript\nconst x = 1;\n```");
    expect(html).toContain('<pre class="papr-md-pre">');
    expect(html).toContain('class="language-typescript"');
    expect(html).toContain("const x = 1;");
  });

  it("renders GFM tables", () => {
    const html = renderMarkdownToHtml(
      "| Name | Score |\n| --- | --- |\n| Ada | 99 |",
    );
    expect(html).toContain('<table class="papr-md-table">');
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<td>Ada</td>");
  });
});
