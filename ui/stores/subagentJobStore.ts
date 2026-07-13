/**
 * Subagent Job Store - Maps reportChatId → running delegation metadata.
 *
 * When delegate_task runs, the UI shows a placeholder (DelegationCard) because
 * we don't have the job ID until the tool returns. AgentJobExecutor broadcasts
 * subagent-job-started when a sub-agent job starts, so we can show MiniChatCard
 * during the run and receive subagent-chat:activity (thinking, tool calls).
 */

import { create } from "zustand";

export interface SubagentJobInfo {
  jobId: string;
  subAgentId?: string;
  agentName?: string;
  agentIcon?: string;
}

interface SubagentJobStore {
  /** reportChatId -> latest running sub-agent job metadata */
  jobByReportChat: Map<string, SubagentJobInfo>;
  setJobForChat: (reportChatId: string, info: SubagentJobInfo) => void;
  getJobForChat: (reportChatId: string) => SubagentJobInfo | undefined;
  /** @deprecated Use getJobForChat */
  getJobIdForChat: (reportChatId: string) => string | undefined;
}

export const useSubagentJobStore = create<SubagentJobStore>((set, get) => ({
  jobByReportChat: new Map(),

  setJobForChat: (reportChatId, info) =>
    set((state) => {
      const next = new Map(state.jobByReportChat);
      next.set(reportChatId, info);
      return { jobByReportChat: next };
    }),

  getJobForChat: (reportChatId) => get().jobByReportChat.get(reportChatId),

  getJobIdForChat: (reportChatId) =>
    get().jobByReportChat.get(reportChatId)?.jobId,
}));

/**
 * Call once at app root to listen for subagent-job-started broadcasts.
 */
export function initSubagentJobStore(): void {
  const handler = (e: Event) => {
    const ev = e as CustomEvent<{ type: string; data?: unknown }>;
    const detail = ev.detail;
    if (detail?.type !== "subagent-job-started") return;
    const data = detail.data as {
      jobId?: string;
      reportChatId?: string;
      subAgentId?: string;
      agentName?: string;
      agentIcon?: string;
    };
    if (data?.jobId && data?.reportChatId) {
      useSubagentJobStore.getState().setJobForChat(data.reportChatId, {
        jobId: data.jobId,
        subAgentId: data.subAgentId,
        agentName: data.agentName,
        agentIcon: data.agentIcon,
      });
    }
  };

  window.addEventListener("gateway-broadcast", handler as EventListener);
}
