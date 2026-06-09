import type Database from "better-sqlite3";

export interface ToolCountRow {
  tool: string;
  count: number;
}

/** Cap rows scanned — full-history json_each blocks the gateway for 30s+ */
const TOOL_SCAN_MESSAGE_LIMIT = 1500;

const RECENT_TOOL_MESSAGES_SUBQUERY = `
  SELECT rowid FROM messages
  WHERE role = 'assistant'
    AND tool_calls IS NOT NULL
    AND tool_calls != ''
  ORDER BY timestamp DESC
  LIMIT ${TOOL_SCAN_MESSAGE_LIMIT}`;

/**
 * Count tool invocations via SQLite json_each on a capped recent window.
 */
export function getToolCountsForAgent(
  db: Database.Database,
  agentId: string,
): ToolCountRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT json_extract(j.value, '$.name') AS tool_name, COUNT(*) AS cnt
         FROM messages m, json_each(m.tool_calls) AS j
         WHERE m.rowid IN (${RECENT_TOOL_MESSAGES_SUBQUERY})
           AND COALESCE(m.source_agent_id, 'main-agent') = ?
           AND json_valid(m.tool_calls) = 1
           AND json_extract(j.value, '$.name') IS NOT NULL
         GROUP BY tool_name
         ORDER BY cnt DESC`,
      )
      .all(agentId) as Array<{ tool_name: string; cnt: number }>;

    return rows.map((row) => ({ tool: row.tool_name, count: row.cnt }));
  } catch {
    return [];
  }
}

export function getTotalToolInvocationsForAgent(
  db: Database.Database,
  agentId: string,
): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM messages m, json_each(m.tool_calls) AS j
         WHERE m.rowid IN (${RECENT_TOOL_MESSAGES_SUBQUERY})
           AND COALESCE(m.source_agent_id, 'main-agent') = ?
           AND json_valid(m.tool_calls) = 1`,
      )
      .get(agentId) as { cnt: number };

    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

export function getToolCountsByAgent(
  db: Database.Database,
): Map<string, ToolCountRow[]> {
  try {
    const rows = db
      .prepare(
        `SELECT
           COALESCE(m.source_agent_id, 'main-agent') AS agent_id,
           json_extract(j.value, '$.name') AS tool_name,
           COUNT(*) AS cnt
         FROM messages m, json_each(m.tool_calls) AS j
         WHERE m.rowid IN (${RECENT_TOOL_MESSAGES_SUBQUERY})
           AND json_valid(m.tool_calls) = 1
           AND json_extract(j.value, '$.name') IS NOT NULL
         GROUP BY agent_id, tool_name
         ORDER BY agent_id, cnt DESC`,
      )
      .all() as Array<{ agent_id: string; tool_name: string; cnt: number }>;

    const byAgent = new Map<string, ToolCountRow[]>();
    for (const row of rows) {
      const list = byAgent.get(row.agent_id) ?? [];
      list.push({ tool: row.tool_name, count: row.cnt });
      byAgent.set(row.agent_id, list);
    }
    return byAgent;
  } catch {
    return new Map();
  }
}

export function sumToolInvocations(tools: ToolCountRow[]): number {
  return tools.reduce((sum, row) => sum + row.count, 0);
}
