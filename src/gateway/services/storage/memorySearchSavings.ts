import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { resolvePaprUserDataPath } from "../../../core/utils/paprWorkspace.js";

const CHARS_PER_TOKEN = 4;
/** Rough chars/line when we only have lines_of_code from index metadata */
const CHARS_PER_LINE_ESTIMATE = 40;

const MEMORY_SEARCH_TOOLS = new Set([
  "search_agent_memory",
  "search_memory",
]);

const HYBRID_MEMORY_HEADER = "=== Memory Search Results (Semantic) ===";

export interface MemorySearchHit {
  filePath: string;
  returnedChars: number;
  sourceChars: number;
  source: "disk" | "code_index" | "metadata" | "unknown";
}

export interface MemorySearchSavingsResult {
  tokensSaved: number;
  memorySearchCount: number;
  hybridBashCount: number;
  hitsAnalyzed: number;
  hitsWithSource: number;
  fullReadAvgTokens: number;
  memorySearchAvgTokens: number;
}

interface ToolCallRecord {
  name?: string;
  result?: unknown;
}

interface MemoryRecordLike {
  content?: string;
  customMetadata?: Record<string, unknown>;
  metadata?: { customMetadata?: Record<string, unknown> };
}

function charsToTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN));
}

function stringifyResult(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapToolResult(result: unknown): unknown {
  if (!isRecord(result)) return result;

  if ("data" in result) {
    const data = result.data;
    if (isRecord(data) && "data" in data) {
      return data.data;
    }
    return data;
  }

  return result;
}

function extractMemoriesFromSearchResult(result: unknown): MemoryRecordLike[] {
  const unwrapped = unwrapToolResult(result);
  if (!isRecord(unwrapped)) return [];

  const memories = unwrapped.memories;
  if (!Array.isArray(memories)) return [];

  return memories.filter(
    (entry): entry is MemoryRecordLike =>
      typeof entry === "object" && entry !== null,
  );
}

function getMemoryMetadata(
  memory: MemoryRecordLike,
): Record<string, unknown> | undefined {
  if (isRecord(memory.customMetadata)) {
    return memory.customMetadata;
  }
  if (isRecord(memory.metadata?.customMetadata)) {
    return memory.metadata.customMetadata;
  }
  return undefined;
}

function parseFilePathsFromHybridBash(stdout: string): string[] {
  const headerIndex = stdout.indexOf(HYBRID_MEMORY_HEADER);
  if (headerIndex < 0) return [];

  const sectionEnd = stdout.indexOf("=== Grep Results", headerIndex);
  const section =
    sectionEnd >= 0
      ? stdout.slice(headerIndex, sectionEnd)
      : stdout.slice(headerIndex);

  const paths: string[] = [];
  for (const line of section.split("\n")) {
    const match = line.match(/^📄\s+(.+)$/);
    if (match?.[1]) {
      paths.push(match[1].trim());
    }
  }
  return paths;
}

function resolveSourceFileChars(
  filePath: string,
  metadata: Record<string, unknown> | undefined,
  codeIndexDb: Database.Database | null,
): { chars: number; source: MemorySearchHit["source"] } {
  if (codeIndexDb) {
    const row = codeIndexDb
      .prepare(
        `SELECT lines_of_code FROM indexed_files WHERE file_path = ? LIMIT 1`,
      )
      .get(filePath) as { lines_of_code: number } | undefined;
    if (row?.lines_of_code) {
      return {
        chars: row.lines_of_code * CHARS_PER_LINE_ESTIMATE,
        source: "code_index",
      };
    }
  }

  // Never read source files from disk here — sync I/O blocks the gateway for seconds.

  const linesOfCode =
    typeof metadata?.lines_of_code === "number"
      ? metadata.lines_of_code
      : undefined;
  if (linesOfCode && linesOfCode > 0) {
    return {
      chars: linesOfCode * CHARS_PER_LINE_ESTIMATE,
      source: "metadata",
    };
  }

  return { chars: 0, source: "unknown" };
}

function buildHitsFromMemories(
  memories: MemoryRecordLike[],
  codeIndexDb: Database.Database | null,
): MemorySearchHit[] {
  const hits: MemorySearchHit[] = [];

  for (const memory of memories) {
    const metadata = getMemoryMetadata(memory);
    const filePath =
      typeof metadata?.file_path === "string" ? metadata.file_path : undefined;
    if (!filePath) continue;

    const returnedChars =
      typeof memory.content === "string" ? memory.content.length : 0;
    const source = resolveSourceFileChars(filePath, metadata, codeIndexDb);

    hits.push({
      filePath,
      returnedChars,
      sourceChars: source.chars,
      source: source.source,
    });
  }

  return hits;
}

function buildHitsFromHybridBash(
  stdout: string,
  codeIndexDb: Database.Database | null,
): MemorySearchHit[] {
  const headerIndex = stdout.indexOf(HYBRID_MEMORY_HEADER);
  if (headerIndex < 0) return [];

  const sectionEnd = stdout.indexOf("=== Grep Results", headerIndex);
  const section =
    sectionEnd >= 0
      ? stdout.slice(headerIndex, sectionEnd)
      : stdout.slice(headerIndex);

  const returnedSectionChars = section.length;
  const filePaths = parseFilePathsFromHybridBash(stdout);
  if (filePaths.length === 0) return [];

  const perFileReturned = Math.floor(returnedSectionChars / filePaths.length);
  const hits: MemorySearchHit[] = [];

  for (const filePath of filePaths) {
    const source = resolveSourceFileChars(filePath, undefined, codeIndexDb);
    hits.push({
      filePath,
      returnedChars: perFileReturned,
      sourceChars: source.chars,
      source: source.source,
    });
  }

  return hits;
}

function savingsFromHits(hits: MemorySearchHit[]): number {
  return hits.reduce(
    (sum, hit) => sum + Math.max(0, hit.sourceChars - hit.returnedChars),
    0,
  );
}

function openCodeIndexDb(): Database.Database | null {
  const dbPath = path.join(resolvePaprUserDataPath(), "code-index.db");
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

export function computeMemorySearchSavings(
  db: Database.Database,
): MemorySearchSavingsResult {
  const codeIndexDb = openCodeIndexDb();

  try {
    const rows = db
      .prepare(
        `SELECT tool_calls FROM messages
         WHERE role = 'assistant'
           AND tool_calls IS NOT NULL
           AND tool_calls != ''
           AND (
             tool_calls LIKE '%"search_agent_memory"%'
             OR tool_calls LIKE '%"search_memory"%'
             OR tool_calls LIKE '%Memory Search Results (Semantic)%'
           )
         ORDER BY timestamp DESC
         LIMIT 500`,
      )
      .all() as Array<{ tool_calls: string }>;

    let memorySearchCount = 0;
    let hybridBashCount = 0;
    let totalCharsSaved = 0;
    let hitsAnalyzed = 0;
    let hitsWithSource = 0;
    const memoryResultSizes: number[] = [];
    const readSizes: number[] = [];

    for (const row of rows) {
      try {
        const toolCalls = JSON.parse(row.tool_calls) as ToolCallRecord[];
        for (const call of toolCalls) {
          const name = typeof call.name === "string" ? call.name : "";

          if (MEMORY_SEARCH_TOOLS.has(name)) {
            memorySearchCount++;
            const resultStr = stringifyResult(call.result);
            if (resultStr.length > 0) {
              memoryResultSizes.push(resultStr.length);
            }

            const hits = buildHitsFromMemories(
              extractMemoriesFromSearchResult(call.result),
              codeIndexDb,
            );
            hitsAnalyzed += hits.length;
            hitsWithSource += hits.filter((hit) => hit.sourceChars > 0).length;
            totalCharsSaved += savingsFromHits(hits);
            continue;
          }

          if (name === "bash") {
            const stdout = extractBashStdout(call.result);
            if (stdout.includes(HYBRID_MEMORY_HEADER)) {
              hybridBashCount++;
              const hits = buildHitsFromHybridBash(stdout, codeIndexDb);
              hitsAnalyzed += hits.length;
              hitsWithSource += hits.filter((hit) => hit.sourceChars > 0).length;
              totalCharsSaved += savingsFromHits(hits);
            }
            if (stdout.length > 0) {
              readSizes.push(stdout.length);
            }
            continue;
          }

          if (
            (name === "read_file" ||
              name === "read_app_file" ||
              name === "read_job_file") &&
            call.result !== undefined
          ) {
            readSizes.push(stringifyResult(call.result).length);
          }
        }
      } catch {
        // Ignore malformed tool_calls JSON
      }
    }

    const avg = (values: number[]): number =>
      values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;

    const measuredTokensSaved = charsToTokens(totalCharsSaved);
    const hasMeasuredHits = hitsWithSource > 0;

    // Fallback when memories lack file_path metadata (conversation search, etc.)
    const fallbackPerSearch =
      memorySearchCount > 0
        ? Math.max(
            3000,
            charsToTokens(avg(readSizes) || 10_000) * 3 -
              charsToTokens(avg(memoryResultSizes) || 2000),
          )
        : 0;
    const fallbackTokens =
      memorySearchCount > 0 ? memorySearchCount * fallbackPerSearch : 0;

    return {
      tokensSaved: hasMeasuredHits ? measuredTokensSaved : fallbackTokens,
      memorySearchCount: memorySearchCount + hybridBashCount,
      hybridBashCount,
      hitsAnalyzed,
      hitsWithSource,
      fullReadAvgTokens: charsToTokens(avg(readSizes)),
      memorySearchAvgTokens: charsToTokens(avg(memoryResultSizes)),
    };
  } finally {
    codeIndexDb?.close();
  }
}

function extractBashStdout(result: unknown): string {
  const unwrapped = unwrapToolResult(result);
  if (!isRecord(unwrapped)) return "";

  if (typeof unwrapped.stdout === "string") {
    return unwrapped.stdout;
  }

  if (isRecord(unwrapped.data) && typeof unwrapped.data.stdout === "string") {
    return unwrapped.data.stdout;
  }

  return "";
}
