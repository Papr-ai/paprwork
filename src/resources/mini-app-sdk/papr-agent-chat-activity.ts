/**
 * DOM rendering for Thinking + Working cards (desktop parity).
 */

import { renderMarkdownToHtml } from "./papr-markdown.js";
import { renderPlanCardHtml, type PlanData } from "./papr-agent-chat-plan.js";
import { getSdkToolDisplayLabel } from "./papr-agent-chat-tool-display.js";
import {
  computeSdkLastActivity,
  getFinalTextAfterTools,
  getLastToolIndex,
  getWorkingNarrationText,
  isSdkExploring,
  thinkingPreview,
  type SdkTurnActivity,
} from "./papr-agent-chat-sequence.js";

export interface RenderTurnActivityOptions {
  live: boolean;
  sendingNow: boolean;
  workingCollapsed: boolean;
  thinkingCollapsed: boolean;
  thinkingPhrase: string;
  elapsedSeconds: number;
  showWorkingShimmer: boolean;
  onToggleWorking: () => void;
  onToggleThinking: () => void;
}

function workingPrimaryLabel(activity: SdkTurnActivity, exploring: boolean): string {
  if (activity.isFinishingWork) return "Finishing work";
  if (exploring) return "Working";
  if (activity.wasStopped) return "Stopped";
  return "Finished Working";
}

function workingSecondaryLabel(
  activity: SdkTurnActivity,
  exploring: boolean,
  collapsed: boolean,
  lastActivity: string,
): string | null {
  if (!collapsed) return null;
  if (activity.isFinishingWork) return "Writing final summary for you";
  return lastActivity;
}

