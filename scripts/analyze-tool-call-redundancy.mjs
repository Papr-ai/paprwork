#!/usr/bin/env node
/**
 * Analyze tool call redundancy across Paprwork chat history.
 *
 * Reads ~/.paprwork-v2/chats.db (override with CHATS_DB env var).
 * Extracts tool name + args only (skips bulky result payloads).
 *
 * Usage:
 *   node scripts/analyze-tool-call-redundancy.mjs
 *   node scripts/analyze-tool-call-redundancy.mjs --limit 500 --json
 */

import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const limitIdx = args.indexOf("--limit");
const chatLimit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 300;

const dbPath = process.env.CHATS_DB ?? join(homedir(), ".paprwork-v2", "chats.db");

const FILE_READ_TOOLS = new Set([
  "read_file",
  "read_app_file",
  "read_job_file",
]);

const NOISE_TOOLS = new Set([
  "bash",
  "list_directory",
  "list_app_files",
  "list_job_files",
  "search_files",
  "validate_app",
  "webview_snapshot",
  "webview_execute",
]);

const CACHE_CANDIDATE_TOOLS = new Set([
  ...FILE_READ_TOOLS,
  "get_project_code_overview",
  "get_file_code_summary",
  "list_file_code_summaries",
  "list_schemas",
  "read_skill",
]);

