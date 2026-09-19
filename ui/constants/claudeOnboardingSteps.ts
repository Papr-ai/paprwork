import {
  detectManualConnectionPlatform,
  getClaudeCliInstallCommand,
  getTerminalLabel,
  type ManualConnectionPlatform,
} from "./claudeManualConnection";

export type ClaudeOnboardingStepMode = "run" | "hand" | "paste";

export interface ClaudeOnboardingStepDefinition {
  title: string;
  body: string;
  cmd: string | null;
  mode: ClaudeOnboardingStepMode;
  action: string;
  running: string;
  defaultOk: string;
}

function machineLabel(platform: ManualConnectionPlatform): string {
  if (platform === "mac") {
    return "this Mac";
  }
  if (platform === "windows") {
    return "this PC";
  }
  return "this computer";
}

export function getClaudeOnboardingSteps(
  platform: ManualConnectionPlatform = detectManualConnectionPlatform(),
): ClaudeOnboardingStepDefinition[] {
  const machine = machineLabel(platform);
  const terminal = getTerminalLabel(platform);
  const installCmd = getClaudeCliInstallCommand(platform);
  const checkCmd =
    platform === "windows" ? "where claude && claude --version" : "which claude && claude --version";

  return [
    {
      title: `Check ${machine}`,
      body: `Papr looks for an existing Claude Code install, a stale token, or a half-finished setup — so you resume instead of starting over.`,
      cmd: checkCmd,
      mode: "run",
      action: "Run check",
      running: "Checking your machine",
      defaultOk: "No install found. Nothing stale to clean up.",
    },
    {
      title: "Install Claude Code",
      body: "Papr can run this for you. It downloads Claude Code from Anthropic and installs it on your computer. You will see the output as it happens.",
      cmd: installCmd,
      mode: "run",
      action: "Install for me",
      running: "Installing Claude Code",
      defaultOk: "Installed Claude Code",
    },
    {
      title: "Sign in to Claude",
      body: `This one needs you — it opens your browser and prints a token that only you should see. Papr opens ${terminal} and runs the command; finish the sign-in there.`,
      cmd: "claude setup-token",
      mode: "hand",
      action: `Open ${terminal} and run it`,
      running: `Waiting for you to finish in ${terminal}`,
      defaultOk: "Sign-in finished. Token is on screen in Terminal.",
    },
    {
      title: "Paste your token",
      body: "Copy the whole line starting with sk-ant-oat01- from Terminal and paste it below. Extra spaces and line breaks are fine — Papr trims them before verifying with Anthropic.",
      cmd: null,
      mode: "paste",
      action: "Verify token",
      running: "Verifying with Anthropic",
      defaultOk: "Connected to Claude",
    },
  ];
}
