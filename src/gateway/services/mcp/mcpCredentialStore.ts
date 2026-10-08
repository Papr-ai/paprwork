/**
 * Keychain-backed store for MCP OAuth state, via CustomKeysService (Electron
 * safeStorage over IPC). One key per server, JSON value, marked
 * `source/managedBy: "oauth"` so Settings shows it as a managed connection and
 * vault sync treats it like other OAuth keys.
 */

import { getCustomKeysService } from "../CustomKeysService.js";
import type { McpCredentialStore, McpStoredCredential } from "./McpOAuthProvider.js";
import { mcpCredentialKeyName } from "./mcpServerCatalog.js";

export function createKeychainMcpCredentialStore(
  serverName: (serverId: string) => string,
): McpCredentialStore {
  return {
    async load(serverId) {
      const raw = await getCustomKeysService().getKeyByName(mcpCredentialKeyName(serverId));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as McpStoredCredential;
      } catch {
        return null;
      }
    },
    async save(serverId, value) {
      await getCustomKeysService().addKey({
        name: mcpCredentialKeyName(serverId),
        value: JSON.stringify(value),
        description: `${serverName(serverId)} sign-in (MCP OAuth, managed by Papr Work)`,
        permission: "always",
        source: "oauth",
        managedBy: "oauth",
      });
    },
    async remove(serverId) {
      try {
        await getCustomKeysService().deleteKey(mcpCredentialKeyName(serverId));
      } catch (err) {
        if (!(err instanceof Error && /not found/i.test(err.message))) throw err;
      }
    },
  };
}

/** For tests and non-Electron runs. */
export function createMemoryMcpCredentialStore(): McpCredentialStore & {
  data: Map<string, McpStoredCredential>;
} {
  const data = new Map<string, McpStoredCredential>();
  return {
    data,
    async load(id) {
      const v = data.get(id);
      return v ? structuredClone(v) : null;
    },
    async save(id, value) {
      data.set(id, structuredClone(value));
    },
    async remove(id) {
      data.delete(id);
    },
  };
}
