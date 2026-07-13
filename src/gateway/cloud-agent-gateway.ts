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
import {
  getCloudAgentGatewayService,
  newCloudAgentRunId,
} from "./services/cloudAgentGateway/CloudAgentGatewayService.js";
import type { CloudAgentRunRequest } from "./services/cloudAgentGateway/types.js";

dotenv.config({ path: resolve(process.cwd(), ".env.local") });

process.env.GATEWAY_MODE = process.env.GATEWAY_MODE ?? "cloud_agent";
process.env.CLOUD_SYNC_ENABLED = process.env.CLOUD_SYNC_ENABLED ?? "false";

const PORT = Number(process.env.PORT ?? process.env.CLOUD_AGENT_GATEWAY_PORT ?? 8788);
const GATEWAY_KEY = process.env.PAPR_CLOUD_AGENT_GATEWAY_KEY ?? "";

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

function parseCloudAgentRunRequest(
  body: Partial<CloudAgentRunRequest>,
): CloudAgentRunRequest | { error: string } {
  const required = [
    "orgId",
    "userId",
    "jobId",
    "prompt",
    "paprApiKey",
    "repoCloneUrl",
    "repoToken",
    "llmAuth",
  ] as const;

  for (const field of required) {
    if (!body[field]) {
      return { error: `Missing required field: ${field}` };
    }
  }

  if (!body.llmAuth?.token || !body.llmAuth?.provider || !body.llmAuth?.authType) {
    return { error: "llmAuth must include provider, authType, token" };
  }

  const runId = body.runId ?? newCloudAgentRunId();
  return {
    orgId: body.orgId as string,
    namespaceId: body.namespaceId,
    userId: body.userId as string,
    jobId: body.jobId as string,
    runId,
    provider: body.llmAuth.provider,
    model: body.model,
    prompt: body.prompt as string,
    paprApiKey: body.paprApiKey as string,
    allowedToolIds: body.allowedToolIds,
    maxTurns: body.maxTurns,
    repoCloneUrl: body.repoCloneUrl as string,
    repoToken: body.repoToken as string,
    repoBranch: body.repoBranch,
    linkedSources: body.linkedSources,
    primaryTursoShortName: body.primaryTursoShortName,
    tursoSources: body.tursoSources,
    turso: body.turso,
    llmAuth: body.llmAuth,
    vaultKeys: body.vaultKeys,
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[CloudAgentGateway] Listening on :${PORT}`);
  });
}

main().catch((error) => {
  console.error("[CloudAgentGateway] Fatal:", error);
  process.exit(1);
});
