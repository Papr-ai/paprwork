/**
 * Gateway-side memory scope resolution (settings + chat metadata + workspace pointer).
 */

import { readActiveWorkspacePointer } from "../../core/utils/paprWorkspace.js";
import type { MemoryAudience } from "../../core/utils/memoryScope.js";
import {
  buildMemoryScopeFields,
  buildMemorySearchScopeFields,
  mergeMemoryAddPolicy,
  resolveMemoryAudience,
  type MemoryScopeContext,
} from "../../core/utils/memoryScope.js";
import type { MemoryAddPolicy } from "@papr/memory/resources/shared.js";
import { loadSettings } from "../services/settingsStore.js";
import { getPaprUserId } from "./paprUserId.js";

export function getMemoryScopeContext(): MemoryScopeContext {
  const pointer = readActiveWorkspacePointer();
  return {
    userId: getPaprUserId(),
    namespaceId:
      process.env.PAPR_NAMESPACE_ID?.trim() || pointer?.namespaceId,
    organizationId:
      process.env.PAPR_ORG_ID?.trim() || pointer?.organizationId,
  };
}

async function getChatMemoryScope(
  chatId: string,
): Promise<MemoryAudience | null> {
  const { getAgentService } = await import("../services/AgentService.js");
  const chat = await getAgentService().getStorageManager().getChat(chatId);
  return chat?.memory_scope ?? null;
}

export async function resolveMemoryAudienceForChat(
  chatId?: string,
): Promise<MemoryAudience> {
  const settings = await loadSettings();
  const defaultScope = settings.preferences.defaultMemoryScope ?? "user";
  if (!chatId) {
    return defaultScope;
  }
  const chatScope = await getChatMemoryScope(chatId);
  return resolveMemoryAudience({
    chatScope,
    defaultScope,
  });
}

export async function buildPaprMemoryWriteScope(input?: {
  chatId?: string;
  explicitAudience?: MemoryAudience;
  addPolicy?: MemoryAddPolicy;
}): Promise<{
  external_user_id?: string;
  namespace_id?: string;
  policy?: MemoryAddPolicy;
}> {
  const audience =
    input?.explicitAudience ??
    (await resolveMemoryAudienceForChat(input?.chatId));
  const fields = buildMemoryScopeFields(audience, getMemoryScopeContext());
  return {
    external_user_id: fields.external_user_id,
    namespace_id: fields.namespace_id,
    policy: mergeMemoryAddPolicy(input?.addPolicy, fields.policy),
  };
}

export async function buildPaprMemorySearchScope(input?: {
  chatId?: string;
  explicitAudience?: MemoryAudience;
}): Promise<{
  external_user_id?: string;
  search_acl?: { read: string[]; write?: string[] };
}> {
  const audience =
    input?.explicitAudience ??
    (await resolveMemoryAudienceForChat(input?.chatId));
  return buildMemorySearchScopeFields(audience, getMemoryScopeContext());
}

/** Spread write scope fields for Papr SDK request bodies. */
export async function paprMemoryScopeSpread(input?: {
  chatId?: string;
  explicitAudience?: MemoryAudience;
  addPolicy?: MemoryAddPolicy;
}): Promise<{
  external_user_id?: string;
  namespace_id?: string;
  policy?: MemoryAddPolicy;
}> {
  const scope = await buildPaprMemoryWriteScope(input);
  return {
    ...(scope.external_user_id
      ? { external_user_id: scope.external_user_id }
      : {}),
    ...(scope.namespace_id ? { namespace_id: scope.namespace_id } : {}),
    ...(scope.policy ? { policy: scope.policy } : {}),
  };
}

/** Spread search scope fields for Papr SDK memory.search bodies. */
export async function paprMemorySearchScopeSpread(input?: {
  chatId?: string;
  explicitAudience?: MemoryAudience;
}): Promise<{
  external_user_id?: string;
  search_acl?: { read: string[]; write?: string[] };
}> {
  const scope = await buildPaprMemorySearchScope(input);
  return {
    ...(scope.external_user_id
      ? { external_user_id: scope.external_user_id }
      : {}),
    ...(scope.search_acl ? { search_acl: scope.search_acl } : {}),
  };
}

/** Sync helper when chat/settings context is already resolved. */
export function buildPaprMemoryWriteScopeSync(input: {
  audience: MemoryAudience;
  addPolicy?: MemoryAddPolicy;
  ctx?: MemoryScopeContext;
}): {
  external_user_id?: string;
  namespace_id?: string;
  policy?: MemoryAddPolicy;
} {
  const fields = buildMemoryScopeFields(
    input.audience,
    input.ctx ?? getMemoryScopeContext(),
  );
  return {
    external_user_id: fields.external_user_id,
    namespace_id: fields.namespace_id,
    policy: mergeMemoryAddPolicy(input.addPolicy, fields.policy),
  };
}
