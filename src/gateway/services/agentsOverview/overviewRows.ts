/**
 * The read behind the Agents page: plain numeric columns from `messages`
 * joined to the per-turn `turn_facts` row (see turnFacts.ts). No tool-call
 * JSON is touched here; that was unpacked once when the fact was written.
 */

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
         f.tools, f.bash_intents,
         f.app_id AS fact_app_id, f.repo AS fact_repo,
         COALESCE(f.has_edit, 0) AS has_edit, COALESCE(f.has_test, 0) AS has_test,
         COALESCE(f.has_build, 0) AS has_build, COALESCE(f.has_data, 0) AS has_data
  FROM messages m
  LEFT JOIN turn_facts f ON f.message_id = m.id
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
  /** JSON object: bash intent → count. */
  bash_intents: string | null;
  fact_app_id: string | null;
  fact_repo: string | null;
  has_edit: number;
  has_test: number;
  has_build: number;
  has_data: number;
}

export interface OverviewChatMeta {
  id: string;
  title: string | null;
  summary_short: string | null;
}
