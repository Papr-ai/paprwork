/**
 * Package Manager - Automatic dependency installation for non-technical users
 * 
 * Detects missing essential packages and guides agent to install them automatically.
 * Works on Windows, macOS, and Linux.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { platform } from "os";

const execAsync = promisify(exec);

export interface PackageCheckResult {
  name: string;
  installed: boolean;
  version?: string;
  installCommand?: string;
  priority: "essential" | "recommended" | "optional";
}

/**
 * Essential packages that should be auto-installed
 */
const ESSENTIAL_PACKAGES = {
  // Python - Required for Python jobs
  python: {
    name: "Python",
    checkCommand: {
      win32: "python --version",
      darwin: "python3 --version",
      linux: "python3 --version",
    },
    installCommand: {
      win32: "winget install Python.Python.3.12 --silent",
      darwin: "brew install python@3.12",
      linux: "sudo apt-get update && sudo apt-get install -y python3 python3-pip",
    },
    installGuide: {
      win32: "https://www.python.org/downloads/windows/",
      darwin: "https://www.python.org/downloads/macos/",
      linux: "sudo apt-get install python3",
    },
    priority: "essential" as const,
  },
  
  // Node.js - Required for Node jobs (usually installed via nvm)
  node: {
    name: "Node.js",
    checkCommand: {
      win32: "node --version",
      darwin: "node --version",
      linux: "node --version",
    },
    installCommand: {
      win32: "winget install OpenJS.NodeJS.LTS --silent",
      darwin: "brew install node@24",
      linux: "curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs",
    },
    installGuide: {
      win32: "https://nodejs.org/en/download/",
      darwin: "https://nodejs.org/en/download/",
      linux: "https://nodejs.org/en/download/package-manager",
    },
    priority: "essential" as const,
  },
  
  // Git - Recommended for version control
  git: {
    name: "Git",
    checkCommand: {
      win32: "git --version",
      darwin: "git --version",
      linux: "git --version",
    },
    installCommand: {
      win32: "winget install Git.Git --silent",
      darwin: "brew install git",
      linux: "sudo apt-get update && sudo apt-get install -y git",
    },
    installGuide: {
      win32: "https://git-scm.com/download/win",
      darwin: "https://git-scm.com/download/mac",
      linux: "sudo apt-get install git",
    },
    priority: "recommended" as const,
  },
  
  // curl - Essential for web requests
  curl: {
    name: "curl",
    checkCommand: {
      win32: "curl --version",
      darwin: "curl --version",
      linux: "curl --version",
    },
    installCommand: {
      win32: "winget install cURL.cURL --silent",
      darwin: "brew install curl", // Usually pre-installed
      linux: "sudo apt-get update && sudo apt-get install -y curl",
    },
    installGuide: {
      win32: "https://curl.se/windows/",
      darwin: "Pre-installed on macOS",
      linux: "sudo apt-get install curl",
    },
    priority: "essential" as const,
  },
};

/**
 * Check if a package is installed
 */
export async function checkPackage(
  packageKey: keyof typeof ESSENTIAL_PACKAGES
): Promise<PackageCheckResult> {
  const pkg = ESSENTIAL_PACKAGES[packageKey];
  const currentPlatform = platform() as "win32" | "darwin" | "linux";
  const checkCmd = pkg.checkCommand[currentPlatform];
  
  try {
    const { stdout } = await execAsync(checkCmd, { timeout: 5000 });
    const version = stdout.trim();
    
    return {
      name: pkg.name,
      installed: true,
      version,
      priority: pkg.priority,
    };
  } catch {
    return {
      name: pkg.name,
      installed: false,
      installCommand: pkg.installCommand[currentPlatform],
      priority: pkg.priority,
    };
  }
}

/**
 * Check all essential packages
 */
export async function checkAllPackages(): Promise<PackageCheckResult[]> {
  const results: PackageCheckResult[] = [];
  
  for (const key of Object.keys(ESSENTIAL_PACKAGES) as Array<keyof typeof ESSENTIAL_PACKAGES>) {
    const result = await checkPackage(key);
    results.push(result);
  }
  
  return results;
}

/**
 * Get agent-friendly installation instructions
 */
export function getAgentInstallInstructions(
  packageKey: keyof typeof ESSENTIAL_PACKAGES
): string {
  const pkg = ESSENTIAL_PACKAGES[packageKey];
  const currentPlatform = platform() as "win32" | "darwin" | "linux";
  const installCmd = pkg.installCommand[currentPlatform];
  const installGuide = pkg.installGuide[currentPlatform];
  
  const platformName = {
    win32: "Windows",
    darwin: "macOS",
    linux: "Linux",
  }[currentPlatform];
  
  return `## ${pkg.name} Not Found

**Platform:** ${platformName}

**Automatic Installation:**
\`\`\`bash
${installCmd}
\`\`\`

**Manual Installation Guide:**
${installGuide}

**Note:** The command above can be run automatically by the agent with user permission.
Use the \`bash\` tool to execute the installation command.`;
}

