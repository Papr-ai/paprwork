/**
 * Platform-specific utilities for cross-platform compatibility
 * Handles shell resolution, path conventions, and UI differences
 */

export type Platform = "win32" | "darwin" | "linux";

/**
 * Get the current platform
 */
export function getPlatform(): Platform {
  return process.platform as Platform;
}

/**
 * Get human-readable platform name
 */
export function getPlatformName(): string {
  switch (process.platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return "Unknown";
  }
}

/**
 * Get the appropriate shell for the current platform
 */
export function getShell(): string {
  if (process.platform === "win32") {
    // For now, use cmd.exe as default for compatibility
    // Can switch to PowerShell in the future with proper command translation
    return process.env.COMSPEC || "cmd.exe";
  }
  
  // Unix-like systems (macOS, Linux)
  return process.env.SHELL || "/bin/bash";
}

/**
 * Get shell arguments for running a command
 * @param command - The command to execute
 * @returns [shellPath, args[]]
 */
export function getShellCommand(command: string): [string, string[]] {
  if (process.platform === "win32") {
    const shell = getShell();
    
    // cmd.exe uses /c, PowerShell uses -Command
    if (shell.toLowerCase().includes("powershell")) {
      return [shell, ["-Command", command]];
    }
    return [shell, ["/c", command]];
  }
  
  // Unix-like: bash -c "command"
  return [getShell(), ["-c", command]];
}

/**
 * Get Python virtual environment paths for the current platform
 */
export function getVenvPaths(venvDir: string): {
  python: string;
  pip: string;
  activate: string;
} {
  if (process.platform === "win32") {
    return {
      python: `${venvDir}\\Scripts\\python.exe`,
      pip: `${venvDir}\\Scripts\\pip.exe`,
      activate: `${venvDir}\\Scripts\\activate.bat`,
    };
  }
  
  // Unix-like
  return {
    python: `${venvDir}/bin/python3`,
    pip: `${venvDir}/bin/pip3`,
    activate: `${venvDir}/bin/activate`,
  };
}

/**
 * Get the modifier key name for keyboard shortcuts (Cmd on Mac, Ctrl elsewhere)
 */
export function getModifierKey(): string {
  return process.platform === "darwin" ? "Cmd" : "Ctrl";
}

/**
 * Get the modifier key symbol for UI display
 */
export function getModifierSymbol(): string {
  return process.platform === "darwin" ? "\u2318" : "Ctrl+";
}

/**
 * Wrap a command for virtual environment execution
 * @param command - The command to wrap
 * @param venvDir - Path to the virtual environment directory
 */
export function wrapCommandWithVenv(command: string, venvDir: string): string {
  const paths = getVenvPaths(venvDir);
  
  // Replace python/pip commands with venv-specific paths
  if (command.startsWith("python3 ") || command.startsWith("python ")) {
    const rest = command.replace(/^python3?\s+/, "");
    return `${paths.python} ${rest}`;
  }
  
  if (command.startsWith("pip ") || command.startsWith("pip3 ")) {
    const rest = command.replace(/^pip3?\s+/, "");
    return `${paths.pip} ${rest}`;
  }
  
  // For other commands, activate the venv first
  if (process.platform === "win32") {
    // Windows: call activate.bat && command
    return `call ${paths.activate} && ${command}`;
  }
  
  // Unix: source activate && command
  return `source ${paths.activate} && ${command}`;
}

/**
 * Get platform-specific home directory alias
 * Used in agent prompts and documentation
 */
export function getHomeDirAlias(): string {
  if (process.platform === "win32") {
    return "%USERPROFILE%";
  }
  return "~";
}

/**
 * Get the PAPR workspace directory (standardized to uppercase for consistency)
 */
export function getPaprDir(): string {
  const os = require("os");
  const path = require("path");
  return path.join(os.homedir(), "PAPR");
}

/**
 * Check if a command is available in PATH
 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);
  
  try {
    if (process.platform === "win32") {
      await execAsync(`where ${command}`, { timeout: 5000 });
    } else {
      await execAsync(`which ${command}`, { timeout: 5000 });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process on a specific port (cross-platform)
 */
export async function killProcessOnPort(port: number): Promise<void> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);
  
  try {
    if (process.platform === "win32") {
      // Windows: netstat to find PID, then taskkill
      const { stdout } = await execAsync(
        `netstat -ano | findstr :${port}`,
        { timeout: 5000 }
      );
      
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        const match = line.match(/LISTENING\s+(\d+)/);
        if (match) {
          const pid = match[1];
          console.log(`[Platform] Killing process ${pid} on port ${port}`);
          await execAsync(`taskkill /PID ${pid} /F`, { timeout: 5000 });
        }
      }
    } else {
      // Unix: lsof to find PID, then kill
      const { stdout } = await execAsync(`lsof -ti:${port}`, {
        encoding: "utf8",
        timeout: 5000,
      });
      
      const pid = stdout.trim();
      if (pid) {
        console.log(`[Platform] Killing process ${pid} on port ${port}`);
        await execAsync(`kill -9 ${pid}`, { timeout: 5000 });
        
        // Brief delay to let process cleanup
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } catch (error) {
    // No process on port or command failed
    console.log(`[Platform] No process found on port ${port}`);
  }
}
