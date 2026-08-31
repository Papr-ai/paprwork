/**
 * MessageItem Component - Individual chat message
 * Displays user or assistant messages with streaming support, thinking, and tool calls
 * Matches Paprwork v1 design with sequence-based rendering
 */

import React, { useEffect } from "react";
import type { ChatMessage } from "../../stores/chatStore";
import { useChatStore } from "../../stores/chatStore";
import { useProfileStore } from "../../stores/profileStore";
import { ThinkingCard } from "./ThinkingCard";
import { ExploringCard } from "./ExploringCard";
import { FileWritePreview, hasFilePreview } from "./FileWritePreview";
import {
  AppToolPreview,
  collectWebviewSessionPreview,
  hasAppToolPreview,
  isWebviewSessionPreviewTool,
  shouldShowWebviewSessionPreview,
  WebviewSessionPreview,
} from "./AppToolPreview";
import "./FileWritePreview.css";
import "./AppToolPreview.css";
import { WorkingCard } from "./WorkingCard";
import {
  ToolCallResultFeedback,
  ToolCallStatusIcon,
} from "./ToolCallStatus";
import { PlanCard, parsePlanFromToolResult } from "./PlanCard";
import { JobStatusCard, parseJobStatusFromToolResult } from "./JobStatusCard";
import {
  DelegationCard,
  parseDelegationFromToolResult,
} from "./DelegationCard";
import {
  KeyRequestCard,
  parseKeyRequestFromToolResult,
} from "./KeyRequestCard";
import { MiniChatCard } from "./MiniChatCard";
import { Markdown } from "../common/Markdown";
import { MessageAttachments } from "./MessageAttachments";
import "./MessageAttachments.css";
import { resolveToolCallStatus } from "../../../src/core/utils/interruptedToolResult";
import { getToolDisplayLabel } from "../../utils/toolDisplay";
import { useJobLiveLogsStore } from "../../stores/jobLiveLogsStore";
import { useSubagentJobStore, type SubagentJobInfo } from "../../stores/subagentJobStore";

function resolveDelegationAgentDisplay(
  requestedAgentId: string | undefined,
  subagentJob: SubagentJobInfo | undefined,
  getAgentName: (agentId: string) => string,
): { agentId: string; agentName: string } {
  const trimmedId = requestedAgentId?.trim();
  const agentId = trimmedId || subagentJob?.subAgentId || "unknown";
  const agentName =
    subagentJob?.agentName ||
    (trimmedId ? getAgentName(trimmedId) : undefined) ||
    trimmedId ||
    "Sub-agent";
  return { agentId, agentName };
}
import { useSubAgentNameStore } from "../../stores/subAgentNameStore";
import { MessageCopyButton } from "./MessageCopyButton";
import { getAssistantCopyText } from "../../utils/getAssistantCopyText";
import "./MessageItem.css";

interface MessageItemProps {
  chatId: string;
  message: ChatMessage;
  delegationFollowUps?: ChatMessage[];
}

/**
 * Render V1-style sequence (interleaved text and tool calls)
 * Expected output:
 * - Thinking card (if present)
 * - Exploring card with: text1 → tool1 → text2 → tool2 → etc (interleaved)
 * - Final text outside (if any text after last tool)
 */
