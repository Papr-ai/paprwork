/**
 * Sub-agent profile integrity: reference tracking, git-pull merge, sidecar recovery.
 *
 * Custom profiles can disappear when cloud git pull replaces data/subagents.json
 * before the profile was ever pushed — apps.json/jobs.json may still reference them.
 */

import { promises as fs, readFileSync } from "fs";
import path from "path";
import type { SubAgentProfile } from "../../../core/types/subagents.js";
import { DEFAULT_APP_AGENT_CHAT_TOOL_IDS } from "../../../core/types/appAgentChat.js";
import { readAgentChatSidecarSync } from "../appAgentChatSidecar.js";

/** Built-in slugs — must stay aligned with SubAgentService DEFAULT_SUB_AGENTS. */
const BUILTIN_SUB_AGENT_IDS = new Set([
  "implementation-specialist",
  "product-architect",
  "research-specialist",
  "sync-code-explorer",
]);

export function isBuiltInSubAgentId(agentId: string): boolean {
  return BUILTIN_SUB_AGENT_IDS.has(agentId.trim());
}

export function isCustomSubAgentId(agentId: string): boolean {
  const id = agentId.trim();
  return id.startsWith("agent-") && !isBuiltInSubAgentId(id);
}

export interface SubAgentReference {
  kind: "app" | "job";
  id: string;
  label: string;
}

export interface OrphanedSubAgentReference {
  subAgentId: string;
  references: SubAgentReference[];
}

function subagentsPath(paprDir: string): string {
  return path.join(paprDir, "data", "subagents.json");
}

