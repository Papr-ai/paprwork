/**
 * Geolocation permission flow for the sidebar weather widget.
 * Shows an in-app prompt once, then persists the user's choice.
 */

const { session, dialog } = require("electron");

/**
 * @param {object} options
 * @param {() => import("electron").BrowserWindow | null} options.getMainWindow
 * @param {{
 *   getWeatherLocationMode: () => "precise" | "approximate" | undefined;
 *   setWeatherLocationMode: (mode: "precise" | "approximate") => void;
 * }} options.settingsStorage
 */
function registerGeolocationPermissionHandlers({
  getMainWindow,
  settingsStorage,
  // Electron keeps ONE handler per session — setting ours replaces any earlier
  // one. Non-geolocation permissions (mic/camera for mini-apps, clipboard)
  // are delegated here instead of being silently denied.
  fallbackCheck = () => false,
  fallbackRequest = (_wc, _perm, callback) => callback(false),
}) {
  const getMode = () => settingsStorage.getWeatherLocationMode();

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission !== "geolocation") {
      return fallbackCheck(webContents, permission, requestingOrigin, details);
    }

    const mode = getMode();
    if (mode === "approximate") {
      return false;
    }

    return true;
  });

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (permission !== "geolocation") {
        fallbackRequest(webContents, permission, callback, details);
        return;
      }

      const mode = getMode();
      if (mode === "approximate") {
        callback(false);
        return;
      }

      if (mode === "precise") {
        callback(true);
        return;
      }

      const win = getMainWindow();
      if (!win || win.isDestroyed()) {
        settingsStorage.setWeatherLocationMode("approximate");
        callback(false);
        return;
      }

      dialog
        .showMessageBox(win, {
          type: "question",
          buttons: ["Allow Location", "Use Approximate Location"],
          defaultId: 0,
          cancelId: 1,
          title: "Local Weather",
          message: "Show weather for your area?",
          detail:
            'Allow location access for accurate local weather in the sidebar. Choose "Use Approximate Location" to estimate from your network instead — no GPS required.',
        })
        .then(({ response }) => {
          if (response === 0) {
            settingsStorage.setWeatherLocationMode("precise");
            callback(true);
          } else {
            settingsStorage.setWeatherLocationMode("approximate");
            callback(false);
          }
        })
        .catch((error) => {
          console.error(
            "[Electron] Geolocation permission dialog failed:",
            error,
          );
          settingsStorage.setWeatherLocationMode("approximate");
          callback(false);
        });
    },
  );

  console.log("[Electron] Geolocation permission handlers registered");
}

module.exports = { registerGeolocationPermissionHandlers };
