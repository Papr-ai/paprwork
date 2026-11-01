/** SQLite schema + row mapping for the notices table. */
import type {
  Notice,
  NoticeAction,
  NoticeLevel,
  NoticeMark,
  NoticeOwnerKind,
  NoticeSourceType,
  NoticeType,
} from "../../../core/types/notices.js";

export const NOTICES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    type TEXT NOT NULL,
    level TEXT NOT NULL,
    mark TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_name TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    owner_section TEXT,
    resolve_group TEXT,
    actions TEXT,
    count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    seen_at TEXT,
    resolved_at TEXT,
    expires_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notices_open_key ON notices(key) WHERE resolved_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_notices_open_owner ON notices(owner_kind, owner_id) WHERE resolved_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_notices_group ON notices(resolve_group) WHERE resolved_at IS NULL;
`;

export interface NoticeRow {
  id: string;
  key: string;
  kind: string;
  type: string;
  level: string;
  mark: string;
  title: string;
  body: string | null;
  source_type: string;
  source_id: string;
  source_name: string;
  owner_kind: string;
  owner_id: string;
  owner_name: string;
  owner_section: string | null;
  resolve_group: string | null;
  actions: string | null;
  count: number;
  created_at: string;
  updated_at: string;
  seen_at: string | null;
  resolved_at: string | null;
  expires_at: string | null;
}

function parseActions(raw: string | null): NoticeAction[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NoticeAction[]) : undefined;
  } catch {
    return undefined;
  }
}

export function rowToNotice(r: NoticeRow): Notice {
  return {
    id: r.id,
    key: r.key,
    kind: r.kind,
    type: r.type as NoticeType,
    level: r.level as NoticeLevel,
    mark: r.mark as NoticeMark,
    title: r.title,
    ...(r.body ? { body: r.body } : {}),
    source: { type: r.source_type as NoticeSourceType, id: r.source_id, name: r.source_name },
    owner: {
      kind: r.owner_kind as NoticeOwnerKind,
      id: r.owner_id,
      name: r.owner_name,
      ...(r.owner_section ? { section: r.owner_section } : {}),
    },
    ...(r.resolve_group ? { resolveGroup: r.resolve_group } : {}),
    ...(parseActions(r.actions) ? { actions: parseActions(r.actions) } : {}),
    count: r.count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.seen_at ? { seenAt: r.seen_at } : {}),
    ...(r.resolved_at ? { resolvedAt: r.resolved_at } : {}),
    ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
  };
}
