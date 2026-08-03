/**
 * Electron-side workspace activation — writes pointer + notifies gateway.
 */

import { ipcMain } from "electron";
import {
  ensureWorkspaceLayout,
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
  /** Skip misplaced-target relocation (post-consent reload). */
  skipLegacyMigration?: boolean;
  /** Repair hardcoded paths after consent migration (gateway runs before watchers). */
  runPostMigrationPathRepair?: boolean;
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
        skipLegacyMigration: input.skipLegacyMigration === true,
        runPostMigrationPathRepair: input.runPostMigrationPathRepair === true,
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
      status?: "switching" | "ready";
    };
    if (payload.success === false) {
      return {
        success: false,
        pointer: local.pointer,
        error: payload.error ?? "Gateway workspace switch rejected",
      };
    }
    if (payload.status === "switching") {
      console.log(
        "[PaprWorkspace] Gateway accepted workspace switch (background reinit in progress)",
      );
    }
    return {
      success: true,
      pointer: payload.pointer ?? local.pointer,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Gateway unreachable";
    console.warn(
      "[PaprWorkspace] Gateway switch notification failed (local pointer saved):",
      message,
    );
    return {
      success: false,
      pointer: local.pointer,
      error: `Gateway workspace switch failed: ${message}`,
    };
  }
}

/** Push an updated Papr API key to the gateway without a full workspace reload. */
export async function notifyGatewayPaprApiKeyUpdate(
  apiKey: string,
): Promise<void> {
  const port = getGatewayPort();
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/workspace/papr-api-key`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paprApiKey: apiKey }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      console.warn(
        `[PaprWorkspace] Gateway Papr API key update failed (${response.status}): ${text.slice(0, 120)}`,
      );
    }
  } catch (error) {
    console.warn(
      "[PaprWorkspace] Gateway Papr API key update failed:",
      error instanceof Error ? error.message : error,
    );
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

export function registerPaprWorkspaceHandlers(): void {
  ipcMain.handle("papr:get-active-workspace", async () => {
    try {
      const pointer = readActiveWorkspacePointer();
      return { success: true, pointer: pointer ?? undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to read workspace",
      };
    }
  });
}
