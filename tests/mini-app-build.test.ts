import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  buildMiniApp,
  preferBundledEntryInHtml,
  rewriteHtmlForBundledDist,
} from "../src/gateway/utils/miniAppBuild.js";

const TEST_DIR = path.join(os.tmpdir(), `papr-build-test-${Date.now()}`);

async function writeFile(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(TEST_DIR, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

describe("buildMiniApp", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it("removes .dist-staging after a FAILED build", async () => {
    // A build failure previously skipped staging cleanup, leaving
    // .dist-staging/ inside the app directory where source scans pick it up.
    await writeFile(
      "app.ts",
      `import './missing-module-that-does-not-exist.js';\nconsole.info('x');\n`,
    );

    const result = await buildMiniApp(TEST_DIR);

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    const staging = path.join(TEST_DIR, ".dist-staging");
    await expect(fs.access(staging)).rejects.toThrow();
  });

  it("preserves source files when a build fails", async () => {
    // Source files are user-authored and must survive a failed build;
    // only dist/ is derived output.
    await writeFile("app.ts", `import './nope.js';\n`);
    await writeFile("style.css", `body { color: red; }\n`);
    await writeFile("index.html", `<!doctype html><html></html>`);

    const result = await buildMiniApp(TEST_DIR);
    expect(result.success).toBe(false);

    for (const f of ["app.ts", "style.css", "index.html"]) {
      await expect(fs.access(path.join(TEST_DIR, f))).resolves.toBeUndefined();
    }
  });

  it("returns legacy: true when no ES module entry exists", async () => {
    await writeFile("index.html", "<html></html>");
    await writeFile("script.js", "alert('hello')");

    const result = await buildMiniApp(TEST_DIR);
    expect(result.legacy).toBe(true);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("bundles app.ts with CSS imports into dist/", async () => {
    await writeFile("base.css", "body { margin: 0; }");
    await writeFile("app.ts", [
      "import './base.css';",
      "import './components/card.css';",
      "const app = document.getElementById('app');",
      "if (app) app.textContent = 'hello';",
    ].join("\n"));
    await writeFile("components/card.css", ".card { padding: 16px; }");

    const result = await buildMiniApp(TEST_DIR);
    expect(result.success).toBe(true);
    expect(result.legacy).toBe(false);
    expect(result.errors.filter((e) => e.severity === "error")).toHaveLength(0);

    const distJs = await fs.readFile(path.join(TEST_DIR, "dist", "app.js"), "utf-8");
    expect(distJs).toContain("hello");

    const distCss = await fs.readFile(path.join(TEST_DIR, "dist", "app.css"), "utf-8");
    expect(distCss).toContain("margin: 0");
    expect(distCss).toContain("padding: 16px");
  });

  it("leaves /__papr__/ SDK imports external (runtime-served, not bundled)", async () => {
    await writeFile("app.ts", [
      "import { subscribeJobEvents } from '/__papr__/papr-job-events.ts';",
      "subscribeJobEvents({ jobIds: ['job-1'] });",
    ].join("\n"));

    const result = await buildMiniApp(TEST_DIR);
    expect(result.success).toBe(true);

    const distJs = await fs.readFile(path.join(TEST_DIR, "dist", "app.js"), "utf-8");
    expect(distJs).toContain('from "/__papr__/papr-job-events.ts"');
    expect(distJs).not.toContain("EventSource");
  });

  it("formats /__papr__/ resolve errors with platform guidance", async () => {
    const { formatMiniAppBuildErrorMessage } = await import(
      "../src/gateway/utils/miniAppBuild.js"
    );
    const msg = formatMiniAppBuildErrorMessage(
      'Could not resolve "/__papr__/papr-job-events.ts"',
    );
    expect(msg).toContain("Do NOT add local shim");
    expect(msg).toContain("/__papr__/ import is correct");
  });

  it("fails with clear error when CSS import is missing", async () => {
    await writeFile("app.ts", [
      "import './base.css';",
      "import './components/missing.css';",
      "console.log('test');",
    ].join("\n"));
    await writeFile("base.css", "body { margin: 0; }");

    const result = await buildMiniApp(TEST_DIR);
    expect(result.success).toBe(false);
    expect(result.legacy).toBe(false);

    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("Could not resolve"))).toBe(true);
  });

  it("reports CSS syntax issues as warnings", async () => {
    await writeFile("app.ts", "import './bad.css';\nconsole.log('test');");
    await writeFile("bad.css", ".card { padding: @invalid-fn((); }");

    const result = await buildMiniApp(TEST_DIR);
    // esbuild treats CSS syntax issues as warnings (CSS spec is lenient)
    expect(result.success).toBe(true);

    const warnings = result.errors.filter((e) => e.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].file).toContain("bad.css");
  });

  it("fails with clear error on TypeScript syntax error", async () => {
    await writeFile("app.ts", [
      "import './base.css';",
      "const x: string = 123;",
      "function broken( { return; }",
    ].join("\n"));
    await writeFile("base.css", "body { margin: 0; }");

    const result = await buildMiniApp(TEST_DIR);
    expect(result.success).toBe(false);

    const errors = result.errors.filter((e) => e.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("bundles TypeScript component imports correctly", async () => {
    await writeFile("base.css", "body { margin: 0; }");
    await writeFile("app.ts", [
      "import './base.css';",
      "import { greet } from './utils/greet.ts';",
      "console.log(greet('world'));",
    ].join("\n"));
    await writeFile("utils/greet.ts", [
      "export function greet(name: string): string {",
      "  return `Hello ${name}`;",
      "}",
    ].join("\n"));

    const result = await buildMiniApp(TEST_DIR);
    expect(result.success).toBe(true);

    const distJs = await fs.readFile(path.join(TEST_DIR, "dist", "app.js"), "utf-8");
    expect(distJs).toContain("Hello");
    expect(distJs).toContain("greet");
  });

  it("handles app.tsx entry points", async () => {
    await writeFile("base.css", "body { margin: 0; }");
    await writeFile("app.tsx", [
      "import './base.css';",
      "function App() { return <div>Hello</div>; }",
      "console.log('initialized');",
    ].join("\n"));

    const result = await buildMiniApp(TEST_DIR);
    expect(result.success).toBe(true);
    expect(result.legacy).toBe(false);
  });
});

describe("rewriteHtmlForBundledDist", () => {
  it("rewrites inline module import to dist/app.js", () => {
    const html =
      '<html><body><script type="module">import \'./app.ts\';</script></body></html>';
    const out = rewriteHtmlForBundledDist(html);
    expect(out).toContain('<script type="module" src="dist/app.js"></script>');
    expect(out).not.toContain("app.ts");
  });

  it("rewrites script src entry to dist/app.js", () => {
    const html = '<html><body><script type="module" src="./app.tsx"></script></body></html>';
    const out = rewriteHtmlForBundledDist(html);
    expect(out).toContain('src="dist/app.js"');
  });

  it("injects dist/app.css when requested", () => {
    const html = "<html><head></head><body></body></html>";
    const out = rewriteHtmlForBundledDist(html, { hasDistCss: true });
    expect(out).toContain('<link rel="stylesheet" href="dist/app.css">');
  });

  it("injects modulepreload for dist/app.js", () => {
    const html =
      '<html><head></head><body><script type="module">import \'./app.ts\';</script></body></html>';
    const out = rewriteHtmlForBundledDist(html);
    expect(out).toContain('<link rel="modulepreload" href="dist/app.js">');
  });
});

describe("preferBundledEntryInHtml", () => {
  let appDir: string;

  beforeEach(async () => {
    appDir = path.join(
      os.tmpdir(),
      `papr-bundle-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(appDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(appDir, { recursive: true, force: true });
  });

  it("leaves html unchanged when dist/app.js is missing", async () => {
    const html = '<script type="module">import \'./app.ts\';</script>';
    const out = await preferBundledEntryInHtml(html, appDir);
    expect(out).toBe(html);
  });

  it("rewrites when dist/app.js exists", async () => {
    await fs.mkdir(path.join(appDir, "dist"), { recursive: true });
    await fs.writeFile(path.join(appDir, "dist", "app.js"), "// bundled", "utf-8");
    const html = '<script type="module">import \'./app.ts\';</script>';
    const out = await preferBundledEntryInHtml(html, appDir);
    expect(out).toContain('src="dist/app.js"');
  });
});
