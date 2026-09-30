export type ManualConnectionPlatform = "windows" | "mac" | "linux";

export const CLAUDE_MANUAL_AGENT_MODEL_ID = "gemini-3.8-flash";

export interface ClaudeManualConnectionStep {
  title: string;
  description: string;
  command?: string;
}

export function detectManualConnectionPlatform(): ManualConnectionPlatform {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) {
    return "windows";
  }
  if (platform.includes("mac")) {
    return "mac";
  }
  return "linux";
}

export function getTerminalLabel(platform: ManualConnectionPlatform): string {
  if (platform === "windows") {
    return "PowerShell";
  }
  if (platform === "mac") {
    return "Terminal";
  }
  return "terminal";
}

export function getClaudeCliInstallCommand(
  platform: ManualConnectionPlatform,
): string {
  if (platform === "windows") {
    return "irm https://claude.ai/install.ps1 | iex";
  }
  return "curl -fsSL https://claude.ai/install.sh | bash";
}

export function getClaudeManualConnectionSteps(
  platform: ManualConnectionPlatform = detectManualConnectionPlatform(),
): ClaudeManualConnectionStep[] {
  const terminal = getTerminalLabel(platform);
  const installCommand = getClaudeCliInstallCommand(platform);

  return [
    {
      title: `Open ${terminal}`,
      description:
        platform === "windows"
          ? "Press Win, type PowerShell, and open Windows PowerShell."
          : platform === "mac"
            ? "Open Terminal from Applications → Utilities, or press Cmd+Space and type Terminal."
            : "Open your system terminal application.",
    },
    {
      title: "Install the Claude Code CLI",
      description: `In the ${terminal} window from Step 1, paste this command and press Enter. It downloads Claude Code from Anthropic and installs it on your computer (not inside Paprwork).`,
      command: installCommand,
    },
    {
      title: "Verify the install",
      description: `Still in ${terminal}, run this and press Enter. You should see a version number (for example 2.1.x).`,
      command: "claude --version",
    },
    {
      title: "Sign in and get your token",
      description: `In the same ${terminal}, run this and press Enter. Your browser opens for Claude sign-in. When it finishes, copy the full line in ${terminal} that starts with sk-ant-oat01-.`,
      command: "claude setup-token",
    },
  ];
}

export function buildClaudeManualAgentPrompt(
  platform: ManualConnectionPlatform = detectManualConnectionPlatform(),
): string {
  const terminal = getTerminalLabel(platform);
  const installCommand = getClaudeCliInstallCommand(platform);

  return [
    "I need help connecting my Claude Pro/Max subscription to Paprwork.",
    "The automatic Claude CLI install failed on this machine.",
    "",
    `My platform: ${platform}.`,
    "",
    "Please help me:",
    "1. Install the official Claude Code CLI using the HTTPS installer (prefer this over npm).",
    `2. Use ${terminal} and run: ${installCommand}`,
    "3. Verify with: claude --version",
    "4. Run claude setup-token (or ask me to run it if you cannot open an interactive terminal).",
    "",
    "After setup-token finishes, I will copy the token starting with sk-ant-oat01- and paste it in Paprwork Settings → AI Models → Claude.",
    "",
    "Walk me through step by step. Ask before running commands that need admin approval.",
  ].join("\n");
}
