import { describe, expect, it } from "vitest";
import { checkMiniAppCloudReadPatterns } from "../src/gateway/utils/miniAppCloudReadLint.js";

function files(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("checkMiniAppCloudReadPatterns", () => {
  it("flags nested COUNT(*) subqueries", () => {
    const issues = checkMiniAppCloudReadPatterns(
      files({
        "views/stats.ts": `
          const sql = \`
            SELECT
              (SELECT COUNT(*) FROM daily_metrics) AS metrics,
              (SELECT COUNT(*) FROM social_posts) AS posts
          \`;
          fetch('/api/db/query', { body: JSON.stringify({ sql }) });
        `,
      }),
    );
    expect(
      issues.some((i) => i.rule === "cloud-nested-count-subqueries"),
    ).toBe(true);
    expect(issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("flags SELECT * without LIMIT", () => {
    const issues = checkMiniAppCloudReadPatterns(
      files({
        "lib/db.ts": `
          export async function loadItems() {
            return fetch('/api/db/query', {
              body: JSON.stringify({ sql: 'SELECT * FROM menu_items' }),
            });
          }
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "cloud-select-star-no-limit")).toBe(
      true,
    );
  });

  it("allows SELECT * with LIMIT", () => {
    const issues = checkMiniAppCloudReadPatterns(
      files({
        "lib/db.ts": `
          const sql = 'SELECT * FROM menu_items LIMIT 50';
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "cloud-select-star-no-limit")).toBe(
      false,
    );
  });

  it("flags tab navigation refetch without cache", () => {
    const issues = checkMiniAppCloudReadPatterns(
      files({
        "app.ts": `
          function render() {
            loadAll();
          }
          function showTab(id) {
            render();
          }
          async function loadAll() {
            await fetch('/api/db/query', { body: '{}' });
            await fetch('/api/db/query', { body: '{}' });
            await fetch('/api/db/query', { body: '{}' });
          }
          document.addEventListener('click', () => showTab('a'));
        `,
      }),
    );
    expect(issues.some((i) => i.rule === "cloud-tab-refetch-storm")).toBe(
      true,
    );
  });

  it("skips backend SQL", () => {
    const issues = checkMiniAppCloudReadPatterns(
      files({
        "backend/stats.py": `
          sql = "SELECT (SELECT COUNT(*) FROM t1), (SELECT COUNT(*) FROM t2)"
        `,
      }),
    );
    expect(issues).toHaveLength(0);
  });
});
