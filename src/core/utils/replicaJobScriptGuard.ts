/**
 * Scan job script files for sqlite3 opens against Plan A replica-managed DBs.
 * Shell-command guards miss `python3 job.py` when sqlite3.connect lives in the file.
 */

import fs from "fs";
import path from "path";
import {
  detectReplicaRegistrySqliteBlock,
  type ReplicaBashSqliteBlock,
} from "./replicaBashSqliteGuard.js";
import type { SqlitePathGuardContext } from "./sqlitePathGuard.js";

const SCRIPT_SQLITE_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /sqlite3\.connect\s*\(/, label: "sqlite3.connect" },
  { re: /import\s+sqlite3\b/, label: "import sqlite3" },
  { re: /from\s+sqlite3\s+import/, label: "from sqlite3 import" },
  {
    re: /require\s*\(\s*['"]better-sqlite3['"]\s*\)/,
    label: "require('better-sqlite3')",
  },
];

const PAPR_DB_SAFE_RE =
  /(?:from\s+papr_db\s+import|import\s+papr_db|papr_db\.connect\s*\()/;

const SCRIPT_PATH_RE =
  /(?:^|[\s;&|])(?:python3?|node|tsx?)\s+(?:-[^\s]+\s+)*([^\s|;&]+\.(?:py|js|ts|mjs|cjs))\b/i;

function scanContentForReplicaSqliteOpens(content: string): string[] {
  if (PAPR_DB_SAFE_RE.test(content)) {
    return [];
  }
  const hits: string[] = [];
  for (const { re, label } of SCRIPT_SQLITE_PATTERNS) {
    if (re.test(content)) {
      hits.push(label);
    }
  }
  return hits;
}

/** Scan script source for direct sqlite opens (ignoring papr_db usage). */
export function scanJobScriptForReplicaSqliteOpens(
  content: string,
  _ext?: string,
): string[] {
  return scanContentForReplicaSqliteOpens(content);
}

/** Scan inline shell for sqlite opens in -c / heredoc fragments. */
export function scanShellCommandForReplicaSqliteOpens(command: string): string[] {
  return scanContentForReplicaSqliteOpens(command);
}

function extractScriptPathsFromCommand(command: string): string[] {
  const paths = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(SCRIPT_PATH_RE.source, SCRIPT_PATH_RE.flags + "g");
  while ((match = re.exec(command)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate && !candidate.startsWith("-")) {
      paths.add(candidate);
    }
  }
  return [...paths];
}

/**
 * Block job launches when referenced script files open replica-managed SQLite.
 */
export function detectReplicaJobScriptSqliteBlock(
  command: string,
  jobDir: string,
  ctx: SqlitePathGuardContext = {},
): ReplicaBashSqliteBlock | null {
  for (const rel of extractScriptPathsFromCommand(command)) {
    const fullPath = path.resolve(jobDir, rel);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    if (scanContentForReplicaSqliteOpens(content).length === 0) {
      continue;
    }
    const block = detectReplicaRegistrySqliteBlock(content, ctx);
    if (block) {
      return {
        message: `${block.message} (in job script ${rel})`,
      };
    }
  }
  return null;
}
