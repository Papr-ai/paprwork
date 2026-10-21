/** Opt-in maintenance: typed suppression tombstones and caller-bound retention previews. */
export const SCHEMA_0004 = `
CREATE TABLE suppression_fingerprints (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  scheme TEXT NOT NULL CHECK (scheme = 'sha256-email-v1'),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  reason TEXT NOT NULL CHECK (reason = 'opt_out'),
  effective_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, scheme, digest)
) STRICT;
CREATE TABLE retained_contacts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  pruned_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, contact_id)
) STRICT;
CREATE TABLE retention_previews (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  policy TEXT NOT NULL, operation_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, committed_at INTEGER
) STRICT;
`;
