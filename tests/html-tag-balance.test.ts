import { describe, expect, it } from "vitest";
import { checkHtmlTagBalance } from "../src/gateway/utils/htmlTagBalance.js";

const messages = (html: string) => checkHtmlTagBalance(html).map((i) => i.message);

describe("checkHtmlTagBalance", () => {
  it("accepts self-closing SVG children without cascading", () => {
    const html = `<!doctype html>
<html lang="en">
<body>
  <main class="card">
    <div class="stepper">
      <button id="minus" type="button" aria-label="Fewer">
        <svg viewBox="0 0 24 24"><path d="M5 12h14" /></svg>
      </button>
    </div>
  </main>
</body>
</html>`;
    expect(messages(html)).toEqual([]);
  });

  it("accepts all void elements and multi-line tags", () => {
    const html = `<head><meta charset="utf-8"><link rel="stylesheet" href="s.css"></head>
<picture><source srcset="a.webp"><img src="a.png"></picture><br><wbr>
<input
  type="text"
  placeholder="a > b"
>
<div
  class="x"
>ok</div>`;
    expect(messages(html)).toEqual([]);
  });

  it("ignores tags inside script, style, and comments", () => {
    const html = `<div>
<!-- <section> commented out -->
<script>const s = "<div>" + '<span>'; if (a < b) {}</script>
<style>.a > .b { color: red }</style>
</div>`;
    expect(messages(html)).toEqual([]);
  });

  it("does not report optional end tags (li, p, td, body, html)", () => {
    const html = `<html><body><ul><li>one<li>two</ul><p>para<table><tr><td>x</table></body>`;
    expect(messages(html)).toEqual([]);
  });

  it("still reports a genuinely unclosed element, once, on its line", () => {
    const html = `<main>
  <div class="a">
    <span>text
  </div>
</main>`;
    const issues = checkHtmlTagBalance(html);
    expect(issues).toEqual([{ line: 3, message: "Potentially unclosed <span> tag" }]);
  });

  it("reports an unclosed element at end of document", () => {
    expect(messages(`<main><section>hi</main><div>`)).toEqual([
      "Potentially unclosed <section> tag",
      "Potentially unclosed <div> tag",
    ]);
  });

  it("reports a stray closing tag without cascading", () => {
    expect(messages(`<div>ok</span></div>`)).toEqual([
      "Unexpected closing </span> tag with no matching opener",
    ]);
  });
});
