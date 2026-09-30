# Tools

Environment-specific notes — installed CLIs, configured API keys, host quirks, path conventions.

## System

(OS, architecture, installed runtimes — discovered and updated by the agent)

## Installed Tools

(CLIs, package managers, utilities the agent has confirmed are available)

## API Keys Configured

(Which custom keys the user has set up in Settings — names only, never values)

## Path Conventions

- **PAPR base:** `~/Papr/` (contains `.active-workspace.json` pointer)
- **Active workspace:** `$PAPR_HOME` = `~/Papr/orgs/{orgId}/namespaces/{nsId}/` (see `docs/PAPR_WORKSPACE_PATHS.md`)
- Jobs: `$PAPR_HOME/Jobs/{jobId}/`
- Apps: `$PAPR_HOME/apps/{appId}/`
- Documents: `$PAPR_HOME/documents/{docId}/`
- Workspace: `$PAPR_HOME/workspace/`
- Daily logs: `$PAPR_HOME/workspace/memory/YYYY-MM-DD.md`

## Known Quirks

(Environment-specific issues, workarounds, or notes the agent has discovered)

---

**Note:** This file is updated as the agent discovers new tools, APIs, or environment details during sessions.
