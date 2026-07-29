/**
 * Electron-side workspace activation — writes pointer + notifies gateway.
 */

import {
  ensureWorkspaceLayout,
  migrateLegacyFlatPaprLayout,
  applyActiveWorkspaceEnv,
  readActiveWorkspacePointer,
  type ActiveWorkspacePointer,
} from "../../core/utils/paprWorkspace.js";

const DEFAULT_GATEWAY_PORT = 18789;

export interface ActivatePaprWorkspaceInput {
  organizationId: string;
  namespaceId: string;
  organizationName?: string;
  namespaceName?: string;
  paprApiKey?: string;
}

export interface ActivatePaprWorkspaceResult {
  success: boolean;
  pointer?: ActiveWorkspacePointer;
  error?: string;
}

function getGatewayPort(): number {
  const fromEnv = Number(process.env.GATEWAY_PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : DEFAULT_GATEWAY_PORT;
}

export async function activatePaprWorkspaceLocally(
  input: ActivatePaprWorkspaceInput,
): Promise<ActivatePaprWorkspaceResult> {
  try {
    const pointer = await ensureWorkspaceLayout(input);
    const migrated = await migrateLegacyFlatPaprLayout({
      organizationId: input.organizationId,
      namespaceId: input.namespaceId,
      targetPaprHome: pointer.paprHome,
    });
    if (migrated) {
      console.log(
        `[PaprWorkspace] Migrated legacy Papr data to ${pointer.paprHome}: ${migrated.movedPaths.join(", ")}`,
      );
    }
    applyActiveWorkspaceEnv(pointer);
    return { success: true, pointer };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Workspace activation failed",
    };
  }
}

export async function notifyGatewayWorkspaceSwitch(
  input: ActivatePaprWorkspaceInput,
): Promise<ActivatePaprWorkspaceResult> {
  const local = await activatePaprWorkspaceLocally(input);
  if (!local.success || !local.pointer) {
    return local;
  }

  const port = getGatewayPort();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace/switch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId: input.organizationId,
        namespaceId: input.namespaceId,
        organizationName: input.organizationName,
        namespaceName: input.namespaceName,
        paprApiKey: input.paprApiKey,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        pointer: local.pointer,
        error: `Gateway workspace switch failed (${response.status}): ${text.slice(0, 200)}`,
      };
    }
    const payload = (await response.json()) as {
      success?: boolean;
      pointer?: ActiveWorkspacePointer;
      error?: string;
    };
    if (payload.success === false) {
      return {
        success: false,
        pointer: local.pointer,
        error: payload.error ?? "Gateway workspace switch rejected",
      };
    }
    return {
      success: true,
      pointer: payload.pointer ?? local.pointer,
    };
  } catch (error) {
    // Gateway may still be starting — local pointer is written for next spawn.
    console.warn(
      "[PaprWorkspace] Gateway switch notification failed (local pointer saved):",
      error instanceof Error ? error.message : error,
    );
    return { success: true, pointer: local.pointer };
  }
}

export function readGatewayWorkspaceEnv(): Record<string, string> {
  const pointer = readActiveWorkspacePointer();
  if (!pointer) {
    return {};
  }
  return {
    PAPR_HOME: pointer.paprHome,
    PAPR_USER_DATA: pointer.userDataPath,
    PAPR_ORG_ID: pointer.organizationId,
    PAPR_NAMESPACE_ID: pointer.namespaceId,
  };
}
