import { ipcMain } from "electron";
import type { SettingsStorage } from "../../core/storage/SettingsStorage.js";

export function initializeTelemetryIPC(settingsStorage: SettingsStorage): void {
  ipcMain.handle("telemetry:get-enabled", async () => {
    return { enabled: settingsStorage.getTelemetryEnabled() };
  });

  ipcMain.handle("telemetry:set-enabled", async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new TypeError("telemetry:set-enabled expects a boolean");
    }
    settingsStorage.setTelemetryEnabled(enabled);
    return { success: true, enabled };
  });
}
