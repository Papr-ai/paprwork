/**
 * Query params that tell the memory server whose Chat a session read belongs to.
 *
 * messages.store sends user_id / external_user_id (see paprSyncPayload.ts), so the server files a
 * member's messages under the member. The session reads (retrieveHistory, compress) sent nothing, so
 * the server used the API key owner and returned the owner's Chat for the same sessionId: 2 of 85
 * messages and a summary built from them (Papr-ai/memory#530). Sending the same id here makes the
 * read and write sides agree. The server checks the id is a member of the key's namespace.
 */
import { getMemoryScopeContext } from "../../utils/memoryScopeResolver.js";

export interface PaprSessionUserQuery {
  user_id?: string;
}

export function paprSessionUserQuery(
  userId: string | undefined = getMemoryScopeContext().userId,
): PaprSessionUserQuery {
  const id = userId?.trim();
  return id ? { user_id: id } : {};
}

/** Merge the session user into a retrieveHistory query (limit/skip etc.). */
export function withPaprSessionUser<Q extends object>(
  query: Q = {} as Q,
  userId?: string,
): Q & PaprSessionUserQuery {
  return { ...query, ...paprSessionUserQuery(userId) };
}
