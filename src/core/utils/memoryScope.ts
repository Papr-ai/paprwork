/**
 * Papr Memory audience / ACL helpers.
 *
 * Controls who can read derived memories (not raw chat transcripts).
 * Resolution order: explicit override → chat scope → settings default → "user".
 */

import type { MemoryAddPolicy } from "@papr/memory/resources/shared.js";

export type MemoryAudience = "user" | "namespace" | "org";

export interface MemoryScopeContext {
  userId?: string;
  namespaceId?: string;
  organizationId?: string;
}

export interface MemoryScopeFields {
  /**
   * Real Papr _User.objectId of the acting user.
   * Sent as `user_id` — NOT `external_user_id`, which would make the memory
   * server mint an anonymous shadow DeveloperUser for a real Papr account.
   */
  user_id?: string;
  namespace_id?: string;
  policy?: MemoryAddPolicy;
}

export interface MemorySearchScopeFields {
  /** Real Papr _User.objectId of the acting user. */
  user_id?: string;
  search_acl?: { read: string[]; write?: string[] };
}

export function resolveMemoryAudience(input: {
  explicit?: MemoryAudience | null;
  chatScope?: MemoryAudience | null;
  defaultScope?: MemoryAudience | null;
}): MemoryAudience {
  return input.explicit ?? input.chatScope ?? input.defaultScope ?? "user";
}

function userWriteAcl(userId: string): string[] {
  return [`user:${userId}`];
}

export function buildMemoryScopeFields(
  audience: MemoryAudience,
  ctx: MemoryScopeContext,
): MemoryScopeFields {
  const userId = ctx.userId?.trim();
  const namespaceId = ctx.namespaceId?.trim();
  const organizationId = ctx.organizationId?.trim();

  if (!userId) {
    return {};
  }

  if (audience === "namespace" && namespaceId) {
    return {
      user_id: userId,
      namespace_id: namespaceId,
      policy: {
        acl: {
          read: [`namespace:${namespaceId}`],
          write: [...userWriteAcl(userId), `namespace:${namespaceId}`],
        },
      },
    };
  }

  if (audience === "org" && organizationId) {
    return {
      user_id: userId,
      namespace_id: namespaceId,
      policy: {
        acl: {
          read: [`organization:${organizationId}`],
          write: [...userWriteAcl(userId), `organization:${organizationId}`],
        },
      },
    };
  }

  return { user_id: userId };
}

export function buildMemorySearchScopeFields(
  audience: MemoryAudience,
  ctx: MemoryScopeContext,
): MemorySearchScopeFields {
  const userId = ctx.userId?.trim();
  const namespaceId = ctx.namespaceId?.trim();
  const organizationId = ctx.organizationId?.trim();

  if (audience === "namespace" && namespaceId) {
    return {
      ...(userId ? { user_id: userId } : {}),
      search_acl: { read: [`namespace:${namespaceId}`] },
    };
  }

  if (audience === "org" && organizationId) {
    return {
      ...(userId ? { user_id: userId } : {}),
      search_acl: { read: [`organization:${organizationId}`] },
    };
  }

  return userId ? { user_id: userId } : {};
}

export function mergeMemoryAddPolicy(
  base: MemoryAddPolicy | undefined,
  scopePolicy: MemoryAddPolicy | undefined,
): MemoryAddPolicy | undefined {
  if (!base && !scopePolicy) {
    return undefined;
  }
  if (!base) {
    return scopePolicy;
  }
  if (!scopePolicy) {
    return base;
  }

  const baseAcl = base.acl;
  const scopeAcl = scopePolicy.acl;

  return {
    ...base,
    ...scopePolicy,
    ...(baseAcl || scopeAcl
      ? {
          acl: {
            ...(baseAcl ?? {}),
            ...(scopeAcl ?? {}),
            ...(baseAcl?.read || scopeAcl?.read
              ? {
                  read: [
                    ...(baseAcl?.read ?? []),
                    ...(scopeAcl?.read ?? []),
                  ],
                }
              : {}),
            ...(baseAcl?.write || scopeAcl?.write
              ? {
                  write: [
                    ...(baseAcl?.write ?? []),
                    ...(scopeAcl?.write ?? []),
                  ],
                }
              : {}),
          },
        }
      : {}),
  };
}

export const MEMORY_AUDIENCE_LABELS: Record<
  MemoryAudience,
  { label: string; description: string }
> = {
  user: {
    label: "Only me",
    description: "Memories stay private to your account",
  },
  namespace: {
    label: "Team",
    description: "Team members can search shared memories",
  },
  org: {
    label: "Organization",
    description: "Anyone in your organization can search shared memories",
  },
};
