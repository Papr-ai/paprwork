/**
 * Papr Memory user identity for Paprwork (real Papr accounts).
 *
 * Send both `user_id` and `external_user_id` with the same Parse _User.objectId.
 * The memory server prefers `user_id` for end_user_id (no shadow DeveloperUser)
 * while keeping `external_user_id` for backward compatibility.
 *
 * Single-add v2 auth reads metadata — mirror identity there, not just top-level.
 */

export interface PaprMemoryUserIdentity {
  user_id: string;
  external_user_id: string;
}

export function buildPaprMemoryUserIdentity(
  userId: string,
): PaprMemoryUserIdentity {
  const id = userId.trim();
  return { user_id: id, external_user_id: id };
}

export function spreadPaprMemoryUserIdentity(
  userId?: string,
): PaprMemoryUserIdentity | Record<string, never> {
  if (!userId?.trim()) {
    return {};
  }
  return buildPaprMemoryUserIdentity(userId);
}

export function mergeUserIdentityIntoMetadata<M extends Record<string, unknown>>(
  metadata: M,
  userId?: string,
): M {
  if (!userId?.trim()) {
    return metadata;
  }
  return {
    ...metadata,
    ...buildPaprMemoryUserIdentity(userId),
  };
}

/** Spread top-level user_id + external_user_id from scope fields. */
export function spreadMemoryScopeUserIdentity(scope: {
  user_id?: string;
  external_user_id?: string;
}): PaprMemoryUserIdentity | Record<string, never> {
  return spreadPaprMemoryUserIdentity(
    scope.user_id ?? scope.external_user_id,
  );
}
