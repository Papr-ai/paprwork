import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertValidWikiGraphQLSelection } from "../src/gateway/services/wikiGraphqlUtils.js";
import { SLEEP_PROMPT_VERSION } from "../src/gateway/services/SleepCycleService.js";
import { WIKI_WRITER_PROMPT_VERSION } from "../src/gateway/services/WikiWriterService.js";

const templatesDir = join(process.cwd(), "src/resources/workspace-templates");

function readTemplate(name: string): string {
  return readFileSync(join(templatesDir, name), "utf8");
}

/** Extract query_memory_graph query strings from template markdown. */
function extractGraphQueries(content: string): string[] {
  const queries: string[] = [];
  const re = /query_memory_graph\(\{\s*query:\s*"(\{[^"]+\})"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    queries.push(match[1].replace(/\\"/g, '"'));
  }
  return queries;
}

describe("Sleep/Wiki prompt templates", () => {
  it("bumps version constants match template headers", () => {
    const sleep = readTemplate("SLEEP.md");
    const wiki = readTemplate("WIKI_WRITER.md");
    expect(sleep).toMatch(/sleep-prompt-version:\s*17/);
    expect(wiki).toMatch(/wiki-writer-prompt-version:\s*8/);
    expect(SLEEP_PROMPT_VERSION).toBe(17);
    expect(WIKI_WRITER_PROMPT_VERSION).toBe(8);
  });

  it("does not prescribe known-broken GraphQL patterns in query strings", () => {
    const queries = [
      ...extractGraphQueries(readTemplate("SLEEP.md")),
      ...extractGraphQueries(readTemplate("WIKI_WRITER.md")),
    ];
    expect(queries.length).toBeGreaterThan(0);

    for (const query of queries) {
      expect(query).not.toMatch(/\bfirst:\s*\d+/);
      expect(query).not.toMatch(/\b(title|updated_at|industry|status)\b/);
      expect(query).not.toMatch(/name_CONTAINS/);
      expect(query).not.toMatch(/sort:\s*\[\{\s*updated_at:\s*DESC\s*\}\]/);
      if (!query.includes("where:")) {
        expect(query).toMatch(/\blimit:\s*\d+/);
      }
    }
  });

  it("all embedded GraphQL selections pass local validation", () => {
    const sleepQueries = extractGraphQueries(readTemplate("SLEEP.md"));
    const wikiQueries = extractGraphQueries(readTemplate("WIKI_WRITER.md"));
    expect(sleepQueries.length).toBeGreaterThan(0);
    expect(wikiQueries.length).toBeGreaterThan(0);

    for (const query of [...sleepQueries, ...wikiQueries]) {
      const inner = query.replace(/^\{/, "").replace(/\}$/, "").trim();
      expect(() => assertValidWikiGraphQLSelection(inner)).not.toThrow();
    }
  });

  it("prescribes schema-first graph read workflow", () => {
    const combined = [readTemplate("SLEEP.md"), readTemplate("WIKI_WRITER.md")].join(
      "\n",
    );
    expect(combined).toMatch(/list_schemas\(\{ statusFilter: "active" \}\)/);
    expect(combined).toMatch(/introspect_memory_graph\(\)/);
    expect(combined).toMatch(/WorkspaceContext/);
  });

  it("prescribes safe list pagination patterns", () => {
    const combined = [readTemplate("SLEEP.md"), readTemplate("WIKI_WRITER.md")].join(
      "\n",
    );
    expect(combined).toMatch(/people\(limit:/);
    expect(combined).toMatch(/companies\(limit:/);
    expect(combined).toMatch(/people\(limit: \d+\) \{ id name \}/);
  });
});
