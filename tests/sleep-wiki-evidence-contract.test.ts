import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Sleep v18 / Wiki Writer v9 contract:
 *  - every claim in a daily log or entity page carries a verbatim quote + source
 *  - quotes are proven with verify_quotes.py (exact substring, no fuzzy matching)
 *  - Sleep promotes explicit user statements to MEMORY/IDENTITY on a single occurrence
 *  - Wiki Writer emits only section headings the Memory wiki UI renders
 */

const root = process.cwd();
const templates = join(root, "src/resources/workspace-templates");
const read = (p: string) => readFileSync(p, "utf8");

function runVerifier(paprHome: string, claims: unknown[]): { lines: Record<string, unknown>[]; code: number } {
  const claimsPath = join(paprHome, "claims.json");
  writeFileSync(claimsPath, JSON.stringify(claims));
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync("python3", [join(templates, "verify_quotes.py"), claimsPath], {
      env: { ...process.env, PAPR_HOME: paprHome },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    stdout = e.stdout ?? "";
    code = e.status ?? 1;
  }
  const lines = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, code };
}

describe("verify_quotes.py", () => {
  const home = mkdtempSync(join(tmpdir(), "papr-verify-"));
  mkdirSync(join(home, "Chats"), { recursive: true });
  mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  writeFileSync(
    join(home, "Chats", "Brief Audit.txt"),
    "[user]: we need to build this at the platform level in paprwork-v2\n[assistant]: ok\n[user]: keep goals in one canonical location — IDENTITY.md — already injected everywhere\n",
  );
  writeFileSync(join(home, "workspace", "memory", "2026-09-04.md"), "- Implemented a \u201cSet my goals\u201d button in the Home app\n");

  it("accepts exact quotes and reports source + line", () => {
    const { lines, code } = runVerifier(home, [
      { id: "a", quote: "build this at the platform level in paprwork-v2", source: "Chats/Brief Audit.txt" },
    ]);
    expect(code).toBe(0);
    expect(lines[0]).toMatchObject({ id: "a", ok: true, source: "Chats/Brief Audit.txt", line: 1 });
  });

  it("is tolerant of curly quotes, dashes and whitespace but not of paraphrase", () => {
    const { lines } = runVerifier(home, [
      { id: "curly", quote: '"Set my goals" button in the Home app', source: "workspace/memory/2026-09-04.md" },
      { id: "dash", quote: "one canonical location - IDENTITY.md - already injected", source: "Chats/Brief Audit.txt" },
      { id: "para", quote: "goals should live in a single canonical file", source: "Chats/Brief Audit.txt" },
    ]);
    expect(lines.find((l) => l.id === "curly")?.ok).toBe(true);
    expect(lines.find((l) => l.id === "dash")?.ok).toBe(true);
    const para = lines.find((l) => l.id === "para");
    expect(para?.ok).toBe(false);
    expect(String(para?.reason)).toMatch(/not found/);
  });

  it("rejects fabricated, too-short, and missing-source claims and exits non-zero", () => {
    const { lines, code } = runVerifier(home, [
      { id: "fake", quote: "Amir decided to cancel the Revenue Reimagined contract", source: "Chats/*.txt" },
      { id: "short", quote: "goals", source: "Chats/Brief Audit.txt" },
      { id: "nosrc", quote: "anything long enough here", source: "Chats/nope.txt" },
    ]);
    expect(code).toBe(1);
    expect(lines.map((l) => l.ok)).toEqual([false, false, false]);
    expect(String(lines[1].reason)).toMatch(/too short/);
    expect(String(lines[2].reason)).toMatch(/source not found/);
  });

  it("supports wildcard sources", () => {
    const { lines } = runVerifier(home, [
      { id: "glob", quote: "keep goals in one canonical location", source: "Chats/*.txt" },
    ]);
    expect(lines[0]).toMatchObject({ ok: true, source: "Chats/Brief Audit.txt" });
  });
});

describe("SLEEP.md v18 evidence + promotion contract", () => {
  const sleep = read(join(templates, "SLEEP.md"));

  it("requires a verified quote and source on every claim", () => {
    expect(sleep).toMatch(/Evidence contract — every claim is proven, not asserted/);
    expect(sleep).toMatch(/exact substring/);
    expect(sleep).toContain('python3 "$PAPR_HOME/workspace/verify_quotes.py"');
    expect(sleep).toMatch(/Drop any claim whose quote still fails/);
    expect(sleep).toMatch(/Do not quote the agent's own prior summaries/);
  });

  it("promotes explicit user statements on a single occurrence and fills Communication Style / Preferences", () => {
    expect(sleep).toMatch(/4b\. Promotion pass/);
    expect(sleep).toMatch(/\*\*One explicit user statement is enough\.\*\*/);
    expect(sleep).toMatch(/`IDENTITY\.md` → `## Communication Style`/);
    expect(sleep).toMatch(/`MEMORY\.md` → `## Preferences`/);
    expect(sleep).toMatch(/Never leave a template placeholder/);
    // The old blanket ≥2 rule must not survive as the only rule.
    expect(sleep).not.toMatch(/Only add facts the user \*\*explicitly stated or demonstrated repeatedly\*\* \(≥ 2 occurrences\)/);
  });
});

describe("WIKI_WRITER.md v9 section + evidence contract", () => {
  const wiki = read(join(templates, "WIKI_WRITER.md"));
  const RENDERABLE = ["Context & Background", "Key Details", "Key Interactions", "Decisions & Insights", "Open Items", "Changelog"];

  it("template uses only headings the Memory wiki UI renders", () => {
    const tpl = wiki.slice(wiki.indexOf("```markdown"), wiki.indexOf("**C. Query the graph"));
    const headings = [...tpl.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    expect(headings.length).toBeGreaterThanOrEqual(5);
    for (const h of headings) expect(RENDERABLE, `non-renderable heading in template: ${h}`).toContain(h);
    for (const legacy of ["## Overview", "## Key Facts", "## Timeline", "## Sources", "## Related Entities", "## Details"]) {
      expect(tpl).not.toContain(legacy);
    }
  });

  it("names the UI contract, migrates legacy pages, verifies quotes, and writes back to the graph", () => {
    expect(wiki).toMatch(/Section names are a contract with the Memory wiki UI/);
    expect(wiki).toMatch(/Migrate legacy pages on touch/);
    expect(wiki).toMatch(/Evidence on every Key Interaction and Decision/);
    expect(wiki).toContain('verify_quotes.py');
    expect(wiki).toMatch(/### Step 3H: Write structured facts back to the Papr Memory graph/);
    expect(wiki).toMatch(/`Decision` node/);
    expect(wiki).toMatch(/`Task` node/);
  });
});
