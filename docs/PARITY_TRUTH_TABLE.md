# V1 Parity Truth Table

This document is the current source of truth for V1 parity status.
It reconciles `PLAN.md`, `docs/TOOL_GAPS.md`, and implemented code paths.

## Legend

- `Implemented`: shipped and wired end-to-end.
- `Partial`: backend or UI exists, but not complete end-to-end.
- `Missing`: not implemented yet.

## Track A: Core Chat Quality

| Area | Status | Evidence |
|---|---|---|
| Chat streaming pipeline | Implemented | `src/gateway/websocket/agent.ts`, `src/gateway/services/agent/streamOrchestrator.ts`, `ui/hooks/useAgent.ts` |
| Chat persistence | Implemented | `src/gateway/services/storage/LocalStorageProvider.ts`, `src/gateway/services/StorageManager.ts` |
| Title generation + fallback | Implemented | `src/gateway/services/TitleGenerationService.ts`, `src/gateway/services/agent/fallbackTitle.ts` |
| History hydration in UI | Implemented | `ui/components/Chat/ChatContainer.tsx`, `ui/utils/chatHistoryApi.ts` |
| Rich context replay (thinking/tool activity) | Implemented | `src/gateway/services/agent/historyFormatter.ts`, `src/gateway/services/storage/LocalStorageProvider.ts` |
| Local summarization generation | Partial | `src/gateway/services/storage/LocalStorageProvider.ts` (`fetchAndCacheSummary` TODO) |

## Track B: Tools + Security

| Area | Status | Evidence |
|---|---|---|
| Bash tool | Implemented | `src/core/tools/bash.ts` |
| Filesystem tools | Implemented | `src/core/tools/filesystem.ts` |
| Key permission bridge | Implemented | `src/gateway/permissions/GatewayPermissionBridge.ts`, `src/electron/ipc/permissions.ts` |
| Permission modal UI wiring | Implemented | `ui/App.tsx`, `ui/components/Permissions/KeyPermissionModal.tsx`, `ui/hooks/useKeyPermissions.ts` |
| Key storage + resolver | Implemented | `src/core/storage/CustomKeysStorage.ts`, `src/gateway/utils/keyResolver.ts` |
| Output sanitization + truncation | Implemented | `src/core/tools/security.ts` |

## Priority C: Jobs + Mini-Apps

| Area | Status | Evidence |
|---|---|---|
| Jobs service/backend | Implemented | `src/gateway/services/JobsService.ts`, `src/gateway/websocket/jobs.ts` |
| Jobs UI | Implemented | `ui/components/Jobs/JobsView.tsx`, `ui/hooks/useJobs.ts`, `ui/components/Layout/ContentArea.tsx` |
| Mini-app CRUD backend | Implemented | `src/gateway/services/AppService.ts`, `src/gateway/websocket/app.ts` |
| Mini-app run/render in tab | Implemented | `src/gateway/index.ts` (app file route), `ui/components/Apps/MiniAppView.tsx`, `ui/components/Layout/ContentArea.tsx` |
| App creation/open UX | Implemented | `ui/components/Artifacts/ArtifactsView.tsx`, `ui/components/Artifacts/ArtifactCard.tsx` |

## Priority D: Browser + Skills

| Area | Status | Evidence |
|---|---|---|
| Browser tools | Implemented | `src/core/tools/browser.ts`, `src/core/tools/index.ts` |
| Skills backend | Implemented | `src/gateway/services/SkillService.ts`, `src/gateway/websocket/skill.ts` |
| Skills UI | Implemented | `ui/components/Skills/SkillsView.tsx`, `ui/components/Layout/ContentArea.tsx` |
| Skills agent tools | Implemented | `src/core/tools/skills.ts`, `src/core/tools/index.ts` |

## Priority E: Documents + Memory

| Area | Status | Evidence |
|---|---|---|
| Document CRUD backend + UI | Implemented | `src/gateway/services/DocumentService.ts`, `src/gateway/websocket/document.ts`, `ui/hooks/useArtifacts.ts` |
| Document agent tools | Implemented | `src/core/tools/documents.ts`, `src/core/tools/index.ts` |
| PAPR memory storage providers | Implemented | `src/gateway/services/storage/PaprMemoryProvider.ts`, `src/gateway/services/storage/HybridStorageProvider.ts` |
| Agent memory tools | Implemented | `src/core/tools/paprMemory.ts`, `src/core/tools/index.ts` |

## Remaining High-Risk Gaps

- Local summary generation in pure local mode remains TODO in `LocalStorageProvider`.
- Migration tool from V1 JSONL to V2 store is required for full historical carryover.
