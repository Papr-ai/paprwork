import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { computeMemorySearchSavings } from "../src/gateway/services/storage/memorySearchSavings.js";

function createChatsDb(toolCallsJson: string): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      role TEXT,
      tool_calls TEXT
    );
  `);
  db.prepare(
    `INSERT INTO messages (id, role, tool_calls) VALUES ('m1', 'assistant', ?)`,
  ).run(toolCallsJson);
  return db;
}

describe("computeMemorySearchSavings", () => {
  it("uses source file size vs returned memory content for code hits", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-memory-save-"));
    const sourceFile = path.join(tempDir, "auth.ts");
    const sourceContent = "export function login() {}\n".repeat(100);
    fs.writeFileSync(sourceFile, sourceContent, "utf8");

    const toolCalls = JSON.stringify([
      {
        name: "search_agent_memory",
        result: {
          success: true,
          data: {
            memories: [
              {
                content: "snippet about login handler",
                customMetadata: {
                  file_path: sourceFile,
                  lines_of_code: 100,
                  source: "code_indexer",
                },
              },
            ],
          },
        },
      },
    ]);

    const db = createChatsDb(toolCalls);
    const stats = computeMemorySearchSavings(db);
    db.close();

    expect(stats.memorySearchCount).toBe(1);
    expect(stats.hitsAnalyzed).toBe(1);
    expect(stats.hitsWithSource).toBe(1);
    expect(stats.tokensSaved).toBeGreaterThan(0);
    expect(stats.tokensSaved).toBeLessThan(
      Math.ceil(sourceContent.length / 4),
    );
  });

  it("parses hybrid bash memory section file paths", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "papr-bash-save-"));
    const sourceFile = path.join(tempDir, "handler.ts");
    fs.writeFileSync(sourceFile, "x".repeat(5000), "utf8");

    const stdout = [
      "=== Memory Search Results (Semantic) ===",
      "Found 1 relevant code files:",
      "",
      `📄 ${sourceFile}`,
      "   Project: app-test",
      "   Language: TypeScript",
      "   Match: auth flow...",
      "",
      "=== Grep Results (Exact Match) ===",
      "no matches",
    ].join("\n");

    const toolCalls = JSON.stringify([
      {
        name: "bash",
        result: {
          success: true,
          data: { stdout, stderr: "", exitCode: 0 },
        },
      },
    ]);

    const db = createChatsDb(toolCalls);
    const stats = computeMemorySearchSavings(db);
    db.close();

    expect(stats.hybridBashCount).toBe(1);
    expect(stats.hitsWithSource).toBe(1);
    expect(stats.tokensSaved).toBeGreaterThan(0);
  });
});
