/** M7: bearer tokens for the HTTP API and other remote surfaces. Only a hash of the secret is stored. */
export const SCHEMA_0002 = `
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  name TEXT NOT NULL, secret_sha256 TEXT NOT NULL,
  role_ceiling TEXT NOT NULL CHECK (role_ceiling IN ('viewer','operator','approver','admin')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER, last_used_at INTEGER
) STRICT;
CREATE INDEX ix_api_tokens_principal ON api_tokens (workspace_id, principal_id);
`;
