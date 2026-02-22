/**
 * MessageItem Component - Individual chat message
 * Displays user or assistant messages with streaming support, thinking, and tool calls
 * Matches Paprwork v1 design with sequence-based rendering
 */

import React, { useEffect } from "react";
import type { ChatMessage } from "../../stores/chatStore";
import { useProfileStore } from "../../stores/profileStore";
import { ThinkingCard } from "./ThinkingCard";
import { ExploringCard } from "./ExploringCard";
import { PaprLogoIcon } from "./PaprLogoIcon";
import { PlanCard, parsePlanFromToolResult } from "./PlanCard";
import { JobStatusCard, parseJobStatusFromToolResult } from "./JobStatusCard";
import {
  DelegationCard,
  parseDelegationFromToolResult,
} from "./DelegationCard";
import { MiniChatCard } from "./MiniChatCard";
import { Markdown } from "../common/Markdown";
import { getToolDisplayLabel } from "../../utils/toolDisplay";
import { useJobLiveLogsStore } from "../../stores/jobLiveLogsStore";
import "./MessageItem.css";

interface MessageItemProps {
  message: ChatMessage;
}

/**
 * Render V1-style sequence (interleaved text and tool calls)
 * Expected output:
 * - Thinking card (if present)
 * - Exploring card with: text1 → tool1 → text2 → tool2 → etc (interleaved)
 * - Final text outside (if any text after last tool)
 */
