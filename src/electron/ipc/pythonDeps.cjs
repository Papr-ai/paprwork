/**
 * Python Dependencies IPC Handlers
 *
 * Handles checking and auto-installing Python dependencies (BeautifulSoup4, lxml)
 * for the browser_parse_html tool.
 */

const { ipcMain } = require("electron");

let checkPythonDependenciesFn;
let autoInstallPythonDependenciesFn;

async function loadESMModules() {
  const module = await import(
    "../../dist/core/utils/pythonDependencies.js"
  );
  checkPythonDependenciesFn = module.checkPythonDependencies;
  autoInstallPythonDependenciesFn = module.autoInstallPythonDependencies;
}

/**
 * Initialize Python dependencies IPC handlers
 */
function initializePythonDepsIPC() {
  console.log("[Electron] Initializing Python dependencies IPC handlers");

  ipcMain.handle("pythonDeps:check", async () => {
    try {
      if (!checkPythonDependenciesFn) {
        await loadESMModules();
      }
      const status = await checkPythonDependenciesFn();
      return { success: true, status };
    } catch (error) {
      console.error("[Electron] Failed to check Python dependencies:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  });

  ipcMain.handle("pythonDeps:autoInstall", async () => {
    try {
      if (!autoInstallPythonDependenciesFn) {
        await loadESMModules();
      }

      // Simple progress logging (no streaming to renderer)
      const result = await autoInstallPythonDependenciesFn((progress) => {
        console.log(`[Electron] Python install progress: ${progress.message}`);
      });

      return result;
    } catch (error) {
      console.error("[Electron] Failed to auto-install dependencies:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  });
}

module.exports = {
  initializePythonDepsIPC,
};
