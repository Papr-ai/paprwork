/**
 * enable_app_agent_chat — bind a sub-agent to a mini-app for embedded chat.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  buildAppAgentChatContext,
  DEFAULT_APP_AGENT_CHAT_TOOL_IDS,
  type AppAgentChatConfig,
} from "../types/appAgentChat.js";

const PAPR_AGENT_CHAT_SDK_SCRIPT =
  '<script type="module" src="/__papr__/papr-agent-chat.js"></script>';

const enableAppAgentChatSchema = z.object({
  appId: z.string().uuid().describe("Mini-app UUID from create_app / list_apps"),
  subAgentId: z
    .string()
    .min(1)
    .describe(
      "Exact sub-agent id from create_sub_agent or list_sub_agents. Create the profile first with app-appropriate tools.",
    ),
  enabled: z.boolean().default(true),
  welcomeMessage: z
    .string()
    .optional()
    .describe('Shown when user opens chat, e.g. "How can I help with this app?"'),
  bubbleLabel: z
    .string()
    .optional()
    .describe("Short label on the floating bubble (defaults to sub-agent name)"),
  systemContext: z
    .string()
    .optional()
    .describe(
      "Extra instructions for every embedded session (domain rules, which files/DB tables to touch)",
    ),
  allowedToolIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      `Tool allowlist for this app's assistant. Default: ${DEFAULT_APP_AGENT_CHAT_TOOL_IDS.join(", ")}`,
    ),
  bubblePosition: z
    .enum(["bottom-right", "bottom-left"])
    .default("bottom-right"),
  injectSdk: z
    .boolean()
    .default(true)
    .describe("Append papr-agent-chat SDK script to index.html if missing"),
});

type EnableAppAgentChatArgs = z.infer<typeof enableAppAgentChatSchema>;

async function injectAgentChatSdk(appId: string): Promise<{
  injected: boolean;
  message: string;
}> {
  const { getAppService } = await import("../../gateway/services/AppService.js");
  const appService = getAppService();
  await appService.initialize();

  const html = await appService.readAppFile(appId, "index.html");
  if (!html) {
    return {
      injected: false,
      message: "index.html not found — add the SDK script manually to your HTML.",
    };
  }
  if (html.includes("papr-agent-chat")) {
    return { injected: false, message: "SDK script already present in index.html." };
  }

  const closingBody = html.lastIndexOf("</body>");
  const updated =
    closingBody >= 0
      ? `${html.slice(0, closingBody)}  ${PAPR_AGENT_CHAT_SDK_SCRIPT}\n${html.slice(closingBody)}`
      : `${html}\n${PAPR_AGENT_CHAT_SDK_SCRIPT}\n`;

  const result = await appService.updateAppFile(appId, "index.html", () => updated);
  if (!result?.written) {
    return {
      injected: false,
      message: result ? "index.html unchanged." : "Failed to update index.html.",
    };
  }
  return { injected: true, message: "Added papr-agent-chat SDK to index.html." };
}

export const enableAppAgentChatTool = createTool({
  id: "enable_app_agent_chat",
  description:
    "Enable embedded sub-agent chat for any mini-app (path 3 — end-user in-app assistant). " +
    "Users get a floating bubble; desktop opens a multi-turn session via /api/app-agent/sessions (NOT delegate_task). " +
    "REQUIRES create_sub_agent first with app-appropriate tools (read_app_file, edit_app_file, read_app_data_sources; add bash for sqlite/API if needed). " +
    "Do NOT test this feature with delegate_task in Pen chat — open the app bubble instead.",
  inputSchema: enableAppAgentChatSchema,
  execute: async (input) => {
    const startTime = performance.now();
    const args = (input as { context?: EnableAppAgentChatArgs }).context ?? input;

    const { getAppService } = await import("../../gateway/services/AppService.js");
    const { getSubAgentService } =
      await import("../../gateway/services/SubAgentService.js");

    const appService = getAppService();
    const subAgentService = getSubAgentService();
    await appService.initialize();
    await subAgentService.initialize();

    const app = await appService.getApp(args.appId);
    if (!app) {
      throw new Error(JSON.stringify({ success: false, error: `App not found: ${args.appId}` }));
    }

    const subAgent = await subAgentService.getAgent(args.subAgentId);
    if (!subAgent) {
      throw new Error(
        JSON.stringify({
          success: false,
          error:
            `Sub-agent not found: ${args.subAgentId}. Call create_sub_agent first, then pass the exact id.`,
        }),
      );
    }

    const agentChat: AppAgentChatConfig = {
      enabled: args.enabled,
      subAgentId: args.subAgentId,
      ...(args.welcomeMessage ? { welcomeMessage: args.welcomeMessage } : {}),
      ...(args.bubbleLabel ? { bubbleLabel: args.bubbleLabel } : {}),
      ...(args.systemContext ? { systemContext: args.systemContext } : {}),
      ...(args.allowedToolIds?.length
        ? { allowedToolIds: args.allowedToolIds }
        : { allowedToolIds: [...DEFAULT_APP_AGENT_CHAT_TOOL_IDS] }),
      bubblePosition: args.bubblePosition,
      enabledAt: new Date().toISOString(),
    };

    if (args.enabled) {
      const { getJobsService } = await import("../../gateway/services/JobsService.js");
      const jobsService = getJobsService();
      await jobsService.initialize();
      const jobName = `App Agent Chat: ${app.title}`;
      const existing = (await jobsService.listJobs()).find(
        (job) => job.name === jobName && job.type === "subagent",
      );
      if (existing) {
        agentChat.cloudJobId = existing.id;
        await jobsService.updateJob(existing.id, {
          appIds: [args.appId],
          command:
            "Embedded app assistant turn. Full conversation prompt is passed via runtime params.prompt.",
        });
      } else {
        const cloudJob = await jobsService.createJob({
          name: jobName,
          type: "subagent",
          subAgentId: args.subAgentId,
          appIds: [args.appId],
          command:
            "Embedded app assistant turn. Full conversation prompt is passed via runtime params.prompt.",
          maxTurns: 20,
        });
        agentChat.cloudJobId = cloudJob.id;
      }
    }

    const updated = await appService.setAppAgentChat(args.appId, agentChat);
    if (!updated) {
      throw new Error(JSON.stringify({ success: false, error: "Failed to update app" }));
    }

    let sdkInjection = { injected: false, message: "SDK injection skipped." };
    if (args.enabled && args.injectSdk) {
      sdkInjection = await injectAgentChatSdk(args.appId);
    }

    const sampleContext = buildAppAgentChatContext(app.id, app.title, agentChat);

    return {
      success: true,
      data: {
        appId: args.appId,
        appTitle: app.title,
        agentChat,
        subAgentName: subAgent.name,
        sdkInjection,
      },
      duration: performance.now() - startTime,
      timestamp: new Date().toISOString(),
      _appAgentChatReminder:
        `✓ App agent chat ${args.enabled ? "enabled" : "disabled"} for "${app.title}". ` +
        `Sub-agent: ${subAgent.name} (${subAgent.id}). ` +
        `${sdkInjection.message} ` +
        `Desktop: bubble calls chat.open → Paprwork sub-agent panel. ` +
        `Web: floating bubble with live SSE chat via /api/app-agent/*. ` +
        `Cloud job id: ${agentChat.cloudJobId ?? "pending"}. ` +
        `Ensure sub-agent allowedToolIds include app tools. Recommended: ${DEFAULT_APP_AGENT_CHAT_TOOL_IDS.join(", ")}. ` +
        `Publish with publish_cloud_app when ready.`,
      _sampleContext: sampleContext,
    };
  },
});

export const appAgentChatTools = [enableAppAgentChatTool];
