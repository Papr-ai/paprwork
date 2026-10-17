/**
 * Cloud Agent Gateway — shared Node service running full AgentService stack.
 *
 * Deploy to Cloud Run. Memory server invokes POST /internal/agent/run.
 *
 * Env:
 *   PAPR_CLOUD_AGENT_GATEWAY_KEY — shared secret with memory server
 *   PAPR_MEMORY_SERVER_URL — default https://memory.papr.ai
 *   GATEWAY_MODE=cloud_agent
 *   CLOUD_SYNC_ENABLED=false
 */

import dotenv from "dotenv";
import { resolve } from "path";
import express, { type NextFunction, type Request, type Response } from "express";
import { getCloudAgentGatewayService } from "./services/cloudAgentGateway/CloudAgentGatewayService.js";
import { handleCloudAgentAppRepoCommitted } from "./services/cloudAgentGateway/handleAppRepoCommitted.js";
import { resolveCloudAgentRunId } from "./services/cloudAgentGateway/cloudAgentRunId.js";
import { startSandboxLocalApi } from "./services/cloudAgentGateway/sandboxLocalApi.js";
import type { CloudAgentRunRequest } from "./services/cloudAgentGateway/types.js";
import {
  parseAppRepoCommittedPayload,
} from "./services/syncV3/appRepoCommittedInbound.js";
import { captureServiceSecrets, getServiceSecret } from "../core/utils/serviceSecrets.js";

// `.env.local` before `.env`: dotenv never overwrites an already-set
// variable, so the first file to define a key wins. Both are gitignored, so
// in Cloud Run neither exists and these calls no-op.
dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config({ path: resolve(process.cwd(), ".env") });

process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";
process.env.CLOUD_SYNC_ENABLED = process.env.CLOUD_SYNC_ENABLED ?? "false";

const PORT = Number(process.env.PORT ?? process.env.CLOUD_AGENT_GATEWAY_PORT ?? 8788);
// Read once, then removed from process.env so agent bash/jobs never inherit it.
captureServiceSecrets();
const GATEWAY_KEY = getServiceSecret("PAPR_CLOUD_AGENT_GATEWAY_KEY") ?? "";

function requireGatewayAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!GATEWAY_KEY) {
    res.status(503).json({ error: "PAPR_CLOUD_AGENT_GATEWAY_KEY not configured" });
    return;
  }
  const provided = req.header("X-Cloud-Agent-Gateway-Key");
  if (provided !== GATEWAY_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

/** App-scoped runs (memory sends workspaceScope=app for jobs linked to a mini-app) clone the
 *  per-app repo via appRepoOwner/appRepoName, so repoCloneUrl is only required for namespace scope. */
function missingRepoField(body: Partial<CloudAgentRunRequest>): string | null {
  if (body.workspaceScope === "app") {
    for (const f of ["appId", "appRepoOwner", "appRepoName"] as const) {
      if (!body[f]) return f;
    }
    return null;
  }
  return body.repoCloneUrl ? null : "repoCloneUrl";
}

function workspaceFields(body: Partial<CloudAgentRunRequest>) {
  return {
    workspaceScope: body.workspaceScope,
    appId: body.appId,
    appRepoOwner: body.appRepoOwner,
    appRepoName: body.appRepoName,
    scaffoldFiles: body.scaffoldFiles,
  };
}

function parseCloudAgentRunRequest(
  body: Partial<CloudAgentRunRequest>,
): CloudAgentRunRequest | { error: string } {
  const required = [
    "orgId",
    "userId",
    "jobId",
    "paprApiKey",
    "repoToken",
    "llmAuth",
  ] as const;

  for (const field of required) {
    if (!body[field]) {
      return { error: `Missing required field: ${field}` };
    }
  }
  const missingRepo = missingRepoField(body);
  if (missingRepo) {
    return { error: `Missing required field: ${missingRepo}` };
  }

  if (!body.llmAuth?.token || !body.llmAuth?.provider || !body.llmAuth?.authType) {
    return { error: "llmAuth must include provider, authType, token" };
  }

  const jobId = body.jobId as string;
  const scheduledDueAt = body.scheduledDueAt?.trim() || undefined;
  const runId = resolveCloudAgentRunId({
    jobId,
    runId: body.runId,
    scheduledDueAt,
  });
  return {
    orgId: body.orgId as string,
    namespaceId: body.namespaceId,
    userId: body.userId as string,
    jobId,
    runId,
    scheduledDueAt,
    provider: body.llmAuth.provider,
    model: body.model,
    runtimeParams: body.runtimeParams,
    prompt: body.prompt,
    paprApiKey: body.paprApiKey as string,
    allowedToolIds: body.allowedToolIds,
    maxTurns: body.maxTurns,
    repoCloneUrl: body.repoCloneUrl,
    ...workspaceFields(body),
    repoToken: body.repoToken as string,
    repoBranch: body.repoBranch,
    linkedSources: body.linkedSources,
    primaryTursoShortName: body.primaryTursoShortName,
    tursoSources: body.tursoSources,
    turso: body.turso,
    llmAuth: body.llmAuth,
    vaultKeys: body.vaultKeys,
    appCodePush: parseAppCodePush(body.appCodePush),
    callerRole: typeof body.callerRole === "string" ? body.callerRole : undefined,
    workspaceSessionId: body.workspaceSessionId,
    keepWorkspaceWarm: body.keepWorkspaceWarm,
  };
}

/**
 * Who may change the live app on this run. Memory decides (from the caller's
 * role); anything missing or unknown means "none" — never default to pushing
 * to main, or a dropped field silently publishes a contributor's edits.
 */
function parseAppCodePush(value: unknown): "main" | "proposal" | "none" {
  return value === "main" || value === "proposal" ? value : "none";
}

function parseCloudAgentSessionBeginRequest(
  body: Partial<CloudAgentRunRequest>,
): CloudAgentRunRequest | { error: string } {
  const required = [
    "orgId",
    "userId",
    "jobId",
    "paprApiKey",
    "repoToken",
    "workspaceSessionId",
  ] as const;

  for (const field of required) {
    if (!body[field]) {
      return { error: `Missing required field: ${field}` };
    }
  }
  const missingRepo = missingRepoField(body);
  if (missingRepo) {
    return { error: `Missing required field: ${missingRepo}` };
  }

  const sessionId = body.workspaceSessionId as string;
  const runId = body.runId ?? sessionId;
  const llmAuth = body.llmAuth ?? {
    provider: body.provider ?? "openai",
    authType: "apiKey" as const,
    token: "unused-for-warm",
  };

  return {
    orgId: body.orgId as string,
    namespaceId: body.namespaceId,
    userId: body.userId as string,
    jobId: body.jobId as string,
    runId,
    provider: llmAuth.provider,
    model: body.model,
    runtimeParams: body.runtimeParams,
    prompt: body.prompt ?? "",
    paprApiKey: body.paprApiKey as string,
    allowedToolIds: body.allowedToolIds,
    maxTurns: body.maxTurns,
    repoCloneUrl: body.repoCloneUrl,
    ...workspaceFields(body),
    repoToken: body.repoToken as string,
    repoBranch: body.repoBranch,
    linkedSources: body.linkedSources,
    primaryTursoShortName: body.primaryTursoShortName,
    tursoSources: body.tursoSources,
    turso: body.turso,
    llmAuth,
    vaultKeys: body.vaultKeys,
    appCodePush: parseAppCodePush(body.appCodePush),
    callerRole: typeof body.callerRole === "string" ? body.callerRole : undefined,
    workspaceSessionId: sessionId,
    keepWorkspaceWarm: true,
  };
}

async function main(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, mode: process.env.GATEWAY_MODE });
  });

  app.post("/internal/agent/run", requireGatewayAuth, async (req, res) => {
    const parsed = parseCloudAgentRunRequest(req.body as Partial<CloudAgentRunRequest>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const service = getCloudAgentGatewayService();
    const result = await service.runAgentJob(parsed);
    res.json(result);
  });

  app.post("/internal/agent/stream", requireGatewayAuth, async (req, res) => {
    const parsed = parseCloudAgentRunRequest(req.body as Partial<CloudAgentRunRequest>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const service = getCloudAgentGatewayService();
    try {
      for await (const event of service.streamAgentJobEvents(parsed)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      res.write(
        `data: ${JSON.stringify({ type: "error", message: (error as Error).message })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ type: "done", exitCode: 1 })}\n\n`);
    }
    res.end();
  });

  app.post("/internal/agent/session/begin", requireGatewayAuth, async (req, res) => {
    const parsed = parseCloudAgentSessionBeginRequest(
      req.body as Partial<CloudAgentRunRequest>,
    );
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const service = getCloudAgentGatewayService();
    try {
      const result = await service.beginAgentSession(parsed);
      res.status(result.status === "ready" ? 200 : 202).json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  app.delete("/internal/agent/session/:sessionId", requireGatewayAuth, async (req, res) => {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
    if (!sessionId) {
      res.status(400).json({ error: "sessionId required" });
      return;
    }
    const service = getCloudAgentGatewayService();
    await service.endAgentSession(sessionId);
    res.json({ ok: true, sessionId });
  });

  app.post("/internal/app-repo-committed", requireGatewayAuth, async (req, res) => {
    const event = parseAppRepoCommittedPayload(req.body);
    if (!event) {
      res.status(400).json({ error: "Invalid app-repo-committed payload" });
      return;
    }
    const result = await handleCloudAgentAppRepoCommitted(event);
    res.json({ ok: true, ...result });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[CloudAgentGateway] Listening on :${PORT}`);
  });
  // Loopback copy of the desktop app API so `curl localhost:18789/api/app/backend/*`
  // and /api/db/* behave the same in cloud runs as on desktop.
  startSandboxLocalApi();
}

main().catch((error) => {
  console.error("[CloudAgentGateway] Fatal:", error);
  process.exit(1);
});
