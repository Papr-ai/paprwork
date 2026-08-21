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
}) {
  const getMode = () => settingsStorage.getWeatherLocationMode();

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission !== "geolocation") {
      return false;
    }

    const mode = getMode();
    if (mode === "approximate") {
      return false;
    }

    return true;
  });

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      if (permission !== "geolocation") {
        callback(false);
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
