/**
 * The one scan behind the Agents page: every billed assistant turn in the
 * window, with its tool calls reduced to the few strings attribution needs.
 *
 * `tool_calls` averages ~130KB a row (args carry whole file bodies), so the
 * reduction happens inside SQLite — 30 days is ~250MB of JSON in, ~7MB out.
 * Runs on the chat-storage read worker, never the gateway thread.
 */

const SAFE_CALLS = `json_each(CASE WHEN json_valid(m.tool_calls) THEN m.tool_calls ELSE '[]' END)`;

export const OVERVIEW_ROWS_SQL = `
  SELECT m.id, m.chat_id, m.timestamp, m.model,
         COALESCE(m.source_agent_id, 'main-agent') AS agent_id,
         COALESCE(m.cost, 0) AS cost,
         COALESCE(m.prompt_tokens, 0) AS fresh,
         COALESCE(m.cache_read_tokens, 0) AS cache_read,
         COALESCE(m.cache_write_tokens, 0) AS cache_write,
         COALESCE(m.completion_tokens, 0) AS output,
         m.turn_peak_context_tokens AS peak,
         m.turn_steps AS steps,
         m.turn_billing AS billing,
         m.turn_app_id AS app_id,
         m.turn_repo AS repo,
         (SELECT group_concat(json_extract(j.value, '$.name'), ',') FROM ${SAFE_CALLS} j) AS tools,
         (SELECT group_concat(
            COALESCE(json_extract(j.value, '$.args.path'), '') || ' ' ||
            COALESCE(json_extract(j.value, '$.args.cwd'), '') || ' ' ||
            COALESCE(json_extract(j.value, '$.args.appId'), '') || ' ' ||
            substr(COALESCE(json_extract(j.value, '$.args.command'), ''), 1, 300), char(10))
          FROM ${SAFE_CALLS} j) AS targets,
         (SELECT group_concat(substr(json_extract(j.value, '$.args.command'), 1, 160), char(30))
          FROM ${SAFE_CALLS} j WHERE json_extract(j.value, '$.name') = 'bash') AS bash
  FROM messages m
  WHERE m.role = 'assistant' AND COALESCE(m.prompt_tokens, 0) > 0 AND m.timestamp >= ?
  ORDER BY m.timestamp ASC`;

export const OVERVIEW_CHATS_SQL = `
  SELECT c.id, c.title, c.summary_short
  FROM chats c
  WHERE c.id IN (
    SELECT DISTINCT chat_id FROM messages
    WHERE role = 'assistant' AND COALESCE(prompt_tokens, 0) > 0 AND timestamp >= ?
  )`;

export interface OverviewRow {
  id: string;
  chat_id: string;
  timestamp: string;
  model: string | null;
  agent_id: string;
  cost: number;
  fresh: number;
  cache_read: number;
  cache_write: number;
  output: number;
  peak: number | null;
  steps: number | null;
  billing: string | null;
  app_id: string | null;
  repo: string | null;
  tools: string | null;
  targets: string | null;
  bash: string | null;
}

export interface OverviewChatMeta {
  id: string;
  title: string | null;
  summary_short: string | null;
}
