/**
 * "Fix" on an app card: open the app next to a fresh Pen chat (same merged
 * split view as a cloud install) and send Pen what failed, so it can start
 * investigating without the user retyping the error.
 */
import type { AppHealth } from "../../src/core/utils/appsHealth";
import { openCloudInstalledAppWithChat } from "./openCloudInstalledAppWithChat";

export function buildFixAppMessage(input: {
  appId: string;
  appTitle: string;
  health?: AppHealth;
  unnamed?: boolean;
}): string {
  const { appId, appTitle, health } = input;
  if (input.unnamed) {
    return [
      `The app "${appTitle}" (appId: ${appId}) has no real name — it shows its id instead.`,
      "Look at what the app does, suggest a short descriptive name, and rename it once I confirm.",
    ].join("\n\n");
  }
  const lines = [`My app "${appTitle}" (appId: ${appId}) has a failing automation.`];
  if (health?.failingJobName) {
    lines.push(
      `Job: ${health.failingJobName}${health.failingJobId ? ` (jobId: ${health.failingJobId})` : ""}`,
    );
  }
  if (health?.error) lines.push(`Last error: ${health.error}`);
  if (health && health.failureStreak > 1) {
    lines.push(`It has failed ${health.failureStreak} times in a row.`);
  }
  lines.push(
    "Please read the job logs, find the root cause, fix it, and re-run the job to confirm it passes. If it needs something from me (like a key or a sign-in), tell me exactly what.",
  );
  return lines.join("\n");
}

export function openAppToFix(
  createChat: () => Promise<string | null>,
  input: { appId: string; appTitle: string; health?: AppHealth; unnamed?: boolean },
): Promise<void> {
  return openCloudInstalledAppWithChat(createChat, {
    appId: input.appId,
    appTitle: input.appTitle,
    chatTabTitle: `Fix ${input.appTitle}`,
    agentMessage: buildFixAppMessage(input),
  });
}
