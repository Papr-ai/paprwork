import { runSetupCommand } from "./runSetupCommand.js";

let installation: Promise<string> | undefined;

/** All chats/platform sessions share one installation attempt per gateway lifetime. */
export function installPlaywrightChromium(): Promise<string> {
  return installation ??= runSetupCommand("npx playwright install chromium", {
    diagnosticName: "chromium-install",
    stdio: "inherit",
    timeout: 5 * 60 * 1000,
  });
}
