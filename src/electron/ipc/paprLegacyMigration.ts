/**
 * User-consented flat ~/Papr → org/namespace migration (Electron main).
 */

import { BrowserWindow, ipcMain } from "electron";
import {
  detectLegacyFlatPaprMigrationNeed,
  ensureWorkspaceLayout,
  runUserConsentFlatPaprMigration,
  applyActiveWorkspaceEnv,
  readActiveWorkspacePointer,
} from "../../core/utils/paprWorkspace.js";
import {
  notifyGatewayWorkspaceSwitch,
} from "./paprWorkspace.js";

export interface ConsentLegacyMigrationInput {
  organizationId: string;
  namespaceId: string;
  organizationName?: string;
  namespaceName?: string;
  paprApiKey?: string;
}

export interface ConsentLegacyMigrationResult {
  success: boolean;
  movedEntries?: string[];
  error?: string;
}

export async function runConsentLegacyMigration(
  input: ConsentLegacyMigrationInput,
): Promise<ConsentLegacyMigrationResult> {
  try {
    const pointer = await ensureWorkspaceLayout({
      organizationId: input.organizationId,
      namespaceId: input.namespaceId,
      organizationName: input.organizationName,
      namespaceName: input.namespaceName,
    });

    const migration = await runUserConsentFlatPaprMigration({
      organizationId: input.organizationId,
      namespaceId: input.namespaceId,
      targetPaprHome: pointer.paprHome,
      targetUserDataPath: pointer.userDataPath,
    });

    applyActiveWorkspaceEnv(pointer);

    const workspaceResult = await notifyGatewayWorkspaceSwitch({
      organizationId: input.organizationId,
      namespaceId: input.namespaceId,
      organizationName: input.organizationName,
      namespaceName: input.namespaceName,
      paprApiKey: input.paprApiKey,
      skipLegacyMigration: true,
      runPostMigrationPathRepair: true,
    });

    if (!workspaceResult.success) {
      return {
        success: false,
        error:
          workspaceResult.error ??
          "Migration finished but the app could not reload your workspace.",
      };
    }

    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("papr:namespace-changed", {
        namespaceId: input.namespaceId,
        namespaceName: input.namespaceName ?? input.namespaceId,
      });
    }

    return {
      success: true,
      movedEntries: migration.movedEntries,
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to move your Papr folder",
    };
  }
}

export function registerPaprLegacyMigrationHandlers(deps?: {
  resolvePaprApiKey?: () => Promise<string | undefined>;
}): void {
  ipcMain.handle("papr:detect-legacy-flat-migration", async () => {
    try {
      const pointer = readActiveWorkspacePointer();
      if (!pointer) {
        return {
          success: true,
          needsUserConsent: false,
          entries: [] as string[],
        };
      }

      const detection = await detectLegacyFlatPaprMigrationNeed({
        organizationId: pointer.organizationId,
        namespaceId: pointer.namespaceId,
        targetPaprHome: pointer.paprHome,
      });

      return {
        success: true,
        needsUserConsent: detection.needsUserConsent,
        entries: detection.entries,
      };
    } catch (error) {
      return {
        success: false,
        needsUserConsent: false,
        entries: [] as string[],
        error: error instanceof Error ? error.message : "Detection failed",
      };
    }
  });

  ipcMain.handle(
    "papr:run-consent-legacy-migration",
    async (_event, input: ConsentLegacyMigrationInput) => {
      const paprApiKey = deps?.resolvePaprApiKey
        ? await deps.resolvePaprApiKey()
        : input.paprApiKey;
      return runConsentLegacyMigration({
        ...input,
        paprApiKey,
      });
    },
  );
}