function renderSequence(
  sequence: Array<{ type: string; data: unknown }>,
  message: ChatMessage,
  chatId: string,
  subagentJobForChat: SubagentJobInfo | undefined,
  getJobName: (jobId: string) => string | undefined,
  getAgentName: (agentId: string) => string,
  connectionPaused = false,
  isFinishingWork = false,
  delegationFollowUps: ChatMessage[] = [],
): React.ReactNode {


  const elements: React.ReactNode[] = [];

  // Define handlers for key request cards
  const handleKeySubmit = async (
    name: string,
    value: string,
    permission: "always" | "ask",
  ) => {
    console.log("[MessageItem] handleKeySubmit called", { name, permission });
    try {
      console.log("[MessageItem] Calling window.electronAPI.customKeys.add...");
      const result = await window.electronAPI.customKeys.add({
        name,
        value,
        permission,
        description: "",
      });
      console.log("[MessageItem] Key added successfully:", result);
      // Card will update to "submitted" status via the tool result
      // TODO: Optionally trigger a re-render to show success state immediately
    } catch (error) {
      console.error("[MessageItem] Failed to add custom key:", error);
    }
  };

  const handleKeyCancel = () => {
    // Card will update to "cancelled" status
    // TODO: Optionally trigger a re-render to show cancelled state immediately
  };

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
    const webviewSessionToolCalls: Array<{
      toolName: string;
      args?: Record<string, unknown>;
      result?: unknown;
      status?: string;
    }> = [];
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
    // Map of delegationId → latest DelegationData — for cards OUTSIDE working card
    const delegationCardMap = new Map<
      string,
      Parameters<typeof DelegationCard>[0]["data"] | Parameters<typeof MiniChatCard>[0]
    >();
    // Map of keyName → latest KeyRequestData — ensures one card per key per response
    const keyRequestCardMap = new Map<
      string,
      Parameters<typeof KeyRequestCard>[0]["data"]
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
        const toolData = item.data as {
          name?: string;
          input?: Record<string, unknown>;
          output?: unknown;
          status?: string;
          error?: string;
        };
        const toolStatus = resolveToolCallStatus({
          explicitStatus:
            typeof toolData.status === "string" ? toolData.status : undefined,
          result: toolData.output,
        });
        const toolCall = {
          id: `tool-${index}`,
          toolName: toolData.name || "tool",
          args: toolData.input || {},
          status: toolStatus,
          result: toolStatus === "interrupted" ? undefined : toolData.output,
          error: toolData.error,
        };

        if (isWebviewSessionPreviewTool(toolCall.toolName, toolCall.args)) {
          webviewSessionToolCalls.push({
            toolName: toolCall.toolName,
            args: toolCall.args,
            result: toolCall.result,
            status: toolCall.status,
          });
        }

        // Check if this is a plan tool and extract plan data
        // Use a Map so multiple create_plan/update_plan calls for the same plan
        // within one response show only once (the latest state).
        const toolName = toolData.name;
        if (
          (toolName === "create_plan" ||
            toolName === "update_plan" ||
            toolName === "delete_plan") &&
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

        // Parse request_key – show card when key is requested
        if (toolName === "request_key" && toolCall.result) {
          const keyRequestData = parseKeyRequestFromToolResult(
            toolName,
            toolCall.result,
          );
          if (keyRequestData) {
            keyRequestCardMap.set(keyRequestData.name, keyRequestData);
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
            // Delegation is running – use MiniChatCard if we have jobId from subagent-job-started broadcast.
            const task = (toolCall.args?.task as string) || "Delegated task";
            const requestedAgentId = toolCall.args?.useAgentId as
              | string
              | undefined;
            const { agentId, agentName } = resolveDelegationAgentDisplay(
              requestedAgentId,
              subagentJobForChat,
              getAgentName,
            );
            const jobIdFromStore = subagentJobForChat?.jobId;
            const placeholderId =
              jobIdFromStore || toolCall.id || `delegation-${index}`;
            delegationData = {
              id: placeholderId,
              agentId,
              agentName,
              task,
              context: (toolCall.args?.context as string) || undefined,
              status: "running",
              reportChatId: chatId, // Always set - this is the chat where delegation was initiated
            };
          }
        }

        const _showFilePreview = hasFilePreview(
          toolCall.toolName,
          toolCall.args,
          typeof toolCall.result === "string" ? toolCall.result : undefined,
        );
        const _showAppPreview = hasAppToolPreview(
          toolCall.toolName,
          toolCall.args,
          toolCall.result,
          toolCall.status,
        );
        exploringItems.push(
          <div key={`tool-${index}`} className="exploring-tool-row">
            <div className="exploring-tool-item">
              <span className="exploring-tool-arrow">→</span>
              <span className="exploring-tool-name">
                {getToolDisplayLabel(toolCall)}
              </span>
              <ToolCallStatusIcon status={toolCall.status} />
            </div>
            <ToolCallResultFeedback
              status={toolCall.status}
              result={toolData.output}
              toolError={toolCall.error}
            />
            {_showFilePreview && (
              <FileWritePreview
                toolName={toolCall.toolName}
                args={toolCall.args}
                result={
                  typeof toolCall.result === "string"
                    ? toolCall.result
                    : undefined
                }
              />
            )}
            {_showAppPreview && (
              <AppToolPreview
                toolName={toolCall.toolName}
                args={toolCall.args}
                result={toolCall.result}
                status={toolCall.status}
              />
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
            // Build MiniChatCard props for OUTSIDE working card
            const hasResult = !!toolCall.result;
            const hasRealJobId =
              hasResult ||
              !!delegationData.reportChatId ||
              !!subagentJobForChat?.jobId;
            const useMiniChat = hasRealJobId;
            const miniStatus =
              delegationData.status === "pending" ||
              delegationData.status === "running"
                ? "active"
                : delegationData.status === "completed"
                  ? "completed"
                  : "failed";
            
            // Store delegation data to render OUTSIDE working card
            if (useMiniChat) {
              delegationCardMap.set(delegationData.id, {
                delegationId: delegationData.id,
                subAgentName: delegationData.agentName ?? delegationData.agentId,
                task: delegationData.task,
                status: miniStatus,
                context: delegationData.context,
                resultText: delegationData.resultText,
                error: delegationData.error,
                subAgentIcon: delegationData.agentIcon,
              });
            } else {
              delegationCardMap.set(delegationData.id, delegationData);
            }
            
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

    // Render key request cards (OUTSIDE exploring card, always visible)
    if (keyRequestCardMap.size > 0) {
      keyRequestCardMap.forEach((keyRequestData, keyName) => {
        elements.push(
          <KeyRequestCard
            key={`key-request-${keyName}`}
            data={keyRequestData}
            onSubmit={handleKeySubmit}
            onCancel={handleKeyCancel}
          />,
        );
      });
    }

    // Job status cards are rendered INLINE inside exploring card (after run_job tool)

    const delegationCardElements: React.ReactNode[] = [];
    if (delegationCardMap.size > 0) {
      delegationCardMap.forEach((delegationData, delegationId) => {
        if ("delegationId" in delegationData) {
          delegationCardElements.push(
            <MiniChatCard
              key={`delegation-${delegationId}`}
              delegationId={delegationData.delegationId}
              subAgentName={delegationData.subAgentName}
              task={delegationData.task}
              status={delegationData.status}
              context={delegationData.context}
              resultText={delegationData.resultText}
              error={delegationData.error}
              subAgentIcon={delegationData.subAgentIcon}
              defaultExpanded={false}
            />,
          );
        } else {
          delegationCardElements.push(
            <DelegationCard
              key={`delegation-${delegationId}`}
              data={delegationData}
            />,
          );
        }
      });
    }

    const hasActiveDelegation = Array.from(delegationCardMap.values()).some(
      (delegationData) => {
        if ("delegationId" in delegationData) {
          return delegationData.status === "active";
        }
        return (
          delegationData.status === "running" ||
          delegationData.status === "pending"
        );
      },
    );

    // Extract last activity for header
    let lastActivity = "Working";
    // Find the last tool or text item in the sequence
    for (let i = sequence.length - 1; i >= 0; i--) {
      const item = sequence[i];
      if (item.type === "tool") {
        const toolData = item.data as any;
        const toolName = toolData.name || "tool";
        const isRunning = toolData.status === "calling";
        
        // Special handling for run_job to show job name
        if (toolName === "run_job") {
          const jobId = (toolData.input?.jobId as string) || "unknown";
          const jobName = getJobName(jobId) || jobId;
          lastActivity = isRunning ? `Running job: ${jobName}` : `Job finished: ${jobName}`;
        } else {
          // Use the display label helper
          lastActivity = getToolDisplayLabel({
            toolName,
            args: toolData.input || {},
            status: toolData.status || "success",
          });
        }
        break;
      } else if (item.type === "text" && typeof item.data === "string" && item.data.trim()) {
        // Text after the last tool is the user-facing reply (rendered below Working)
        if (i > lastToolIndex) {
          continue;
        }
        // Use first 50 chars of in-progress narration as activity
        const text = item.data.trim();
        lastActivity = text.length > 50 ? text.substring(0, 50) + "..." : text;
        break;
      }
    }

    // Render working card with delegation cards and tool activity only
    if (exploringItems.length > 0 || delegationCardElements.length > 0) {
      const hasCallingTool = sequence.some(
        (item) =>
          item.type === "tool" &&
          (item.data as { status?: string }).status === "calling",
      );
      const isExploring =
        message.isStreaming || hasCallingTool || hasActiveDelegation;

      // Detect if the message was stopped by checking for stopped tools
      const wasStopped = sequence.some(
        (item) =>
          item.type === "tool" &&
          (item.data as { status?: string; error?: string }).status === "stopped" ||
          (item.data as { error?: string }).error === "Stopped by user",
      );

      const webviewSessionPreviewState = collectWebviewSessionPreview(
        webviewSessionToolCalls,
        message.isStreaming,
      );
      const workingChildren: React.ReactNode[] = [
        ...delegationCardElements,
        ...exploringItems,
      ];
      if (shouldShowWebviewSessionPreview(webviewSessionPreviewState)) {
        workingChildren.push(
          <WebviewSessionPreview
            key="webview-session-preview"
            state={webviewSessionPreviewState!}
          />,
        );
      }

      elements.push(
        <WorkingCard
          key="working"
          isExploring={isExploring}
          lastActivity={lastActivity}
          wasStopped={wasStopped}
          connectionPaused={connectionPaused}
          wasInterrupted={!!message.interrupted}
          isFinishingWork={isFinishingWork}
          contentRevision={workingChildren.length}
        >
          {workingChildren}
        </WorkingCard>,
      );
    }

    // User-facing response text stays below Working (not inside the collapsible)
    if (finalTextAfterAllTools) {
      elements.push(
        <div key="final-text" className="message-text">
          <Markdown>{finalTextAfterAllTools}</Markdown>
        </div>,
      );
    }

    for (const followUp of delegationFollowUps) {
      const followUpText =
        getAssistantCopyText(followUp) || followUp.content.trim();
      if (!followUpText) continue;
      elements.push(
        <div
          key={`delegation-followup-${followUp.id}`}
          className="message-text"
        >
          <Markdown>{followUpText}</Markdown>
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

const MessageItemInner: React.FC<MessageItemProps> = ({
  chatId,
  message,
  delegationFollowUps = [],
}) => {
  const isUser = message.role === "user";
  const content = message.isStreaming
    ? message.streamingContent || message.content
    : message.content;

  // Get reasoning content (streaming or final)
  const reasoning = message.isStreaming
    ? message.streamingReasoning || message.reasoning
    : message.reasoning;

  // Load user profile from settings
  const {
    name: userName,
    email: userEmail,
    imageUrl: userImageUrl,
    loadProfile,
    loaded: profileLoaded,
  } = useProfileStore();
  useEffect(() => {
    if (!profileLoaded) {
      void loadProfile();
    }
  }, [loadProfile, profileLoaded]);

  // Get job name lookup from store
  const getJobName = useJobLiveLogsStore((state) => state.getJobName);

  // Subscribe to subagent job metadata so we re-render when subagent-job-started arrives
  const subagentJobForChat = useSubagentJobStore((s) =>
    s.getJobForChat(chatId),
  );

  // Resolve sub-agent name for delegation cards (shared store — single IPC subscription)
  const getAgentName = useSubAgentNameStore((s) => s.getAgentName);
  const connectionPaused =
    useChatStore((s) => s.chatStates.get(chatId)?.connectionPaused) ?? false;
  const isFinishingWork =
    useChatStore((s) => s.chatStates.get(chatId)?.isFinishingWork) ?? false;

  const copyText = !isUser && !message.isStreaming ? getAssistantCopyText(message) : "";
  const showCopyButton = copyText.length > 0;

  // Check if message has V1-style sequence
  const hasSequence = message.sequence && message.sequence.length > 0;


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
      <div
        className={`message-content${!isUser ? " message-content--assistant" : ""}`}
      >
        {/* Name label */}
        <span className="message-sender-name">
          {isUser ? (userName || "You") : "Pen"}
        </span>

        {isUser && message.attachments && message.attachments.length > 0 && (
          <MessageAttachments attachments={message.attachments} />
        )}

        {/* V1-STYLE SEQUENCE RENDERING */}
        {hasSequence && !isUser ? (
          renderSequence(
            message.sequence!,
            message,
            chatId,
            subagentJobForChat,
            getJobName,
            getAgentName,
            connectionPaused && !!message.isStreaming,
            isFinishingWork && !!message.isStreaming,
            delegationFollowUps,
          )
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

            {/* Key request cards - one per keyName (latest state wins) */}
            {!isUser &&
              (() => {
                const keyRequestMap = new Map<
                  string,
                  Parameters<typeof KeyRequestCard>[0]["data"]
                >();
                message.toolCalls?.forEach((tc) => {
                  const keyRequest = parseKeyRequestFromToolResult(
                    tc.toolName,
                    tc.result,
                  );
                  if (keyRequest) keyRequestMap.set(keyRequest.name, keyRequest);
                });

                // Define handlers for fallback section
                const handleKeySubmit = async (
                  name: string,
                  value: string,
                  permission: "always" | "ask",
                ) => {
                  console.log("[MessageItem:Fallback] handleKeySubmit called", { name, permission });
                  try {
                    console.log("[MessageItem:Fallback] Calling window.electronAPI.customKeys.add...");
                    const result = await window.electronAPI.customKeys.add({
                      name,
                      value,
                      permission,
                      description: "",
                    });
                    console.log("[MessageItem:Fallback] Key added successfully:", result);
                  } catch (error) {
                    console.error(
                      "[MessageItem:Fallback] Failed to add custom key:",
                      error,
                    );
                  }
                };

                const handleKeyCancel = () => {
                  // Card will update to "cancelled" status
                };

                return Array.from(keyRequestMap.values()).map((keyRequest) => (
                  <KeyRequestCard
                    key={`key-request-fallback-${keyRequest.name}`}
                    data={keyRequest}
                    onSubmit={handleKeySubmit}
                    onCancel={handleKeyCancel}
                  />
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
                {message.toolCalls.map((tc) => {
                  if (tc.toolName !== "delegate_task") return null;

                  if (tc.result) {
                    const delegationData = parseDelegationFromToolResult(
                      tc.toolName,
                      tc.result,
                    );
                    if (!delegationData) return null;
                    const miniStatus =
                      delegationData.status === "pending" ||
                      delegationData.status === "running"
                        ? "active"
                        : delegationData.status === "completed"
                          ? "completed"
                          : "failed";
                    return (
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
                        subAgentIcon={delegationData.agentIcon}
                        defaultExpanded={false}
                      />
                    );
                  }

                  if (tc.status === "calling") {
                    const task = (tc.args?.task as string) || "Delegated task";
                    const requestedAgentId = tc.args?.useAgentId as
                      | string
                      | undefined;
                    const { agentId, agentName } = resolveDelegationAgentDisplay(
                      requestedAgentId,
                      subagentJobForChat,
                      getAgentName,
                    );
                    const jobIdFromStore = subagentJobForChat?.jobId;
                    const placeholderId =
                      jobIdFromStore || tc.id || `delegation-${Date.now()}`;
                    if (!chatId && !jobIdFromStore) return null;
                    return (
                      <MiniChatCard
                        key={`delegation-fallback-${placeholderId}`}
                        delegationId={placeholderId}
                        subAgentName={agentName ?? agentId}
                        task={task}
                        status="active"
                        context={(tc.args?.context as string) || undefined}
                        defaultExpanded={false}
                      />
                    );
                  }

                  return null;
                })}
              </>
            )}

            {/* Main message text */}
            {content &&
              (isUser || !message.toolCalls || message.toolCalls.length === 0) && (
                <div className="message-text">
                  <Markdown>{content}</Markdown>
                  {message.isStreaming && !message.streamingReasoning && (
                    <span className="streaming-cursor">▊</span>
                  )}
                </div>
              )}
          </>
        )}

        {showCopyButton && <MessageCopyButton text={copyText} />}
      </div>
    </div>
  );
};

// Memoize to prevent re-renders of unchanged messages during streaming
export const MessageItem = React.memo(MessageItemInner, (prev, next) => {
  // Only re-render if the message actually changed
  if (prev.message.id !== next.message.id) return false;
  if (prev.message.content !== next.message.content) return false;
  if (prev.message.streamingContent !== next.message.streamingContent) return false;
  if (prev.message.streamingReasoning !== next.message.streamingReasoning) return false;
  if (prev.message.reasoning !== next.message.reasoning) return false;
  if (prev.message.isStreaming !== next.message.isStreaming) return false;
  if (prev.message.attachments !== next.message.attachments) return false;
  if (prev.message.sequence !== next.message.sequence) return false;
  if (prev.chatId !== next.chatId) return false;
  if (prev.delegationFollowUps !== next.delegationFollowUps) return false;
  return true;
});
