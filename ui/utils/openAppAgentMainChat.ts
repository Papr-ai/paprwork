/**
 * Desktop: open embedded app-agent bubble in main Pen chat (not the overlay modal).
 */

export interface AppAgentMainChatContext {
  appId: string;
  appTitle: string;
  subAgentId: string;
  subAgentName: string;
  userMessage?: string;
  welcomeMessage?: string;
}

export function appAgentMainChatTabTitle(
  appTitle: string,
  subAgentName: string,
): string {
  const combined = `${appTitle} — ${subAgentName}`;
  return combined.length > 40 ? `${combined.slice(0, 37)}…` : combined;
}

/** Message Pen receives when the user sends a request from the app bubble. */
export function buildAppAgentMainChatMessage(
  input: AppAgentMainChatContext,
): string {
  const parts = [
    `I'm working in the mini-app "${input.appTitle}" (appId: ${input.appId}).`,
    `It has an embedded assistant sub-agent "${input.subAgentName}" (useAgentId: "${input.subAgentId}").`,
    `For work inside this app (editing app files, linked databases, in-app UX), delegate via delegate_task with useAgentId "${input.subAgentId}" and mention appId ${input.appId} in context.`,
  ];

  if (input.welcomeMessage?.trim()) {
    parts.push(
      `Embedded assistant intro (for your context): ${input.welcomeMessage.trim()}`,
    );
  }

  if (input.userMessage?.trim()) {
    parts.push(`My request: ${input.userMessage.trim()}`);
  }

  return parts.join("\n\n");
}

export function findAppTabId(
  tabs: ReadonlyArray<{ id: string; type: string; entityId: string }>,
  appId: string,
): string | null {
  const tab = tabs.find((entry) => entry.type === "app" && entry.entityId === appId);
  return tab?.id ?? null;
}
