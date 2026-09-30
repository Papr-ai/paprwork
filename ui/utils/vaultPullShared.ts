import type { IntegrationKeyVaultAudience } from "../constants/integrationKeyVaultAudience";
import { getGatewayHttpBase } from "./gatewayHttpBase";

export interface PullSharedVaultResult {
  success: boolean;
  upserted?: number;
  error?: string;
}

/** Trigger gateway pull-shared (memory → local keychain mirrors). Non-blocking for callers. */
export interface VaultPushResult {
  success: boolean;
  conflicts?: Array<{
    name: string;
    reason?: string;
    ownerUserId?: string;
    shareScope?: string;
  }>;
  error?: string;
}

export interface SyncVaultKeyChangeInput {
  name: string;
  previousAudience?: IntegrationKeyVaultAudience;
  nextAudience?: IntegrationKeyVaultAudience;
  targetOrgId?: string;
  mode: "delete" | "update";
}

export interface SyncVaultKeyChangeResult {
  success: boolean;
  deleted?: string[];
  notFound?: string[];
  conflicts?: VaultPushResult["conflicts"];
  error?: string;
}

export async function pushVaultKeys(): Promise<VaultPushResult> {
  try {
    const res = await fetch(`${getGatewayHttpBase()}/api/vault/push`, {
      method: "POST",
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: text.slice(0, 200) };
    }
    const data = (await res.json()) as {
      result?: { conflicts?: VaultPushResult["conflicts"] };
    };
    return { success: true, conflicts: data.result?.conflicts };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Owner delete or audience change — delete canonical secret or re-push labels/value.
 * Matches add/shared-audience push triggers so revoke/delete propagate to peers on pull.
 */
export async function syncVaultKeyChange(
  input: SyncVaultKeyChangeInput,
): Promise<SyncVaultKeyChangeResult> {
  try {
    const res = await fetch(`${getGatewayHttpBase()}/api/vault/sync-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: text.slice(0, 200) };
    }
    const data = (await res.json()) as {
      result?: {
        deleted?: string[];
        notFound?: string[];
        push?: { conflicts?: VaultPushResult["conflicts"] };
      };
    };
    return {
      success: true,
      deleted: data.result?.deleted,
      notFound: data.result?.notFound,
      conflicts: data.result?.push?.conflicts,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function pullSharedVaultKeys(): Promise<PullSharedVaultResult> {
  try {
    const res = await fetch(`${getGatewayHttpBase()}/api/vault/pull-shared`, {
      method: "POST",
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: text.slice(0, 200) };
    }
    const data = (await res.json()) as { upserted?: number };
    return { success: true, upserted: data.upserted };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
