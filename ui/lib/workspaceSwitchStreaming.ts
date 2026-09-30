/**
 * Detect active agent streams and running jobs before org/namespace workspace switch.
 */

import { activeStreamRequests, untrackActiveStream } from "./agentStreamRecovery";
import { useChatStore } from "../stores/chatStore";
import { gateway } from "../src/lib/gateway";

export interface ActiveJobForSwitch {
  id: string;
  name: string;
  type: string;
  status: string;
}

/** Chat ids with an in-flight or UI-visible agent stream. */
export function getActiveStreamChatIds(): string[] {
  const ids = new Set<string>();

  for (const chatId of activeStreamRequests.keys()) {
    ids.add(chatId);
  }

  const store = useChatStore.getState();

  for (const chat of store.chats) {
    if (chat.isStreaming) {
      ids.add(chat.id);
    }
  }

  for (const [chatId, state] of store.chatStates.entries()) {
    if (state.isStreaming || state.isSending) {
      ids.add(chatId);
    }
    if (state.messages.some((m) => m.isStreaming)) {
      ids.add(chatId);
    }
  }

  for (const chatId of store.streamingState.keys()) {
    ids.add(chatId);
  }

  return [...ids];
}

export function hasActiveAgentStreams(): boolean {
  return getActiveStreamChatIds().length > 0;
}

export async function fetchActiveJobsForWorkspaceSwitch(): Promise<
  ActiveJobForSwitch[]
> {
  const response = await gateway.send("jobs:active-list", {});
  if (!response.success || !response.data) {
    return [];
  }
  const data = response.data as { jobs?: ActiveJobForSwitch[] };
  return Array.isArray(data.jobs) ? data.jobs : [];
}

/** Stop gateway streams and clear local streaming UI for the given chats. */
export async function abortActiveAgentStreams(
  chatIds: string[] = getActiveStreamChatIds(),
): Promise<void> {
  if (chatIds.length === 0) {
    return;
  }

  await Promise.all(
    chatIds.map(async (chatId) => {
      const requestId = activeStreamRequests.get(chatId);
      if (requestId) {
        gateway.cancelRequest(requestId);
        untrackActiveStream(chatId);
      }
      await gateway.send("agent:stop", { chatId }).catch(() => {});
    }),
  );

  const store = useChatStore.getState();
  for (const chatId of chatIds) {
    store.setSending(chatId, false);
    store.setChatStreaming(chatId, false);
    const chatState = store.chatStates.get(chatId);
    const streamingMsg = chatState?.messages.find((m) => m.isStreaming);
    if (streamingMsg) {
      store.finalizeStreamingMessage(streamingMsg.id, chatId);
    }
  }
}

export async function stopActiveJobsForWorkspaceSwitch(): Promise<void> {
  await gateway.send("jobs:stop-all", {
    reason: "Job stopped — workspace switch",
  });
}

function formatActiveJobsPrompt(jobs: ActiveJobForSwitch[]): string {
  if (jobs.length === 0) {
    return "";
  }
  if (jobs.length === 1) {
    return `1 job is still running (${jobs[0].name})`;
  }
  const preview = jobs
    .slice(0, 3)
    .map((job) => job.name)
    .join(", ");
  const suffix = jobs.length > 3 ? ` and ${jobs.length - 3} more` : "";
  return `${jobs.length} jobs are still running (${preview}${suffix})`;
}

function buildWorkspaceSwitchConfirmMessage(
  streamCount: number,
  activeJobs: ActiveJobForSwitch[],
): string {
  const parts: string[] = [];

  if (streamCount > 0) {
    parts.push(
      streamCount === 1
        ? "An agent is still working in your chats"
        : `${streamCount} agents are still working in your chats`,
    );
  }

  const jobPrompt = formatActiveJobsPrompt(activeJobs);
  if (jobPrompt) {
    parts.push(jobPrompt);
  }

  return (
    `${parts.join(".\n")}.\n\n` +
    "Switching workspace will stop active responses and running jobs.\n\n" +
    "Switch anyway?"
  );
}

/**
 * If streams or jobs are active, confirm with the user and stop them before switching.
 * Returns true when switching should proceed.
 */
export async function confirmAndAbortStreamsForWorkspaceSwitch(): Promise<boolean> {
  const [streamIds, activeJobs] = await Promise.all([
    Promise.resolve(getActiveStreamChatIds()),
    fetchActiveJobsForWorkspaceSwitch(),
  ]);

  if (streamIds.length === 0 && activeJobs.length === 0) {
    return true;
  }

  const proceed = window.confirm(
    buildWorkspaceSwitchConfirmMessage(streamIds.length, activeJobs),
  );
  if (!proceed) {
    return false;
  }

  await Promise.all([
    streamIds.length > 0
      ? abortActiveAgentStreams(streamIds)
      : Promise.resolve(),
    activeJobs.length > 0
      ? stopActiveJobsForWorkspaceSwitch()
      : Promise.resolve(),
  ]);
  return true;
}