export function renderTurnActivityDom(
  container: HTMLElement,
  activity: SdkTurnActivity,
  options: RenderTurnActivityOptions,
): string {
  const lastToolIndex = getLastToolIndex(activity.sequence);
  const hasTools = activity.sequence.some((item) => item.type === "tool");
  const hasPlans = activity.plans.length > 0;
  const hasThinking =
    activity.thinking.length > 0 ||
    activity.thinkingStreaming ||
    activity.sequence.some((item) => item.type === "thinking");
  const showWaiting =
    options.live &&
    options.sendingNow &&
    !hasThinking &&
    !hasTools &&
    !hasPlans &&
    !activity.textSegment.trim();

  if (!hasThinking && !hasTools && !hasPlans && !showWaiting) {
    return getFinalTextAfterTools(activity);
  }

  const exploring = isSdkExploring(activity, options.live && options.sendingNow);
  const lastActivity = computeSdkLastActivity(activity);

  const activityEl = document.createElement("div");
  activityEl.className = "papr-agent-chat-activity";

  if (hasThinking) {
    const thinkingContent =
      activity.thinking.trim() ||
      activity.sequence.find((item) => item.type === "thinking")?.data ||
      "";
    const preview = thinkingPreview(String(thinkingContent));
    const thinkingEl = document.createElement("div");
    thinkingEl.className = "papr-agent-chat-thinking";

    const headerBtn = document.createElement("button");
    headerBtn.type = "button";
    headerBtn.className = `papr-agent-chat-thinking__header${
      activity.thinkingStreaming ? " papr-agent-chat-thinking__header--streaming" : ""
    }`;
    headerBtn.innerHTML = `
      <span class="papr-agent-chat-thinking__chevron${
        options.thinkingCollapsed ? " papr-agent-chat-thinking__chevron--collapsed" : ""
      }">▼</span>
      <span class="papr-agent-chat-thinking__label">${
        activity.thinkingStreaming
          ? options.thinkingPhrase
          : options.thinkingPhrase.replace("…", "")
      }</span>
      ${
        options.thinkingCollapsed && preview
          ? `<span class="papr-agent-chat-thinking__preview">${preview}</span>`
          : ""
      }
    `;
    headerBtn.addEventListener("click", options.onToggleThinking);

    const bodyEl = document.createElement("div");
    bodyEl.className = "papr-agent-chat-thinking__body";
    bodyEl.style.maxHeight = options.thinkingCollapsed ? "0px" : "200px";
    bodyEl.style.opacity = options.thinkingCollapsed ? "0" : "1";
    bodyEl.textContent = String(thinkingContent);
    if (activity.thinkingStreaming) {
      const cursor = document.createElement("span");
      cursor.className = "papr-agent-chat-thinking__cursor";
      cursor.textContent = "▊";
      bodyEl.appendChild(cursor);
    }

    thinkingEl.appendChild(headerBtn);
    thinkingEl.appendChild(bodyEl);
    activityEl.appendChild(thinkingEl);
  }

  if (hasPlans) {
    for (const plan of activity.plans) {
      const planWrap = document.createElement("div");
      planWrap.innerHTML = renderPlanCardHtml(plan, true);
      const planEl = planWrap.firstElementChild;
      if (planEl) {
        const planHeader = planEl.querySelector(".papr-agent-chat-plan__header");
        planHeader?.addEventListener("click", () => {
          const steps = planEl.querySelector(".papr-agent-chat-plan__steps");
          const chevron = planEl.querySelector(".papr-agent-chat-plan__chevron");
          steps?.classList.toggle("papr-agent-chat-plan__steps--collapsed");
          chevron?.classList.toggle("papr-agent-chat-plan__chevron--collapsed");
        });
        activityEl.appendChild(planEl);
      }
    }
  }

  if (showWaiting || hasTools) {
    const workingEl = document.createElement("div");
    workingEl.className = "papr-agent-chat-working";

    const secondary = workingSecondaryLabel(
      activity,
      exploring,
      options.workingCollapsed,
      lastActivity,
    );
    const primaryClass = options.showWorkingShimmer && exploring
      ? " papr-agent-chat-working__primary--shimmer"
      : "";
    const secondaryClass = options.showWorkingShimmer && exploring && secondary
      ? " papr-agent-chat-working__secondary--shimmer"
      : "";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "papr-agent-chat-working__header";
    header.innerHTML = `
      <span class="papr-agent-chat-working__chevron${
        options.workingCollapsed ? " papr-agent-chat-working__chevron--collapsed" : ""
      }">▼</span>
      <span class="papr-agent-chat-working__labels">
        <span class="papr-agent-chat-working__primary${primaryClass}">${workingPrimaryLabel(activity, exploring)}</span>
        ${
          secondary
            ? `<span class="papr-agent-chat-working__label-secondary${secondaryClass}">${secondary}</span>`
            : ""
        }
      </span>
      ${options.live && options.elapsedSeconds > 0 ? `<span class="papr-agent-chat-working__timer">${options.elapsedSeconds}s</span>` : ""}
    `;
    header.addEventListener("click", options.onToggleWorking);

    const list = document.createElement("div");
    list.className = `papr-agent-chat-working__list${
      options.workingCollapsed ? " papr-agent-chat-working__list--collapsed" : ""
    }`;

    if (showWaiting) {
      const statusRow = document.createElement("div");
      statusRow.className = "papr-agent-chat-tool papr-agent-chat-tool--pending";
      statusRow.textContent = activity.statusMessage ?? "Preparing workspace…";
      list.appendChild(statusRow);
    }

    for (let i = 0; i < activity.sequence.length; i += 1) {
      const item = activity.sequence[i];
      if (!item) continue;

      if (item.type === "text" && i <= lastToolIndex) {
        const narration = getWorkingNarrationText(item);
        if (narration) {
          const narrEl = document.createElement("div");
          narrEl.className = "papr-agent-chat-working__narration";
          narrEl.innerHTML = renderMarkdownToHtml(narration);
          list.appendChild(narrEl);
        }
        continue;
      }

      if (item.type === "tool") {
        const row = document.createElement("div");
        const status =
          item.data.status === "calling"
            ? "pending"
            : item.data.status === "stopped"
              ? "error"
              : item.data.status;
        row.className = `papr-agent-chat-tool papr-agent-chat-tool--${status}`;
        const label = document.createElement("span");
        label.textContent = `→ ${getSdkToolDisplayLabel({
          toolName: item.data.name,
          args: item.data.args,
          status: item.data.status,
        })}`;
        const badge = document.createElement("span");
        badge.className = "papr-agent-chat-tool__status";
        badge.textContent =
          status === "success" ? "✓" : status === "error" ? "✗" : "…";
        row.appendChild(label);
        row.appendChild(badge);
        list.appendChild(row);
      }
    }

    workingEl.appendChild(header);
    if (list.childNodes.length > 0) {
      workingEl.appendChild(list);
    }
    activityEl.appendChild(workingEl);
  }

  container.appendChild(activityEl);
  return getFinalTextAfterTools(activity);
}
