/** M9: durable, principal-bound two-phase control operations. */
export const SCHEMA_0003 = `
CREATE TABLE prepared_operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  payload TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  committed_at INTEGER
) STRICT;
CREATE INDEX ix_prepared_operations_owner ON prepared_operations (workspace_id, principal_id);
`;