export function readSubAgentProfilesSync(paprDir: string): SubAgentProfile[] {
  try {
    const raw = readFileSync(subagentsPath(paprDir), "utf8");
    const list = JSON.parse(raw) as SubAgentProfile[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function readSubAgentProfiles(paprDir: string): Promise<SubAgentProfile[]> {
  try {
    const raw = await fs.readFile(subagentsPath(paprDir), "utf8");
    const list = JSON.parse(raw) as SubAgentProfile[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function writeSubAgentProfiles(
  paprDir: string,
  profiles: SubAgentProfile[],
): Promise<void> {
  const filePath = subagentsPath(paprDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const sorted = [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

function readAppsJson(paprDir: string): Array<Record<string, unknown>> {
  try {
    const raw = readFileSync(path.join(paprDir, "data", "apps.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

function readJobsJson(paprDir: string): Array<Record<string, unknown>> {
  try {
    const raw = readFileSync(path.join(paprDir, "data", "jobs.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as Array<Record<string, unknown>>;
    }
    const jobs = (parsed as { jobs?: unknown }).jobs;
    return Array.isArray(jobs) ? (jobs as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

export function collectSubAgentReferences(
  paprDir: string,
  subAgentId: string,
): SubAgentReference[] {
  const refs: SubAgentReference[] = [];
  const target = subAgentId.trim();

  for (const app of readAppsJson(paprDir)) {
    const agentChat = app.agentChat as { enabled?: boolean; subAgentId?: string } | undefined;
    if (agentChat?.enabled && agentChat.subAgentId?.trim() === target) {
      refs.push({
        kind: "app",
        id: String(app.id ?? "unknown"),
        label: String(app.title ?? app.id ?? "app"),
      });
    }
  }

  for (const job of readJobsJson(paprDir)) {
    if (job.type === "subagent" && String(job.subAgentId ?? "").trim() === target) {
      refs.push({
        kind: "job",
        id: String(job.id ?? "unknown"),
        label: String(job.name ?? job.id ?? "job"),
      });
    }
  }

  return refs;
}

export function findOrphanedSubAgentReferences(
  paprDir: string,
  profiles: readonly SubAgentProfile[],
): OrphanedSubAgentReference[] {
  const profileIds = new Set(profiles.map((p) => p.id));
  const referenced = new Map<string, SubAgentReference[]>();

  for (const app of readAppsJson(paprDir)) {
    const agentChat = app.agentChat as { enabled?: boolean; subAgentId?: string } | undefined;
    const subAgentId = agentChat?.enabled ? agentChat.subAgentId?.trim() : undefined;
    if (!subAgentId || profileIds.has(subAgentId)) {
      continue;
    }
    const list = referenced.get(subAgentId) ?? [];
    list.push({
      kind: "app",
      id: String(app.id ?? "unknown"),
      label: String(app.title ?? app.id ?? "app"),
    });
    referenced.set(subAgentId, list);
  }

  for (const job of readJobsJson(paprDir)) {
    if (job.type !== "subagent") {
      continue;
    }
    const subAgentId = String(job.subAgentId ?? "").trim();
    if (!subAgentId || profileIds.has(subAgentId)) {
      continue;
    }
    const list = referenced.get(subAgentId) ?? [];
    list.push({
      kind: "job",
      id: String(job.id ?? "unknown"),
      label: String(job.name ?? job.id ?? "job"),
    });
    referenced.set(subAgentId, list);
  }

  return [...referenced.entries()].map(([subAgentId, refs]) => ({
    subAgentId,
    references: refs,
  }));
}

/** Merge profiles by id — prefer newer updatedAt; always keep all custom agents from local snapshot. */
export function mergeSubAgentProfileLists(
  pulled: readonly SubAgentProfile[],
  preservedCustom: readonly SubAgentProfile[],
): SubAgentProfile[] {
  const byId = new Map<string, SubAgentProfile>();

  for (const profile of pulled) {
    byId.set(profile.id, profile);
  }

  for (const local of preservedCustom) {
    if (!isCustomSubAgentId(local.id)) {
      continue;
    }
    const existing = byId.get(local.id);
    if (!existing) {
      byId.set(local.id, local);
      continue;
    }
    const localMs = Date.parse(local.updatedAt ?? local.createdAt ?? "");
    const remoteMs = Date.parse(existing.updatedAt ?? existing.createdAt ?? "");
    byId.set(local.id, Number.isFinite(localMs) && localMs > remoteMs ? local : existing);
  }

  return [...byId.values()];
}

export function snapshotCustomSubAgentProfiles(
  profiles: readonly SubAgentProfile[],
): SubAgentProfile[] {
  return profiles.filter((p) => isCustomSubAgentId(p.id));
}

export interface RecoveredSubAgentProfile {
  profile: SubAgentProfile;
  appId: string;
  appTitle: string;
}

/** Rebuild a minimal profile from agent-chat.json when subagents.json lost the entry. */
export function buildRecoveryProfileFromSidecar(input: {
  subAgentId: string;
  appId: string;
  appTitle: string;
  sidecar: {
    bubbleLabel?: string;
    welcomeMessage?: string;
    systemContext?: string;
    allowedToolIds?: string[];
  };
}): SubAgentProfile {
  const now = new Date().toISOString();
  const name =
    input.sidecar.bubbleLabel?.trim() ||
    `${input.appTitle} Assistant`.trim() ||
    "App Assistant";
  const promptParts = [
    input.sidecar.systemContext?.trim(),
    input.sidecar.welcomeMessage?.trim()
      ? `Welcome message shown to users: ${input.sidecar.welcomeMessage.trim()}`
      : undefined,
  ].filter(Boolean);

  return {
    id: input.subAgentId,
    name,
    description: `Embedded assistant for ${input.appTitle}`,
    systemPrompt:
      promptParts.join("\n\n") ||
      "You are an embedded mini-app assistant. Help the user with tasks inside the app.",
    allowedToolIds:
      input.sidecar.allowedToolIds?.length &&
      input.sidecar.allowedToolIds.length > 0
        ? input.sidecar.allowedToolIds
        : [...DEFAULT_APP_AGENT_CHAT_TOOL_IDS],
    assignedSkills: [],
    outputMode: "natural",
    maxTurns: 20,
    memoryPolicy: "none",
    icon: "robot",
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
}

export function recoverProfilesFromAppAgentSidecars(
  paprDir: string,
  missingSubAgentIds: readonly string[],
): RecoveredSubAgentProfile[] {
  const missing = new Set(missingSubAgentIds.map((id) => id.trim()).filter(Boolean));
  if (missing.size === 0) {
    return [];
  }

  const recovered: RecoveredSubAgentProfile[] = [];
  for (const app of readAppsJson(paprDir)) {
    const appId = String(app.id ?? "").trim();
    if (!appId) {
      continue;
    }
    const agentChat = app.agentChat as { enabled?: boolean; subAgentId?: string } | undefined;
    const subAgentId = agentChat?.enabled ? agentChat.subAgentId?.trim() : undefined;
    if (!subAgentId || !missing.has(subAgentId)) {
      continue;
    }

    const sidecar = readAgentChatSidecarSync(paprDir, appId);
    if (!sidecar || sidecar.subAgentId.trim() !== subAgentId) {
      continue;
    }

    recovered.push({
      appId,
      appTitle: String(app.title ?? appId),
      profile: buildRecoveryProfileFromSidecar({
        subAgentId,
        appId,
        appTitle: String(app.title ?? appId),
        sidecar,
      }),
    });
    missing.delete(subAgentId);
  }

  return recovered;
}

export interface SubAgentReconcileResult {
  mergedCustomProfiles: number;
  recoveredFromSidecar: string[];
  stillOrphaned: OrphanedSubAgentReference[];
}

/** After git pull or on gateway startup — merge preserved custom agents and recover from sidecars. */
export async function reconcileSubAgentProfilesOnDisk(
  paprDir: string,
  preservedCustom: readonly SubAgentProfile[] = [],
): Promise<SubAgentReconcileResult> {
  const current = await readSubAgentProfiles(paprDir);
  let merged = mergeSubAgentProfileLists(current, preservedCustom);

  const orphansBefore = findOrphanedSubAgentReferences(paprDir, merged);
  const missingIds = orphansBefore.map((o) => o.subAgentId);
  const recovered = recoverProfilesFromAppAgentSidecars(paprDir, missingIds);

  if (recovered.length > 0) {
    const byId = new Map(merged.map((p) => [p.id, p]));
    for (const item of recovered) {
      byId.set(item.profile.id, item.profile);
    }
    merged = [...byId.values()];
    await writeSubAgentProfiles(paprDir, merged);
  } else if (preservedCustom.length > 0 && merged.length !== current.length) {
    await writeSubAgentProfiles(paprDir, merged);
  }

  const stillOrphaned = findOrphanedSubAgentReferences(paprDir, merged);

  return {
    mergedCustomProfiles: snapshotCustomSubAgentProfiles(merged).length,
    recoveredFromSidecar: recovered.map((r) => r.profile.id),
    stillOrphaned,
  };
}

let prePullCustomSnapshot: SubAgentProfile[] = [];

/** Call before namespace git pull to preserve custom profiles if remote lacks them. */
export function captureCustomSubAgentsBeforeGitPull(paprDir: string): void {
  prePullCustomSnapshot = snapshotCustomSubAgentProfiles(
    readSubAgentProfilesSync(paprDir),
  );
}

export function consumePrePullCustomSubAgentSnapshot(): SubAgentProfile[] {
  const snapshot = prePullCustomSnapshot;
  prePullCustomSnapshot = [];
  return snapshot;
}

export function formatOrphanedSubAgentWarning(
  orphans: readonly OrphanedSubAgentReference[],
): string | null {
  if (orphans.length === 0) {
    return null;
  }
  const lines = orphans.map((o) => {
    const refs = o.references.map((r) => `${r.kind}:${r.label}`).join(", ");
    return `${o.subAgentId} ← ${refs}`;
  });
  return (
    `[SubAgentIntegrity] ${orphans.length} sub-agent profile(s) referenced by apps/jobs ` +
    `but missing from data/subagents.json: ${lines.join("; ")}. ` +
    "Run create_sub_agent + enable_app_agent_chat, then Sync now."
  );
}
