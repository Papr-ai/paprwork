# Papr Workspace Paths (Org / Namespace)

**Audience:** Agents, developers, and anyone writing docs or bash paths  
**Last updated:** 2026-07-28

Desktop Paprwork stores apps, jobs, and workspace data under an **active org/namespace workspace**, not at the flat `~/Papr/apps/` root (legacy layout).

---

## Canonical layout

```
~/Papr/
  .active-workspace.json          ← pointer to active workspace
  orgs/{organizationId}/
    namespaces/{namespaceId}/
      apps/{appId}/               ← mini-app source
      Jobs/{jobId}/               ← job code, logs, data/
      data/                       ← apps.json, jobs.json, plans.db, databases/
      workspace/                  ← MEMORY.md, BRAND.md, entities/
      documents/
      bundles/
      Chats/                      ← exported chat .txt files (ChatExporter)
```

**Runtime data** (SQLite chat store, code index) lives separately:

```
~/.paprwork-v2/orgs/{organizationId}/namespaces/{namespaceId}/
  chats.db
  code-index.db
  ...
```

---

## Shorthand for docs and agents

| Symbol | Meaning |
|--------|---------|
| **`$PAPR_HOME`** | Active workspace root from `.active-workspace.json` (org/namespace path above) |
| **`$PAPR_USER_DATA`** | Active runtime dir under `~/.paprwork-v2/orgs/.../namespaces/.../` |
| **`$PAPR_HOME/apps/{appId}/`** | Mini-app files — prefer `read_app_file` / `edit_app_file` / `edit_app_file_lines` |
| **`$PAPR_HOME/Jobs/{jobId}/`** | Job folder — prefer `list_jobs` + `edit_file` on returned `dir` |
| **`$PAPR_HOME/data/`** | Index files: `apps.json`, `jobs.json`, `plans.db`, `settings.json`, … |
| **`$PAPR_HOME/Chats/`** | Exported chat transcripts (`.txt`) for grep/bash search |

**Papr base** (not org/namespace): `~/Papr/stripe-project/` — Stripe Projects CLI working dir only.

Example (your IDs differ):

```text
$PAPR_HOME = ~/Papr/orgs/Y8D4H7Yp3Z/namespaces/onnNQFe3DN
$PAPR_HOME/apps/94658b18-.../index.html
$PAPR_HOME/Jobs/8a323066-.../code/collector.py
$PAPR_HOME/data/apps.json
```

---

## Legacy flat layout (do not use for new work)

Before org/namespace workspaces, everything lived at:

```text
~/Papr/apps/
~/Papr/Jobs/    (or ~/Papr/jobs/)
~/Papr/data/
```

Migration moves these into the active namespace after **user consent** in **Settings → Migration**. After migration, run:

```bash
npm run repair:post-migration -- --dry-run   # preview
npm run repair:post-migration                # apply
```

That repairs `data-sources.json`, `jobs.json` commands, job `code/`, and mini-app source paths to `$PAPR_HOME`, `$JOB_DIR`, and `$JOB_DB`. **Agents must not write to flat `~/Papr/apps/`** when org/namespace layout is active — those paths create orphan files. Use app/job tools or paths under `$PAPR_HOME`.

---

## How agents discover paths

1. **System prompt** — each turn includes `# Active Papr Workspace Paths` with org id, namespace id, and roots.
2. **`get_papr_workspace` tool** — returns `organizationId`, `namespaceId`, `paprHome`, `appsRoot`, `jobsRoot`, `dataDir`.
3. **`list_apps`** — returns `appsRoot`, `paprHome`.
4. **`list_app_files`** — returns `appPath` for a given app.
5. **`list_jobs`** — each job includes `dir` under active `Jobs/` root.

**Prefer tools over constructing paths.** Use `appId` / `jobId` with app and job tools whenever possible.

---

## Org / namespace switching (users)

Switching org or namespace is a **user UI action** (Settings → workspace selector). It updates `.active-workspace.json` and reloads the gateway. Agents should not switch orgs unless the user explicitly asks.

- **`list_namespace_users`** — Papr Memory ACL / sharing (Parse user ids), not path discovery.
- **`papr:list-organizations` / `papr:switch-namespace`** — Electron IPC for the UI, not agent tools.

---

## Path guards (implementation)

| Action | Legacy `~/Papr/apps/...` | Active `$PAPR_HOME/apps/...` |
|--------|--------------------------|-------------------------------|
| `write_file` | Blocked (misroute error) | Blocked — use app file tools |
| `edit_file` | Rewritten → active workspace | Routes to mini-app pipeline |
| `read_file` | Rewritten → active workspace | Normal read |
| `read_app_file` / `edit_app_file` | Always correct (by `appId`) | Always correct |

---

## Related code

- `src/core/utils/paprWorkspace.ts` — pointer file, migration
- `src/core/utils/paprRoot.ts` — `getPaprRoot()`, `getPaprAppsRoot()`, `getPaprJobsRoot()`
- `src/core/utils/paprAgentPaths.ts` — legacy path rewrite + write guards
- `tests/papr-workspace.test.ts` — path resolution tests
