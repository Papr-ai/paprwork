/**
 * Sequence model for published app-agent chat (matches desktop MessageItem / useAgent).
 */

import { getSdkToolDisplayLabel } from "./papr-agent-chat-tool-display.js";

export interface SdkSequenceTool {
  toolCallId?: string;
  name: string;
  args?: Record<string, unknown>;
  status: "calling" | "success" | "error" | "stopped";
  result?: unknown;
}

export type SdkSequenceItem =
  | { type: "text"; data: string }
  | { type: "tool"; data: SdkSequenceTool }
  | { type: "thinking"; data: string };

export interface SdkTurnActivity {
  sequence: SdkSequenceItem[];
  thinking: string;
  thinkingStreaming: boolean;
  textSegment: string;
  plans: import("./papr-agent-chat-plan.js").PlanData[];
  startedAt: number;
  statusMessage?: string;
  isFinishingWork?: boolean;
  wasStopped?: boolean;
}

export function createSdkTurnActivity(): SdkTurnActivity {
  return {
    sequence: [],
    thinking: "",
    thinkingStreaming: false,
    textSegment: "",
    plans: [],
    startedAt: Date.now(),
  };
}

export function flushTextSegment(activity: SdkTurnActivity): void {
  const trimmed = activity.textSegment.trim();
  if (!trimmed) {
    activity.textSegment = "";
    return;
  }
  activity.sequence.push({ type: "text", data: activity.textSegment });
  activity.textSegment = "";
}

export function getLastToolIndex(sequence: SdkSequenceItem[]): number {
  for (let i = sequence.length - 1; i >= 0; i -= 1) {
    if (sequence[i]?.type === "tool") return i;
  }
  return -1;
}

export function getFinalTextAfterTools(activity: SdkTurnActivity): string {
  const lastToolIndex = getLastToolIndex(activity.sequence);
  if (lastToolIndex < 0) {
    return activity.textSegment;
  }
  const trailingParts: string[] = [];
  for (let i = lastToolIndex + 1; i < activity.sequence.length; i += 1) {
    const item = activity.sequence[i];
    if (item?.type === "text" && item.data.trim()) {
      trailingParts.push(item.data);
    }
  }
  if (activity.textSegment.trim()) {
    trailingParts.push(activity.textSegment);
  }
  return trailingParts.join("");
}

export function getWorkingNarrationText(item: SdkSequenceItem): string | null {
  if (item.type !== "text") return null;
  return item.data.trim() ? item.data : null;
}

export function computeSdkLastActivity(activity: SdkTurnActivity): string {
  if (activity.statusMessage && activity.sequence.length === 0 && !activity.thinking.trim()) {
    return activity.statusMessage;
  }

  const lastToolIndex = getLastToolIndex(activity.sequence);
  for (let i = activity.sequence.length - 1; i >= 0; i -= 1) {
    const item = activity.sequence[i];
    if (item?.type === "tool") {
      return getSdkToolDisplayLabel({
        toolName: item.data.name,
        args: item.data.args,
        status: item.data.status === "calling" ? "calling" : item.data.status,
      });
    }
    if (item?.type === "text" && item.data.trim()) {
      if (i > lastToolIndex) continue;
      const text = item.data.trim();
      return text.length > 50 ? `${text.slice(0, 50)}…` : text;
    }
  }

  if (activity.thinking.trim()) {
    const text = activity.thinking.trim();
    return text.length > 50 ? `${text.slice(0, 50)}…` : text;
  }

  return activity.statusMessage ?? "Working";
}

export function isSdkExploring(activity: SdkTurnActivity, sending: boolean): boolean {
  if (sending) return true;
  if (activity.thinkingStreaming) return true;
  return activity.sequence.some(
    (item) => item.type === "tool" && item.data.status === "calling",
  );
}

export function finalizeSdkTurnActivity(activity: SdkTurnActivity): void {
  flushTextSegment(activity);
  if (activity.thinking.trim()) {
    activity.sequence.unshift({ type: "thinking", data: activity.thinking });
  }
  activity.thinkingStreaming = false;
}

export const SDK_THINKING_PHRASES = [
  "Thinking…",
  "Pondering…",
  "Contemplating…",
  "Mulling it over…",
  "Processing…",
  "Analyzing…",
  "Reasoning…",
  "Working on it…",
];

export function pickThinkingPhrase(): string {
  return SDK_THINKING_PHRASES[Math.floor(Math.random() * SDK_THINKING_PHRASES.length)] ?? "Thinking…";
}

export function thinkingPreview(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const lastLine = (lines[lines.length - 1] ?? "").trim();
  if (lastLine.length <= 60) return lastLine;
  return `${lastLine.slice(0, 57)}…`;
}
