import type { JobRecord } from "../hooks/useJobs";
import { useChatStore } from "../stores/chatStore";

export function buildJobDiagnosisMessage(job: JobRecord, logs: string): string {
  const looksFailing =
    job.status === "failed" ||
    (job.exitCode !== undefined &&
      job.exitCode !== null &&
      job.exitCode !== 0) ||
    Boolean(job.error?.trim());

  const lines = [
    looksFailing
      ? `Please diagnose why my Paprwork job "${job.name}" is failing and suggest concrete fixes.`
      : `Please review my Paprwork job "${job.name}" — check recent runs and logs for failures or issues and suggest improvements.`,
    "",
    "Job details:",
    `- ID: ${job.id}`,
    `- Type: ${job.type}`,
    `- Status: ${job.status}`,
    `- Command: ${job.command ?? "N/A"}`,
    `- Last run: ${job.lastRunAt ?? "never"}`,
  ];

  if (job.exitCode !== undefined && job.exitCode !== null) {
    lines.push(`- Exit code: ${job.exitCode}`);
  }
  if (job.error?.trim()) {
    lines.push(`- Error: ${job.error}`);
  }

  const trimmedLogs = logs.trim();
  if (trimmedLogs) {
    const snippet =
      trimmedLogs.length > 4000 ? trimmedLogs.slice(-4000) : trimmedLogs;
    lines.push("", "Recent logs:", "```", snippet, "```");
  }

  lines.push(
    "",
    "Investigate the job folder, logs, and run history. Use get_job_history, bash, and filesystem tools as needed.",
  );

  return lines.join("\n");
}

interface OpenJobDiagnosisChatDeps {
  createChat: () => Promise<string | null>;
  createTab: (type: "chat", entityId: string, title: string) => string;
  switchToTab: (tabId: string) => void;
}

export async function openJobDiagnosisChat(
  job: JobRecord,
  logs: string,
  deps: OpenJobDiagnosisChatDeps,
): Promise<void> {
  const chatId = await deps.createChat();
  if (!chatId) return;

  useChatStore
    .getState()
    .setDraftMessage(chatId, buildJobDiagnosisMessage(job, logs));

  const title =
    job.name.length > 28 ? `Diagnose: ${job.name.slice(0, 25)}…` : `Diagnose: ${job.name}`;
  const tabId = deps.createTab("chat", chatId, title);
  deps.switchToTab(tabId);
}
