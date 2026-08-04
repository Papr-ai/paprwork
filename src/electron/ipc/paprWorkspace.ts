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
import {
  paprApiKeyMatchesNamespaceBound,
  parsePaprApiKeyScope,
} from "../../core/utils/paprApiKey.js";

const DEFAULT_GATEWAY_PORT = 18789;
const WORKSPACE_SWITCH_FETCH_TIMEOUT_MS = 8_000;
const WORKSPACE_SWITCH_FETCH_RETRIES = 3;

let restartGatewayAfterWorkspaceSwitch: (() => Promise<void>) | null = null;

/** Set by Electron main — restarts gateway when switch POST fails but local pointer saved. */
export function setGatewayRestartAfterWorkspaceSwitch(
  handler: (() => Promise<void>) | null,
): void {
  restartGatewayAfterWorkspaceSwitch = handler;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWorkspaceSwitchRequest(
  port: number,
  body: Record<string, unknown>,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < WORKSPACE_SWITCH_FETCH_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(400 * attempt);
    }
    try {
      return await fetch(`http://127.0.0.1:${port}/api/workspace/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WORKSPACE_SWITCH_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Gateway unreachable");
}

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
  const requestBody = {
    organizationId: input.organizationId,
    namespaceId: input.namespaceId,
    organizationName: input.organizationName,
    namespaceName: input.namespaceName,
    paprApiKey: input.paprApiKey,
    skipLegacyMigration: input.skipLegacyMigration === true,
    runPostMigrationPathRepair: input.runPostMigrationPathRepair === true,
  };
  try {
    const response = await postWorkspaceSwitchRequest(port, requestBody);
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

    if (local.pointer && restartGatewayAfterWorkspaceSwitch) {
      console.warn(
        "[PaprWorkspace] Gateway switch POST failed — restarting with updated pointer:",
        message,
      );
      try {
        await restartGatewayAfterWorkspaceSwitch();
        console.log(
          "[PaprWorkspace] Gateway restarted after workspace pointer update",
        );
        return {
          success: true,
          pointer: local.pointer,
        };
      } catch (restartError) {
        const restartMessage =
          restartError instanceof Error
            ? restartError.message
            : String(restartError);
        console.warn(
          "[PaprWorkspace] Gateway restart after switch failed:",
          restartMessage,
        );
        return {
          success: false,
          pointer: local.pointer,
          error: `Gateway workspace switch failed: ${message} (restart: ${restartMessage})`,
        };
      }
    }

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
  const pointer = readActiveWorkspacePointer();
  if (
    pointer &&
    !paprApiKeyMatchesNamespaceBound(
      apiKey,
      pointer.organizationId,
      pointer.namespaceId,
    )
  ) {
    const scope = parsePaprApiKeyScope(apiKey.trim());
    console.warn(
      scope
        ? `[PaprWorkspace] Skipping gateway Papr API key update — key namespace ${scope.namespaceId} != active ${pointer.namespaceId}`
        : "[PaprWorkspace] Skipping gateway Papr API key update — rejected by namespace binding",
    );
    return;
  }

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