function parseToolArgs(argsJson) {
  if (!argsJson) return {};
  try {
    let parsed = typeof argsJson === "string" ? JSON.parse(argsJson) : argsJson;
    if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function canonicalToolKey(name, argsJson) {
  const toolArgs = parseToolArgs(argsJson);

  if (
    name === "read_app_file" ||
    name === "edit_app_file" ||
    name === "edit_app_file_lines"
  ) {
    const filename = toolArgs.filename ?? toolArgs.file ?? toolArgs.path;
    return `${name}:app:${toolArgs.appId}/${filename ?? "?"}`;
  }
  if (name === "read_job_file" || name === "edit_job_file") {
    return `${name}:job:${toolArgs.jobId}/${toolArgs.filename ?? toolArgs.file}`;
  }
  if (name === "read_file" || name === "write_file") {
    return `${name}:file:${toolArgs.path ?? toolArgs.filePath}`;
  }
  if (name === "bash") {
    const cmd = typeof toolArgs.command === "string" ? toolArgs.command : "";
    return `bash:${cmd.replace(/\s+/g, " ").trim().slice(0, 160)}`;
  }
  if (name === "get_file_code_summary") {
    return `${name}:${toolArgs.projectId}/${toolArgs.filePath}`;
  }
  if (name === "get_project_code_overview" || name === "list_file_code_summaries") {
    return `${name}:${toolArgs.projectId}`;
  }
  if (name === "search_agent_memory") {
    const q = typeof toolArgs.query === "string" ? toolArgs.query.slice(0, 60) : "";
    return `search:${toolArgs.category ?? "any"}:${toolArgs.projectId ?? ""}:${q}`;
  }

  return `${name}:${JSON.stringify(toolArgs).slice(0, 100)}`;
}

function querySqlite(sql) {
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!out.trim()) return [];
  return JSON.parse(out);
}

function main() {
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const chatCount = querySqlite("SELECT COUNT(*) AS n FROM chats")[0]?.n ?? 0;

  const chatFilter =
    chatLimit > 0
      ? `AND m.chat_id IN (SELECT id FROM chats ORDER BY updated_at DESC LIMIT ${chatLimit})`
      : "";

  const globalToolCounts = querySqlite(`
    SELECT json_extract(j.value, '$.name') AS tool_name, COUNT(*) AS cnt
    FROM messages m, json_each(m.tool_calls) AS j
    WHERE m.tool_calls IS NOT NULL
      AND m.tool_calls != '[]'
      AND m.tool_calls != ''
    GROUP BY tool_name
    ORDER BY cnt DESC
    LIMIT 25
  `);

  const globalTotalCalls = querySqlite(`
    SELECT COUNT(*) AS n
    FROM messages m, json_each(m.tool_calls) AS j
    WHERE m.tool_calls IS NOT NULL
      AND m.tool_calls != '[]'
      AND m.tool_calls != ''
  `)[0]?.n ?? 0;

  const toolCounts = querySqlite(`
    SELECT json_extract(j.value, '$.name') AS tool_name, COUNT(*) AS cnt
    FROM messages m, json_each(m.tool_calls) AS j
    WHERE m.tool_calls IS NOT NULL
      AND m.tool_calls != '[]'
      AND m.tool_calls != ''
      ${chatFilter}
    GROUP BY tool_name
    ORDER BY cnt DESC
    LIMIT 25
  `);

  const msgCount = querySqlite(`
    SELECT COUNT(*) AS n
    FROM messages m
    WHERE m.tool_calls IS NOT NULL
      AND m.tool_calls != '[]'
      AND m.tool_calls != ''
      ${chatFilter}
  `)[0]?.n ?? 0;

  const totalCalls = querySqlite(`
    SELECT COUNT(*) AS n
    FROM messages m, json_each(m.tool_calls) AS j
    WHERE m.tool_calls IS NOT NULL
      AND m.tool_calls != '[]'
      AND m.tool_calls != ''
      ${chatFilter}
  `)[0]?.n ?? 0;

  // Lightweight rows: name + args only (no results)
  const rows = querySqlite(`
    SELECT
      m.chat_id,
      m.timestamp,
      json_extract(j.value, '$.name') AS tool_name,
      json_extract(j.value, '$.args') AS args_json
    FROM messages m, json_each(m.tool_calls) AS j
    WHERE m.tool_calls IS NOT NULL
      AND m.tool_calls != '[]'
      AND m.tool_calls != ''
      ${chatFilter}
    ORDER BY m.chat_id, m.timestamp
  `);

  const keyTotals = new Map();
  const repeatWithinChat = new Map();
  const keyByChat = new Map();
  let redundantCalls = 0;
  let cacheCandidateRedundant = 0;

  for (const row of rows) {
    const name = row.tool_name ?? "unknown";
    const key = canonicalToolKey(name, row.args_json);
    keyTotals.set(key, (keyTotals.get(key) ?? 0) + 1);

    if (!keyByChat.has(row.chat_id)) {
      keyByChat.set(row.chat_id, new Set());
    }
    const seen = keyByChat.get(row.chat_id);
    if (seen.has(key)) {
      redundantCalls += 1;
      repeatWithinChat.set(key, (repeatWithinChat.get(key) ?? 0) + 1);
      if (CACHE_CANDIDATE_TOOLS.has(name)) {
        cacheCandidateRedundant += 1;
      }
    } else {
      seen.add(key);
    }
  }

  const topRepeatedKeys = [...repeatWithinChat.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);

  const topGlobalKeys = [...keyTotals.entries()]
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  const readRepeatKeys = topRepeatedKeys.filter(([key]) =>
    FILE_READ_TOOLS.has(key.split(":")[0]),
  );

  const report = {
    dbPath,
    chatsInDb: chatCount,
    analyzedRecentChats: chatLimit,
    messagesWithTools: msgCount,
    totalToolCallsInSample: totalCalls,
    globalTotalToolCalls: globalTotalCalls,
    redundantCallsSameChat: redundantCalls,
    redundantPct:
      totalCalls > 0
        ? Number(((redundantCalls / totalCalls) * 100).toFixed(1))
        : 0,
    cacheCandidateRedundant,
    fileReadRedundantCalls: readRepeatKeys.reduce((s, [, n]) => s + n, 0),
    topToolsGlobal: globalToolCounts.map((r) => ({
      name: r.tool_name,
      count: r.cnt,
    })),
    topToolsInSample: toolCounts.map((r) => ({
      name: r.tool_name,
      count: r.cnt,
    })),
    topRepeatedKeys: topRepeatedKeys.map(([key, repeats]) => ({
      key: key.slice(0, 160),
      repeats,
      total: keyTotals.get(key),
    })),
    topGlobalKeys: topGlobalKeys.map(([key, count]) => ({
      key: key.slice(0, 160),
      count,
    })),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("Tool call redundancy analysis");
  console.log("=".repeat(60));
  console.log(`Database: ${dbPath}`);
  console.log(
    `Chats: ${chatCount}${chatLimit > 0 ? ` (last ${chatLimit} chats)` : ""}`,
  );
  console.log(`Messages with tools: ${msgCount}`);
  console.log(`Total tool calls: ${totalCalls}`);
  console.log(
    `Redundant (same name+args repeated in chat): ${redundantCalls} (${report.redundantPct}%)`,
  );
  console.log(`Cache-candidate redundant: ${cacheCandidateRedundant}`);
  console.log(`File-read redundant repeats: ${report.fileReadRedundantCalls}`);
  console.log("");

  console.log(`Global tool calls (all chats): ${globalTotalCalls}`);
  console.log("");

  console.log("Top tools globally:");
  for (const { name, count } of report.topToolsGlobal) {
    const tag = CACHE_CANDIDATE_TOOLS.has(name)
      ? " [cache-worthy]"
      : NOISE_TOOLS.has(name)
        ? " [noise]"
        : "";
    console.log(`  ${String(count).padStart(6)}  ${name}${tag}`);
  }
  console.log("");

  console.log(`Top tools in last ${chatLimit} chats:`);
  for (const { name, count } of report.topToolsInSample) {
    const tag = CACHE_CANDIDATE_TOOLS.has(name)
      ? " [cache-worthy]"
      : NOISE_TOOLS.has(name)
        ? " [noise]"
        : "";
    console.log(`  ${String(count).padStart(6)}  ${name}${tag}`);
  }
  console.log("");

  console.log("Most repeated keys within a chat:");
  for (const item of report.topRepeatedKeys.slice(0, 20)) {
    console.log(
      `  ${String(item.repeats).padStart(5)}x in-chat  (${item.total} total)  ${item.key}`,
    );
  }
}

main();
