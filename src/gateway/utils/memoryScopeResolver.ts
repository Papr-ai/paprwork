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
import {
  applyExplicitReadAclToPolicy,
  hasExplicitMemoryReadAcl,
  type ExplicitMemoryReadAclInput,
} from "../../core/utils/memoryAcl.js";
import { loadSettings } from "../services/settingsStore.js";
import {
  mergeUserIdentityIntoMetadata,
  spreadMemoryScopeUserIdentity,
} from "../../core/utils/paprMemoryUserIdentity.js";
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

export interface MemoryReadAclToolArgs {
  readAcl?: string[];
  shareWithUserIds?: string[];
  shareWithTeam?: boolean;
  shareWithOrganization?: boolean;
}

/** Map agent tool ACL fields to explicit read ACL for memory.add / create_entities. */
export function resolveExplicitReadAclFromToolArgs(
  args: MemoryReadAclToolArgs,
  ctx?: MemoryScopeContext,
): ExplicitMemoryReadAclInput | undefined {
  if (
    !args.readAcl?.length &&
    !args.shareWithUserIds?.length &&
    !args.shareWithTeam &&
    !args.shareWithOrganization
  ) {
    return undefined;
  }

  const scopeCtx = ctx ?? getMemoryScopeContext();
  return {
    readAcl: args.readAcl,
    shareWithUserIds: args.shareWithUserIds,
    shareWithNamespaceId: args.shareWithTeam
      ? scopeCtx.namespaceId
      : undefined,
    shareWithOrganizationId: args.shareWithOrganization
      ? scopeCtx.organizationId
      : undefined,
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
  /** When set, replaces chat/settings read ACL (writer still gets write ACL). */
  explicitReadAcl?: ExplicitMemoryReadAclInput;
}): Promise<{
  user_id?: string;
  external_user_id?: string;
  namespace_id?: string;
  policy?: MemoryAddPolicy;
}> {
  const ctx = getMemoryScopeContext();
  const audience =
    input?.explicitAudience ??
    (await resolveMemoryAudienceForChat(input?.chatId));

  const useExplicitRead =
    input?.explicitReadAcl &&
    hasExplicitMemoryReadAcl(input.explicitReadAcl);

  const scopeAudience = useExplicitRead ? "user" : audience;
  const fields = buildMemoryScopeFields(scopeAudience, ctx);

  let policy = mergeMemoryAddPolicy(input?.addPolicy, fields.policy);

  if (useExplicitRead && input.explicitReadAcl && ctx.userId) {
    policy = applyExplicitReadAclToPolicy(policy, {
      writerUserId: ctx.userId,
      explicitRead: input.explicitReadAcl,
    });
  }

  return {
    user_id: fields.user_id,
    external_user_id: fields.external_user_id,
    namespace_id: fields.namespace_id,
    policy,
  };
}

export async function buildPaprMemorySearchScope(input?: {
  chatId?: string;
  explicitAudience?: MemoryAudience;
}): Promise<{
  user_id?: string;
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
  user_id?: string;
  external_user_id?: string;
  namespace_id?: string;
  policy?: MemoryAddPolicy;
}> {
  const scope = await buildPaprMemoryWriteScope(input);
  return {
    ...spreadMemoryScopeUserIdentity(scope),
    ...(scope.namespace_id ? { namespace_id: scope.namespace_id } : {}),
    ...(scope.policy ? { policy: scope.policy } : {}),
  };
}

/** Spread search scope fields for Papr SDK memory.search bodies. */
export async function paprMemorySearchScopeSpread(input?: {
  chatId?: string;
  explicitAudience?: MemoryAudience;
}): Promise<{
  user_id?: string;
  external_user_id?: string;
  search_acl?: { read: string[]; write?: string[] };
}> {
  const scope = await buildPaprMemorySearchScope(input);
  return {
    ...spreadMemoryScopeUserIdentity(scope),
    ...(scope.search_acl ? { search_acl: scope.search_acl } : {}),
  };
}

/** Sync helper when chat/settings context is already resolved. */
export function buildPaprMemoryWriteScopeSync(input: {
  audience: MemoryAudience;
  addPolicy?: MemoryAddPolicy;
  ctx?: MemoryScopeContext;
}): {
  user_id?: string;
  external_user_id?: string;
  namespace_id?: string;
  policy?: MemoryAddPolicy;
} {
  const fields = buildMemoryScopeFields(
    input.audience,
    input.ctx ?? getMemoryScopeContext(),
  );
  return {
    user_id: fields.user_id,
    external_user_id: fields.external_user_id,
    namespace_id: fields.namespace_id,
    policy: mergeMemoryAddPolicy(input.addPolicy, fields.policy),
  };
}

/** Merge user identity into metadata for single-add (v2 auth reads metadata). */
export function withMemoryScopeMetadata<M extends Record<string, unknown>>(
  metadata: M,
  scope: { user_id?: string; external_user_id?: string },
): M {
  return mergeUserIdentityIntoMetadata(
    metadata,
    scope.user_id ?? scope.external_user_id,
  );
}