/**
 * Generate system prompt section for missing packages
 */
export async function generateMissingPackagesPrompt(): Promise<string> {
  const results = await checkAllPackages();
  const missing = results.filter(r => !r.installed);
  
  if (missing.length === 0) {
    return "";
  }
  
  const essential = missing.filter(r => r.priority === "essential");
  const recommended = missing.filter(r => r.priority === "recommended");
  
  let prompt = "\n\n## 🔧 Missing Dependencies\n\n";
  
  if (essential.length > 0) {
    prompt += "**Essential packages missing (required for jobs):**\n";
    for (const pkg of essential) {
      prompt += `- **${pkg.name}** - Install with: \`${pkg.installCommand}\`\n`;
    }
    prompt += "\n";
  }
  
  if (recommended.length > 0) {
    prompt += "**Recommended packages missing (optional but useful):**\n";
    for (const pkg of recommended) {
      prompt += `- **${pkg.name}** - Install with: \`${pkg.installCommand}\`\n`;
    }
    prompt += "\n";
  }
  
  prompt += `**When user needs a missing package:**
1. Ask: "I need to install ${essential[0]?.name || recommended[0]?.name}. May I install it for you?"
2. If approved, run the install command using the bash tool
3. Verify installation: Check the package version after installation
4. Continue with the original task

**Example:**
\`\`\`
User: "Create a Python job that scrapes this website"
Agent: "I notice Python is not installed. May I install it for you? (Takes ~2 minutes)"
User: "Yes please"
Agent: bash({ command: "${essential.find(p => p.name === "Python")?.installCommand || ""}" })
Agent: "Python installed successfully! Now creating your scraper job..."
\`\`\`

**Important:**
- ALWAYS ask permission before installing
- Show estimated time (usually 1-3 minutes)
- Verify successful installation before continuing
- If installation fails, provide manual installation link
`;
  
  return prompt;
}

/**
 * Install a package (requires user permission first!)
 */
export async function installPackage(
  packageKey: keyof typeof ESSENTIAL_PACKAGES,
  onProgress?: (status: string) => void
): Promise<{ success: boolean; error?: string }> {
  const pkg = ESSENTIAL_PACKAGES[packageKey];
  const currentPlatform = platform() as "win32" | "darwin" | "linux";
  const installCmd = pkg.installCommand[currentPlatform];
  
  try {
    onProgress?.(`Installing ${pkg.name}...`);
    
    // Run installation command
    const { stdout, stderr } = await execAsync(installCmd, {
      timeout: 300_000, // 5 minutes
    });
    
    onProgress?.(`${pkg.name} installation output: ${stdout}`);
    
    if (stderr && !stderr.includes("warning")) {
      console.warn(`[PackageManager] Install warnings:`, stderr);
    }
    
    // Verify installation
    onProgress?.(`Verifying ${pkg.name} installation...`);
    const checkResult = await checkPackage(packageKey);
    
    if (!checkResult.installed) {
      return {
        success: false,
        error: `Installation completed but ${pkg.name} not found. Try manual installation: ${pkg.installGuide[currentPlatform]}`,
      };
    }
    
    onProgress?.(`${pkg.name} installed successfully: ${checkResult.version}`);
    return { success: true };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[PackageManager] Failed to install ${pkg.name}:`, error);
    
    return {
      success: false,
      error: `Failed to install ${pkg.name}: ${errorMsg}`,
    };
  }
}

/**
 * Check if package manager is available (for installation commands)
 */
export async function checkPackageManagerAvailable(): Promise<{
  available: boolean;
  manager: string;
}> {
  const currentPlatform = platform();
  
  if (currentPlatform === "win32") {
    // Check for winget (Windows 11+)
    try {
      await execAsync("winget --version", { timeout: 5000 });
      return { available: true, manager: "winget" };
    } catch {
      return { available: false, manager: "none" };
    }
  }
  
  if (currentPlatform === "darwin") {
    // Check for Homebrew
    try {
      await execAsync("brew --version", { timeout: 5000 });
      return { available: true, manager: "brew" };
    } catch {
      return { available: false, manager: "none" };
    }
  }
  
  // Linux - apt (Debian/Ubuntu)
  try {
    await execAsync("apt-get --version", { timeout: 5000 });
    return { available: true, manager: "apt" };
  } catch {
    return { available: false, manager: "none" };
  }
}