function renderSequence(
  sequence: Array<{ type: string; data: any }>,
  message: ChatMessage,
  getJobName: (jobId: string) => string | undefined,
): React.ReactNode {
  console.log(
    "[MessageItem] Rendering sequence:",
    JSON.stringify(sequence, null, 2),
  );

  const elements: React.ReactNode[] = [];

  // Find if there are any tools in the sequence
  const hasTools = sequence.some((item) => item.type === "tool");
  const hasThinking = sequence.some((item) => item.type === "thinking");

  // Get reasoning content (streaming or final from sequence)
  const reasoning = message.isStreaming
    ? message.streamingReasoning || message.reasoning
    : message.reasoning;

  // Extract thinking from sequence OR streaming state (show at top)
  if (hasThinking) {
    const thinkingItem = sequence.find((item) => item.type === "thinking");
    if (thinkingItem && typeof thinkingItem.data === "string") {
      elements.push(
        <ThinkingCard
          key="thinking"
          content={thinkingItem.data}
          isStreaming={false}
        />,
      );
    }
  } else if (reasoning && reasoning.trim()) {
    // Thinking is still streaming (not in sequence yet)
    elements.push(
      <ThinkingCard
        key="thinking"
        content={reasoning}
        isStreaming={message.isStreaming}
      />,
    );
  }

  if (hasTools) {
    // Build exploring card with interleaved text and tools
    const exploringItems: React.ReactNode[] = [];
    // Map of planId → latest PlanData — ensures one card per plan per response
    const planCardMap = new Map<
      string,
      Parameters<typeof PlanCard>[0]["data"]
    >();
    // Map of jobId → latest JobStatusData — ensures one card per job per response
    const jobStatusCardMap = new Map<
      string,
      Parameters<typeof JobStatusCard>[0]["data"]
    >();
    // Track which jobs/delegations we've already added to exploringItems (to prevent duplicates)
    const addedJobIds = new Set<string>();
    const addedDelegationIds = new Set<string>();
    let finalTextAfterAllTools: string | null = null;

    // Find the index of the last tool
    let lastToolIndex = -1;
    for (let i = sequence.length - 1; i >= 0; i--) {
      if (sequence[i].type === "tool") {
        lastToolIndex = i;
        break;
      }
    }

    sequence.forEach((item, index) => {
      if (item.type === "thinking") {
        // Already rendered above
        return;
      }

      if (
        item.type === "text" &&
        typeof item.data === "string" &&
        item.data.trim()
      ) {
        // Text after last tool goes outside
        if (index > lastToolIndex) {
          finalTextAfterAllTools =
            (finalTextAfterAllTools || "") + item.data.trim();
        } else {
          // Text before/between tools → goes inside exploring card
          exploringItems.push(
            <div key={`text-${index}`} className="exploring-narration">
              <Markdown>{item.data.trim()}</Markdown>
            </div>,
          );
        }
      } else if (item.type === "tool") {
        const toolData = item.data as any;
        const toolCall = {
          id: `tool-${index}`,
          toolName: toolData.name || "tool",
          args: toolData.input || {},
          status: toolData.status || "success",
          result: toolData.output,
          error: toolData.error,
        };

        // Check if this is a plan tool and extract plan data
        // Use a Map so multiple create_plan/update_plan calls for the same plan
        // within one response show only once (the latest state).
        const toolName = toolData.name;
        if (
          (toolName === "create_plan" || toolName === "update_plan") &&
          toolCall.result
        ) {
          const planData = parsePlanFromToolResult(
            toolName,
            typeof toolCall.result === "string"
              ? toolCall.result
              : JSON.stringify(toolCall.result),
          );
          if (planData) {
            planCardMap.set(planData.planId, planData);
          }
        }

        // Parse run_job – show card when running (no result) OR when finished (with result)
        let runJobData: Parameters<typeof JobStatusCard>[0]["data"] | null =
          null;
        if (toolName === "run_job") {
          if (toolCall.result) {
            runJobData = parseJobStatusFromToolResult(
              toolName,
              toolCall.result,
            );
            if (runJobData) jobStatusCardMap.set(runJobData.jobId, runJobData);
          } else {
            // Job is running – try to get job name from store
            const jobId = (toolCall.args?.jobId as string) || "unknown";
            const jobName = getJobName(jobId);

            // If name not in store yet, fetch it in background
            // The broadcast will update the UI when it arrives
            if (!jobName && jobId !== "unknown") {
              const fetchJobName = useJobLiveLogsStore.getState().fetchJobName;
              void fetchJobName(jobId);
            }

            runJobData = {
              type: "job_status",
              jobId,
              jobName: jobName || jobId, // Use jobId as fallback until name arrives
              runId: "running",
              status: "running",
              startedAt: new Date().toISOString(),
            };
            jobStatusCardMap.set(jobId, runJobData);
          }
        }

        // Parse delegate_task – show card when running (no result) OR when finished (with result)
        let delegationData:
          | Parameters<typeof DelegationCard>[0]["data"]
          | null = null;
        if (toolName === "delegate_task") {
          if (toolCall.result) {
            // Delegation finished – parse result
            delegationData = parseDelegationFromToolResult(
              toolName,
              typeof toolCall.result === "string"
                ? toolCall.result
                : toolCall.result,
            );
          } else {
            // Delegation is running – show placeholder card
            // (covers status="calling" OR no result yet)
            const task = (toolCall.args?.task as string) || "Delegated task";
            const agentId = (toolCall.args?.useAgentId as string) || "default";
            delegationData = {
              id: toolCall.id || `delegation-${index}`,
              agentId,
              agentName: undefined,
              task,
              context: (toolCall.args?.context as string) || undefined,
              status: "running",
            };
            console.log(
              "[MessageItem] Created placeholder delegation card:",
              delegationData,
            );
          }
        }

        exploringItems.push(
          <div key={`tool-${index}`} className="exploring-tool-item">
            <span className="exploring-tool-arrow">→</span>
            <span className="exploring-tool-name">
              {getToolDisplayLabel(toolCall)}
            </span>
            {toolCall.status === "success" && (
              <span className="exploring-tool-success">✓</span>
            )}
            {toolCall.status === "error" && (
              <span className="exploring-tool-error">✗</span>
            )}
          </div>,
        );

        if (runJobData) {
          // Only add if we haven't already added this jobId
          if (!addedJobIds.has(runJobData.jobId)) {
            exploringItems.push(
              <JobStatusCard
                key={`job-inline-${runJobData.jobId}`}
                data={runJobData}
              />,
            );
            addedJobIds.add(runJobData.jobId);
          }
        }

        if (delegationData) {
          // Only add if we haven't already added this delegation ID
          if (!addedDelegationIds.has(delegationData.id)) {
            const useMiniChat = !!(
              delegationData.reportChatId ||
              (toolCall.args?.reportChatId as string | undefined)
            );
            const miniStatus =
              delegationData.status === "pending" ||
              delegationData.status === "running"
                ? "active"
                : delegationData.status === "completed"
                  ? "completed"
                  : "failed";
            exploringItems.push(
              useMiniChat ? (
                <MiniChatCard
                  key={`delegation-${delegationData.id}`}
                  delegationId={delegationData.id}
                  subAgentName={
                    delegationData.agentName ?? delegationData.agentId
                  }
                  task={delegationData.task}
                  status={miniStatus}
                  context={delegationData.context}
                  resultText={delegationData.resultText}
                  error={delegationData.error}
                  subAgentIcon={delegationData.agentIcon}
                />
              ) : (
                <DelegationCard
                  key={`delegation-${delegationData.id}`}
                  data={delegationData}
                />
              ),
            );
            addedDelegationIds.add(delegationData.id);
          }
        }
      }
    });

    // Render one plan card per planId (latest state wins)
    if (planCardMap.size > 0) {
      planCardMap.forEach((planData, planId) => {
        elements.push(<PlanCard key={`plan-${planId}`} data={planData} />);
      });
    }

    // Job status cards are rendered INLINE inside exploring card (after run_job tool)

    // Render exploring card with all interleaved items
    if (exploringItems.length > 0) {
      const hasCallingTool = sequence.some(
        (item) =>
          item.type === "tool" &&
          (item.data as { status?: string }).status === "calling",
      );
      const isExploring = message.isStreaming || hasCallingTool;

      elements.push(
        <div key="exploring" className="exploring-card">
          <div className="exploring-card-header">
            <span className="exploring-chevron">▼</span>
            <span className="exploring-label-text">Working</span>
            {isExploring && <PaprLogoIcon />}
          </div>
          <div
            className="exploring-card-content"
            style={{ maxHeight: "420px", opacity: "1" }}
          >
            {exploringItems}
          </div>
        </div>,
      );
    }

    // Render final text outside exploring card
    if (finalTextAfterAllTools) {
      elements.push(
        <div key="final-text" className="message-text">
          <Markdown>{finalTextAfterAllTools}</Markdown>
        </div>,
      );
    }
  } else {
    // No tools - just render all text items
    const textItems = sequence.filter((item) => item.type === "text");
    const fullText = textItems.map((item) => item.data).join("\n\n");
    if (fullText.trim()) {
      elements.push(
        <div key="text" className="message-text">
          <Markdown>{fullText}</Markdown>
        </div>,
      );
    }
  }

  return <>{elements}</>;
}

