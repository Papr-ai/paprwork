/**
 * REST + SSE routes for embedded app-agent chat (desktop gateway + cloud app host).
 */

import type { Express, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { AppAgentChatConfig } from "../../../core/types/appAgentChat.js";
import { toPublicAppAgentChatConfig } from "../../../core/types/appAgentChat.js";
import type { AppRuntimeRouteAuth } from "../appRuntime/types.js";
import { fetchRuntimeRepoFile } from "../appRuntime/memoryRuntimeClient.js";
import { parseCloudAppMetadataFile } from "../../../core/utils/cloudAppMetadata.js";
import type { AppAgentChatSessionStore } from "./AppAgentChatSessionStore.js";
import { AppAgentChatRunService } from "./AppAgentChatRunService.js";
import { AppAgentChatCloudRunner } from "./AppAgentChatCloudRunner.js";
import {
  getAppAgentChatTurnHub,
  streamTurnEvents,
} from "./AppAgentChatTurnHub.js";
import { getAppAgentChatWarmCoordinator } from "./AppAgentChatWarmCoordinator.js";
import { warmRuntimeAppAgentChat } from "../appRuntime/memoryRuntimeClient.js";
import type { AppAgentWarmResponse } from "../../../core/types/appAgentChat.js";

export type AppAgentChatRouteMode = "desktop" | "cloud";

export interface AppAgentChatRouteDeps {
  mode: AppAgentChatRouteMode;
  sessionStore: AppAgentChatSessionStore;
  /** Desktop: load MiniApp from AppService. Cloud: null (use metadata). */
  getDesktopApp?: (
    appId: string,
  ) => Promise<{ id: string; title: string; agentChat?: AppAgentChatConfig } | null>;
  buildRuntimeAuth?: (req: Request) => AppRuntimeRouteAuth | null;
  jobRunRequiresSignIn?: (auth: AppRuntimeRouteAuth) => boolean;
  respondJobRunSignInRequired?: (req: Request, res: Response) => void;
}

async function loadCloudAgentChatConfig(
  runtimeAuth: AppRuntimeRouteAuth,
  appId: string,
): Promise<{
  agentChat: AppAgentChatConfig | null;
  cloudJobId?: string;
  appTitle: string;
}> {
  const file = await fetchRuntimeRepoFile(runtimeAuth, "metadata.json");
  if (!file?.content) {
    return { agentChat: null, appTitle: appId.slice(0, 8) };
  }
  const metadata = parseCloudAppMetadataFile(file.content);
  if (!metadata || metadata.appId !== appId) {
    return { agentChat: null, appTitle: appId.slice(0, 8) };
  }
  if (!metadata.agentChat?.enabled) {
    return { agentChat: null, appTitle: metadata.title };
  }
  const agentChat: AppAgentChatConfig = {
    enabled: true,
    subAgentId: metadata.agentChat.subAgentId,
    ...(metadata.agentChat.bubbleLabel
      ? { bubbleLabel: metadata.agentChat.bubbleLabel }
      : {}),
    ...(metadata.agentChat.welcomeMessage
      ? { welcomeMessage: metadata.agentChat.welcomeMessage }
      : {}),
    ...(metadata.agentChat.bubblePosition
      ? { bubblePosition: metadata.agentChat.bubblePosition }
      : {}),
  };
  return {
    agentChat,
    cloudJobId: metadata.agentChatJobId,
    appTitle: metadata.title,
  };
}

export function registerAppAgentChatRoutes(
  app: Express,
  deps: AppAgentChatRouteDeps,
): void {
  const turnHub = getAppAgentChatTurnHub();
  const desktopRunner = new AppAgentChatRunService(deps.sessionStore);
  const cloudRunner = new AppAgentChatCloudRunner(deps.sessionStore);
  const warmCoordinator = getAppAgentChatWarmCoordinator();

  function warmResponse(
    sessionId: string,
    snapshot: ReturnType<typeof warmCoordinator.getSnapshot>,
  ): AppAgentWarmResponse {
    return {
      status: snapshot.status,
      sessionId,
      ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt } : {}),
      ...(snapshot.message ? { message: snapshot.message } : {}),
    };
  }

  app.post("/api/app-agent/sessions/:sessionId/warm", async (req, res) => {
    try {
      const sessionId = req.params.sessionId;
      const session = await deps.sessionStore.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      if (deps.mode === "desktop") {
        warmCoordinator.markReady(sessionId);
        res.json(warmResponse(sessionId, warmCoordinator.getSnapshot(sessionId)));
        return;
      }

      if (!deps.buildRuntimeAuth) {
        res.status(500).json({ error: "Cloud runtime auth unavailable" });
        return;
      }

      const runtimeAuth = deps.buildRuntimeAuth(req);
      if (!runtimeAuth) {
        res.status(403).json({ error: "Forbidden — open the app in this browser tab first" });
        return;
      }
      if (deps.jobRunRequiresSignIn?.(runtimeAuth)) {
        deps.respondJobRunSignInRequired?.(req, res);
        return;
      }

      const cloudConfig = await loadCloudAgentChatConfig(runtimeAuth, session.appId);
      if (!cloudConfig.agentChat) {
        res.status(404).json({ error: "App agent chat is not enabled for this app" });
        return;
      }
      if (!cloudConfig.cloudJobId) {
        res.status(400).json({
          error:
            "Cloud app assistant job is not configured. Republish after enable_app_agent_chat.",
        });
        return;
      }

      const prior = warmCoordinator.getSnapshot(sessionId);
      if (prior.status === "ready") {
        res.json(warmResponse(sessionId, prior));
        return;
      }

      const status = await warmCoordinator.ensureWarm(sessionId, async () => {
        return warmRuntimeAppAgentChat(runtimeAuth, {
          sessionId,
          appId: session.appId,
          subAgentId: session.subAgentId,
          jobId: cloudConfig.cloudJobId as string,
        });
      });

      const snapshot = warmCoordinator.getSnapshot(sessionId);
      if (status === "unavailable") {
        res.status(202).json(warmResponse(sessionId, snapshot));
        return;
      }
      res.status(status === "ready" ? 200 : 202).json(warmResponse(sessionId, snapshot));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/app-agent/sessions/:sessionId/warm", async (req, res) => {
    try {
      const sessionId = req.params.sessionId;
      const session = await deps.sessionStore.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json(warmResponse(sessionId, warmCoordinator.getSnapshot(sessionId)));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/app-agent/sessions", async (req, res) => {
    try {
      const body = req.body as { appId?: string };
      if (!body.appId) {
        res.status(400).json({ error: "appId is required" });
        return;
      }

      let subAgentId: string | undefined;
      if (deps.mode === "desktop" && deps.getDesktopApp) {
        const miniApp = await deps.getDesktopApp(body.appId);
        if (!miniApp?.agentChat?.enabled) {
          res.status(404).json({ error: "App agent chat is not enabled for this app" });
          return;
        }
        subAgentId = miniApp.agentChat.subAgentId;
      } else if (deps.mode === "cloud" && deps.buildRuntimeAuth) {
        const runtimeAuth = deps.buildRuntimeAuth(req);
        if (!runtimeAuth) {
          res.status(403).json({ error: "Forbidden — open the app in this browser tab first" });
          return;
        }
        const cloudConfig = await loadCloudAgentChatConfig(runtimeAuth, body.appId);
        if (!cloudConfig.agentChat) {
          res.status(404).json({ error: "App agent chat is not enabled for this app" });
          return;
        }
        subAgentId = cloudConfig.agentChat.subAgentId;
      }

      if (!subAgentId) {
        res.status(500).json({ error: "App agent chat configuration unavailable" });
        return;
      }

      const session = await deps.sessionStore.createSession({
        appId: body.appId,
        subAgentId,
      });
      res.json({ sessionId: session.id, appId: session.appId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/app-agent/sessions/:sessionId", async (req, res) => {
    try {
      const session = await deps.sessionStore.getSession(req.params.sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json({
        sessionId: session.id,
        appId: session.appId,
        messages: session.messages,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/app-agent/sessions/:sessionId/messages", async (req, res) => {
    try {
      const sessionId = req.params.sessionId;
      const body = req.body as { message?: string };
      const message = body.message?.trim();
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const session = await deps.sessionStore.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      if (deps.mode === "cloud" && deps.buildRuntimeAuth) {
        const runtimeAuth = deps.buildRuntimeAuth(req);
        if (!runtimeAuth) {
          res.status(403).json({ error: "Forbidden — open the app in this browser tab first" });
          return;
        }
        if (deps.jobRunRequiresSignIn?.(runtimeAuth)) {
          deps.respondJobRunSignInRequired?.(req, res);
          return;
        }
      }

      const turnId = uuidv4();
      turnHub.createTurn(turnId);

      void (async () => {
        const onEvent = (event: import("../../../core/types/appAgentChat.js").AppAgentChatSseEvent) => {
          turnHub.publish(turnId, event);
        };
        try {
          if (deps.mode === "desktop" && deps.getDesktopApp) {
            const miniApp = await deps.getDesktopApp(session.appId);
            if (!miniApp?.agentChat?.enabled) {
              onEvent({
                type: "app-agent:error",
                data: { turnId, error: "App agent chat is not enabled" },
              });
              return;
            }
            await desktopRunner.streamTurn({
              session,
              userMessage: message,
              agentChat: miniApp.agentChat,
              onEvent,
            });
          } else if (deps.mode === "cloud" && deps.buildRuntimeAuth) {
            const runtimeAuth = deps.buildRuntimeAuth(req);
            if (!runtimeAuth) {
              onEvent({
                type: "app-agent:error",
                data: { turnId, error: "Forbidden — open the app in this browser tab first" },
              });
              return;
            }
            const cloudConfig = await loadCloudAgentChatConfig(runtimeAuth, session.appId);
            if (!cloudConfig.agentChat) {
              onEvent({
                type: "app-agent:error",
                data: { turnId, error: "App agent chat is not enabled" },
              });
              return;
            }
            if (!cloudConfig.cloudJobId) {
              onEvent({
                type: "app-agent:error",
                data: {
                  turnId,
                  error:
                    "Cloud app assistant job is not configured. Republish the app after enable_app_agent_chat.",
                },
              });
              return;
            }
            await cloudRunner.streamTurn({
              runtimeAuth,
              session,
              userMessage: message,
              cloudJobId: cloudConfig.cloudJobId,
              onEvent,
            });
          }
        } catch (err) {
          onEvent({
            type: "app-agent:error",
            data: { turnId, error: (err as Error).message },
          });
        }
      })();

      res.json({ turnId, sessionId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/app-agent/sessions/:sessionId/stream", (req, res) => {
    const turnId = req.query.turnId;
    if (typeof turnId !== "string" || turnId.length === 0) {
      res.status(400).json({ error: "turnId query param is required" });
      return;
    }

    const cleanup = streamTurnEvents(res, turnId, turnHub);
    req.on("close", cleanup);
  });

  if (deps.mode === "cloud") {
    app.get("/api/apps/:appId/agent-chat", async (req, res) => {
      try {
        const appId = req.params.appId;
        if (!appId || !deps.buildRuntimeAuth) {
          res.status(400).json({ error: "appId required" });
          return;
        }
        const runtimeAuth = deps.buildRuntimeAuth(req);
        if (!runtimeAuth) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        const cloudConfig = await loadCloudAgentChatConfig(runtimeAuth, appId);
        res.json({
          appId,
          agentChat: cloudConfig.agentChat
            ? toPublicAppAgentChatConfig(cloudConfig.agentChat)
            : null,
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }
}
