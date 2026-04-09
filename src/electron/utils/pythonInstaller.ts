/**
 * Python Auto-Installer for Windows
 * 
 * Automatically downloads and installs Python from python.org for non-technical users.
 * Falls back to Microsoft Store if direct download fails.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { app } from "electron";
import https from "https";
import fs from "fs";

const execAsync = promisify(exec);

interface PythonCheckResult {
  installed: boolean;
  version?: string;
  path?: string;
  command: "python" | "python3" | "py";
}

/**
 * Check if Python is installed and get its details
 */
export async function checkPython(): Promise<PythonCheckResult> {
  const isWindows = process.platform === "win32";
  
  // Try different Python commands
  const commands = isWindows ? ["python", "py", "python3"] : ["python3", "python"];
  
  for (const cmd of commands) {
    try {
      const { stdout } = await execAsync(`${cmd} --version`, { timeout: 5000 });
      const version = stdout.trim();
      
      // Get path
      let path: string | undefined;
      try {
        const whereCmd = isWindows ? "where" : "which";
        const { stdout: pathOut } = await execAsync(`${whereCmd} ${cmd}`, { timeout: 5000 });
        path = pathOut.trim().split("\n")[0]; // First result
      } catch {
        // Path not important if version check worked
      }
      
      return {
        installed: true,
        version,
        path,
        command: cmd as "python" | "python3" | "py",
      };
    } catch {
      // Try next command
      continue;
    }
  }
  
  return { installed: false, command: "python" };
}

/**
 * Download Python installer for Windows
 */
async function downloadPythonInstaller(version: string = "3.12.8"): Promise<string> {
  const downloadUrl = `https://www.python.org/ftp/python/${version}/python-${version}-amd64.exe`;
  const downloadPath = join(app.getPath("temp"), `python-${version}-installer.exe`);
  
  console.log(`[PythonInstaller] Downloading from ${downloadUrl}...`);
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(downloadPath);
    
    https.get(downloadUrl, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on("finish", () => {
        file.close();
        console.log(`[PythonInstaller] Downloaded to ${downloadPath}`);
        resolve(downloadPath);
      });
    }).on("error", (err) => {
      fs.unlink(downloadPath, () => {}); // Clean up
      reject(err);
    });
  });
}

/**
 * Install Python silently with /quiet flag
 */
async function installPython(installerPath: string): Promise<void> {
  console.log(`[PythonInstaller] Installing Python from ${installerPath}...`);
  
  // Silent install with:
  // - /quiet: No UI
  // - PrependPath=1: Add to PATH
  // - Include_test=0: Skip tests
  // - SimpleInstall=1: Default installation
  const command = `"${installerPath}" /quiet PrependPath=1 Include_test=0 SimpleInstall=1`;
  
  try {
    await execAsync(command, { timeout: 300_000 }); // 5 min timeout
    console.log(`[PythonInstaller] Installation complete`);
  } catch (error) {
    throw new Error(`Installation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Open Microsoft Store to Python page (fallback)
 */
async function openMicrosoftStore(): Promise<void> {
  const storeUrl = "ms-windows-store://pdp/?ProductId=9NRWMJP3717K"; // Python 3.12
  
  try {
    if (process.platform === "win32") {
      await execAsync(`start "" "${storeUrl}"`);
      console.log(`[PythonInstaller] Opened Microsoft Store`);
    }
  } catch (error) {
    console.error(`[PythonInstaller] Failed to open Microsoft Store:`, error);
  }
}

/**
 * Auto-install Python on Windows for non-technical users
 * 
 * Strategy:
 * 1. Check if Python already installed
 * 2. If not, download from python.org
 * 3. Install silently with /quiet flag
 * 4. Fallback to Microsoft Store if download fails
 */
export async function autoInstallPython(
  onProgress?: (status: string) => void
): Promise<{ success: boolean; error?: string }> {
  // Only auto-install on Windows
  if (process.platform !== "win32") {
    return {
      success: false,
      error: "Auto-install only supported on Windows. Install Python manually: https://www.python.org/downloads/",
    };
  }
  
  try {
    // Check if already installed
    onProgress?.("Checking Python installation...");
    const check = await checkPython();
    
    if (check.installed) {
      onProgress?.(`Python already installed: ${check.version}`);
      return { success: true };
    }
    
    // Download installer
    onProgress?.("Downloading Python installer (this may take a few minutes)...");
    let installerPath: string;
    
    try {
      installerPath = await downloadPythonInstaller();
    } catch (downloadError) {
      console.error(`[PythonInstaller] Download failed:`, downloadError);
      
      // Fallback to Microsoft Store
      onProgress?.("Download failed. Opening Microsoft Store...");
      await openMicrosoftStore();
      
      return {
        success: false,
        error: "Please install Python from the Microsoft Store (opened automatically)",
      };
    }
    
    // Install
    onProgress?.("Installing Python (this may take a few minutes)...");
    await installPython(installerPath);
    
    // Verify installation
    onProgress?.("Verifying installation...");
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for PATH update
    
    const verifyCheck = await checkPython();
    if (!verifyCheck.installed) {
      return {
        success: false,
        error: "Installation completed but Python not found in PATH. Please restart the app.",
      };
    }
    
    // Clean up installer
    try {
      fs.unlinkSync(installerPath);
    } catch {
      // Ignore cleanup errors
    }
    
    onProgress?.(`Python installed successfully: ${verifyCheck.version}`);
    return { success: true };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[PythonInstaller] Auto-install failed:`, error);
    
    return {
      success: false,
      error: `Failed to auto-install Python: ${errorMsg}`,
    };
  }
}

/**
 * Get Python command for the current platform
 * Auto-installs on Windows if not found
 */
export async function getPythonCommand(
  autoInstall: boolean = true
): Promise<{ command: string; error?: string }> {
  const check = await checkPython();
  
  if (check.installed) {
    return { command: check.command };
  }
  
  // Not installed - try auto-install on Windows
  if (process.platform === "win32" && autoInstall) {
    console.log(`[PythonInstaller] Python not found, attempting auto-install...`);
    
    const result = await autoInstallPython();
    
    if (result.success) {
      const newCheck = await checkPython();
      return { command: newCheck.command };
    }
    
    return {
      command: "python",
      error: result.error || "Python not installed",
    };
  }
  
  // Unix or autoInstall disabled
  const installUrl = process.platform === "darwin"
    ? "https://www.python.org/downloads/macos/"
    : "https://www.python.org/downloads/";
  
  return {
    command: process.platform === "win32" ? "python" : "python3",
    error: `Python not installed. Install from: ${installUrl}`,
  };
}