export const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const isUser = message.role === "user";
  const content = message.isStreaming
    ? message.streamingContent || message.content
    : message.content;

  // Get reasoning content (streaming or final)
  const reasoning = message.isStreaming
    ? message.streamingReasoning || message.reasoning
    : message.reasoning;

  // Load user profile from settings
  const { name: userName, email: userEmail, imageUrl: userImageUrl, loadProfile } = useProfileStore();
  useEffect(() => { loadProfile(); }, [loadProfile]);

  // Get job name lookup from store
  const getJobName = useJobLiveLogsStore((state) => state.getJobName);

  // Check if message has V1-style sequence
  const hasSequence = message.sequence && message.sequence.length > 0;

  // Debug logging
  if (!isUser) {
    console.log("[MessageItem] Message:", {
      hasSequence,
      sequenceLength: message.sequence?.length,
      toolCallsLength: message.toolCalls?.length,
      contentLength: content?.length,
    });
  }

  return (
    <div
      className="message-item"
      data-testid={`message-item-${isUser ? "user" : "assistant"}`}
    >
      {/* Avatar - matches v1 exactly */}
      <div className="message-avatar-container">
        {isUser ? (
          // User avatar - profile photo or initials fallback
          userImageUrl ? (
            <img
              src={userImageUrl}
              alt={userName || "User"}
              className="message-avatar-user"
            />
          ) : (
            <div className="message-avatar-user message-avatar-user--initials">
              {(userName || userEmail || "U").charAt(0).toUpperCase()}
            </div>
          )
        ) : (
          // Assistant avatar - Papr logo (actual v1 logo)
          <div className="message-avatar-assistant">
            <svg
              width="16"
              height="16"
              viewBox="0 0 105 124"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="message-avatar-icon"
            >
              <path
                d="M27.9998 101.5C-11.5 158 6.99988 51 43.4008 60.5002C99.2884 75.0861 115.18 20.7781 83.6804 8.27816C40.2693 -8.94844 51.9998 65 27.9998 101.5Z"
                stroke="url(#papr-gradient)"
                strokeWidth="10"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <defs>
                <linearGradient
                  id="papr-gradient"
                  x1="17.2207"
                  y1="89.4214"
                  x2="68.8959"
                  y2="35.8394"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#0060E0" />
                  <stop offset="0.6" stopColor="#00ACFA" />
                  <stop offset="1" stopColor="#0BCDFF" />
                </linearGradient>
              </defs>
            </svg>
          </div>
        )}
      </div>

      {/* Message content */}
      <div className="message-content">
        {/* Name label */}
        <span className="message-sender-name">
          {isUser ? (userName || "You") : "Pen"}
        </span>
        {/* V1-STYLE SEQUENCE RENDERING */}
        {hasSequence && !isUser ? (
          renderSequence(message.sequence!, message, getJobName)
        ) : (
          /* FALLBACK: OLD FORMAT (no sequence) */
          <>
            {/* Thinking card - only for assistant messages */}
            {!isUser && reasoning && (
              <ThinkingCard
                content={reasoning}
                isStreaming={
                  message.isStreaming && !!message.streamingReasoning
                }
              />
            )}

            {/* Plan cards - one per planId (latest state wins) */}
            {!isUser &&
              (() => {
                const planMap = new Map<
                  string,
                  Parameters<typeof PlanCard>[0]["data"]
                >();
                message.toolCalls?.forEach((tc) => {
                  const plan = parsePlanFromToolResult(tc.toolName, tc.result);
                  if (plan) planMap.set(plan.planId, plan);
                });
                return Array.from(planMap.values()).map((plan) => (
                  <PlanCard key={plan.planId} data={plan} />
                ));
              })()}

            {/* Tool calls - only for assistant messages */}
            {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
              <>
                <ExploringCard
                  toolCalls={message.toolCalls}
                  isStreaming={message.isStreaming}
                  narration={content} // Show agent's explanation after tool calls
                />
                {/* JobStatusCard for run_job (fallback when no sequence) */}
                {message.toolCalls.map((tc) => {
                  if (tc.toolName !== "run_job") return null;
                  if (tc.result && tc.status === "success") {
                    const jobData = parseJobStatusFromToolResult(
                      tc.toolName,
                      tc.result,
                    );
                    return jobData ? (
                      <JobStatusCard
                        key={`job-fallback-${jobData.jobId}`}
                        data={jobData}
                      />
                    ) : null;
                  }
                  if (tc.status === "calling" && tc.args?.jobId) {
                    const jobId = tc.args.jobId as string;
                    const jobName = getJobName(jobId) || jobId;
                    return (
                      <JobStatusCard
                        key={`job-fallback-${jobId}`}
                        data={{
                          type: "job_status",
                          jobId,
                          jobName,
                          runId: "running",
                          status: "running",
                          startedAt: new Date().toISOString(),
                        }}
                      />
                    );
                  }
                  return null;
                })}
                {/* DelegationCard / MiniChatCard for delegate_task (fallback when no sequence) */}
                {message.toolCalls.map((tc) => {
                  if (tc.toolName !== "delegate_task") return null;

                  // Show card with result if available
                  if (tc.result) {
                    const delegationData = parseDelegationFromToolResult(
                      tc.toolName,
                      tc.result,
                    );
                    if (!delegationData) return null;
                    const useMiniChat = !!(
                      delegationData.reportChatId ||
                      (tc.args?.reportChatId as string | undefined)
                    );
                    const miniStatus =
                      delegationData.status === "pending" ||
                      delegationData.status === "running"
                        ? "active"
                        : delegationData.status === "completed"
                          ? "completed"
                          : "failed";
                    return useMiniChat ? (
                      <MiniChatCard
                        key={`delegation-fallback-${delegationData.id}`}
                        delegationId={delegationData.id}
                        subAgentName={
                          delegationData.agentName ?? delegationData.agentId
                        }
                        task={delegationData.task}
                        status={miniStatus}
                        context={delegationData.context}
                        resultText={delegationData.resultText}
                        error={delegationData.error}
                      />
                    ) : (
                      <DelegationCard
                        key={`delegation-fallback-${delegationData.id}`}
                        data={delegationData}
                      />
                    );
                  }

                  // Show placeholder card while running (reportChatId from args; auto-injected value appears when result arrives)
                  if (tc.status === "calling") {
                    const task = (tc.args?.task as string) || "Delegated task";
                    const agentId =
                      (tc.args?.useAgentId as string) || "default";
                    const data = {
                      id: tc.id || `delegation-${Date.now()}`,
                      agentId,
                      agentName: undefined,
                      task,
                      context: (tc.args?.context as string) || undefined,
                      status: "running" as const,
                      reportChatId: tc.args?.reportChatId as string | undefined,
                    };
                    const useMiniChatPlaceholder = !!data.reportChatId;
                    return useMiniChatPlaceholder ? (
                      <MiniChatCard
                        key={`delegation-fallback-${data.id}`}
                        delegationId={data.id}
                        subAgentName={data.agentName ?? data.agentId}
                        task={data.task}
                        status="active"
                        context={data.context}
                      />
                    ) : (
                      <DelegationCard
                        key={`delegation-fallback-${tc.id || "calling"}`}
                        data={data}
                      />
                    );
                  }

                  return null;
                })}
              </>
            )}

            {/* Main message text - only show if there are NO tool calls */}
            {content &&
              (!message.toolCalls || message.toolCalls.length === 0) && (
                <div className="message-text">
                  <Markdown>{content}</Markdown>
                  {message.isStreaming && !message.streamingReasoning && (
                    <span className="streaming-cursor">▊</span>
                  )}
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
};
