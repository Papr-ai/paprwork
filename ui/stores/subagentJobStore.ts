/**
 * Subagent Job Store - Maps reportChatId → jobId for running delegations.
 *
 * When delegate_task runs, the UI shows a placeholder (DelegationCard) because
 * we don't have the job ID until the tool returns. AgentJobExecutor broadcasts
 * subagent-job-started when a sub-agent job starts, so we can show MiniChatCard
 * during the run and receive subagent-chat:activity (thinking, tool calls).
 */

import { create } from "zustand";

interface SubagentJobStore {
  /** reportChatId -> jobId for currently running sub-agent jobs */
  jobIdByReportChat: Map<string, string>;
  setJobForChat: (reportChatId: string, jobId: string) => void;
  getJobIdForChat: (reportChatId: string) => string | undefined;
}

export const useSubagentJobStore = create<SubagentJobStore>((set, get) => ({
  jobIdByReportChat: new Map(),

  setJobForChat: (reportChatId, jobId) =>
    set((state) => {
      const next = new Map(state.jobIdByReportChat);
      next.set(reportChatId, jobId);
      return { jobIdByReportChat: next };
    }),

  getJobIdForChat: (reportChatId) =>
    get().jobIdByReportChat.get(reportChatId),
}));

/**
 * Call once at app root to listen for subagent-job-started broadcasts.
 */
export function initSubagentJobStore(): void {
  const handler = (e: Event) => {
    const ev = e as CustomEvent<{ type: string; data?: unknown }>;
    const detail = ev.detail;
    if (detail?.type !== "subagent-job-started") return;
    const data = detail.data as { jobId?: string; reportChatId?: string };
    if (data?.jobId && data?.reportChatId) {
      useSubagentJobStore.getState().setJobForChat(
        data.reportChatId,
        data.jobId,
      );
    }
  };

  window.addEventListener("gateway-broadcast", handler as EventListener);
}
