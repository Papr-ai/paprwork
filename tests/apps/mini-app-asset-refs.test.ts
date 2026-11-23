import { describe, expect, it } from "vitest";
import { linkCreatedStylesheets } from "../../src/core/tools/appJobs.js";
import { rewriteHtmlForBundledDist } from "../../src/gateway/utils/miniAppBuild.js";
import { checkMiniAppAssetRefs } from "../../src/gateway/utils/miniAppAssetRefLint.js";

describe("rewriteHtmlForBundledDist — app.js entry", () => {
  it("rewrites a classic app.js tag to the dist module bundle", () => {
    const out = rewriteHtmlForBundledDist('<html><head></head><body><script src="app.js"></script></body></html>');
    expect(out).toContain('<script type="module" src="dist/app.js"></script>');
    expect(out).not.toMatch(/src="app\.js"/);
  });

  it("keeps an existing type=module and handles ./main.js", () => {
    const out = rewriteHtmlForBundledDist('<script type="module" src="./main.js"></script>');
    expect(out).toBe('<script type="module" src="dist/app.js"></script>');
  });

  it("leaves unrelated scripts alone", () => {
    const html = '<script src="vendor/chart.js"></script><script src="/__papr__/x.js"></script>';
    expect(rewriteHtmlForBundledDist(html)).toContain('src="vendor/chart.js"');
  });
});

describe("checkMiniAppAssetRefs", () => {
  const files = new Set(["index.html", "app.ts", "base.css", "style.css"]);

  it("flags a stylesheet that does not exist and lists the real ones", () => {
    const issues = checkMiniAppAssetRefs('<link rel="stylesheet" href="styles.css">', files);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toContain("styles.css");
    expect(issues[0].message).toContain("base.css, style.css");
  });

  it("allows bundler-produced entries when an app.ts exists", () => {
    const html = '<script src="app.js"></script><script type="module" src="dist/app.js"></script><link rel="stylesheet" href="dist/app.css">';
    expect(checkMiniAppAssetRefs(html, files)).toEqual([]);
  });

  it("flags app.js when there is no TS entry to bundle", () => {
    const issues = checkMiniAppAssetRefs('<script src="app.js"></script>', new Set(["index.html"]));
    expect(issues[0]?.message).toContain('script "app.js"');
  });

  it("ignores platform, absolute, and remote refs plus icon links", () => {
    const html =
      '<script src="/__papr__/papr-job-events.js"></script><script src="https://cdn.x/y.js"></script>' +
      '<link rel="icon" href="icon.png"><link rel="stylesheet" href="./style.css?v=2">';
    expect(checkMiniAppAssetRefs(html, files)).toEqual([]);
  });
});

describe("linkCreatedStylesheets", () => {
  it("links the design system and the agent stylesheet when index.html forgot them", () => {
    const out = linkCreatedStylesheets([
      { filename: "index.html", content: "<html><head><title>x</title></head><body></body></html>" },
      { filename: "app.ts", content: "" },
      { filename: "style.css", content: "h1{}" },
      { filename: "base.css", content: ":root{}" },
    ]);
    const html = out.find((f) => f.filename === "index.html")!.content;
    expect(html.indexOf('href="base.css"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="base.css"')).toBeLessThan(html.indexOf('href="style.css"'));
  });

  it("puts base.css before an existing app stylesheet so app rules win", () => {
    const out = linkCreatedStylesheets([
      { filename: "index.html", content: '<head><link rel="stylesheet" href="style.css"></head>' },
      { filename: "style.css", content: "" },
      { filename: "base.css", content: "" },
    ]);
    const html = out[0].content;
    expect(html.indexOf("base.css")).toBeLessThan(html.indexOf("style.css"));
    expect(html.match(/style\.css/g)).toHaveLength(1);
  });

  it("does nothing when the TS entry imports the sheet", () => {
    const files = [
      { filename: "index.html", content: "<head></head>" },
      { filename: "app.ts", content: "import './base.css';\nimport './style.css';" },
      { filename: "style.css", content: "" },
      { filename: "base.css", content: "" },
    ];
    expect(linkCreatedStylesheets(files)).toBe(files);
  });
});
