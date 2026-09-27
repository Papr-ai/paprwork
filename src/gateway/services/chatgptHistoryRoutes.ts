import type { Express, Request, Response } from "express";
import { getProviderAuth } from "../utils/keyResolver.js";

const BASE = "https://chatgpt.com/backend-api";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

type JsonRecord = Record<string, any>;

function jwtPayload(token: string): JsonRecord {
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
  } catch {
    throw new Error("The OpenAI OAuth token is not a valid ChatGPT token.");
  }
}

function accountId(token: string): string {
  const payload = jwtPayload(token);
  const auth = payload["https://api.openai.com/auth"] ?? {};
  const id = auth.chatgpt_account_id ?? payload.chatgpt_account_id;
  if (typeof id !== "string" || !id)
    throw new Error("ChatGPT account ID is missing from the OAuth token.");
  return id;
}

async function credential(): Promise<{ token: string; accountId: string }> {
  const auth = await getProviderAuth("openai");
  if (!auth || auth.type !== "oauth")
    throw new Error("Connect ChatGPT in Settings → AI Models first.");
  return { token: auth.token, accountId: accountId(auth.token) };
}

async function chatgpt(path: string): Promise<JsonRecord> {
  const auth = await credential();
  const response = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "chatgpt-account-id": auth.accountId,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      "oai-language": "en-US",
    },
  });
  const raw = await response.text();
  let body: JsonRecord = {};
  try {
    body = JSON.parse(raw);
  } catch {}
  if (!response.ok) {
    const detail =
      body?.detail?.message ??
      body?.detail ??
      body?.error?.message ??
      `ChatGPT returned ${response.status}`;
    const error = new Error(String(detail));
    (error as any).status = response.status;
    throw error;
  }
  return body;
}

function bounded(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.min(Math.max(Math.trunc(n), 0), max)
    : fallback;
}

function fail(res: Response, error: unknown): void {
  const e = error as any;
  const status = e?.status === 401 || e?.status === 403 ? e.status : 502;
  res
    .status(status)
    .json({
      error: e instanceof Error ? e.message : "ChatGPT history request failed.",
    });
}

export function registerChatgptHistoryRoutes(app: Express): void {
  app.get("/api/integrations/chatgpt/projects", async (_req, res) => {
    try {
      const projects: JsonRecord[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({
          conversations_per_gizmo: "0",
          owned_only: "true",
        });
        if (cursor) query.set("cursor", cursor);
        const body = await chatgpt(`/gizmos/snorlax/sidebar?${query}`);
        for (const item of body.items ?? []) {
          const gizmo = item.gizmo?.gizmo ?? {};
          const files = item.gizmo?.files ?? [];
          projects.push({
            id: gizmo.id,
            name: gizmo.display?.name ?? "Untitled project",
            instructions: gizmo.instructions ?? "",
            createdAt: gizmo.created_at ?? null,
            updatedAt: gizmo.updated_at ?? null,
            files: files.map((file: JsonRecord) => ({
              id: file.id ?? file.file_id,
              name: file.name ?? file.file_name ?? "Untitled file",
            })),
          });
        }
        cursor =
          typeof body.cursor === "string" && body.cursor
            ? body.cursor
            : undefined;
      } while (cursor);
      res.json({ projects });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(
    "/api/integrations/chatgpt/conversations",
    async (req: Request, res: Response) => {
      try {
        const limit = bounded(req.query.limit, 50, 100) || 50;
        const projectId =
          typeof req.query.projectId === "string" ? req.query.projectId : "";
        if (projectId) {
          if (!/^g-p-[a-zA-Z0-9_-]+$/.test(projectId)) {
            res.status(400).json({ error: "Invalid project ID." });
            return;
          }
          const cursor =
            typeof req.query.cursor === "string" && req.query.cursor
              ? req.query.cursor
              : "0";
          const body = await chatgpt(
            `/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=${encodeURIComponent(cursor)}`,
          );
          res.json({
            items: body.items ?? [],
            cursor: body.cursor ?? null,
            projectId,
          });
          return;
        }
        const offset = bounded(req.query.offset, 0, 100000);
        const query = new URLSearchParams({
          offset: String(offset),
          limit: String(limit),
        });
        const body = await chatgpt(`/conversations?${query}`);
        res.json({
          items: body.items ?? [],
          total: body.total ?? 0,
          limit: body.limit ?? limit,
          offset: body.offset ?? offset,
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.get(
    "/api/integrations/chatgpt/conversations/:conversationId",
    async (req, res) => {
      try {
        const id = req.params.conversationId;
        if (!/^[a-zA-Z0-9_-]{8,}$/.test(id)) {
          res.status(400).json({ error: "Invalid conversation ID." });
          return;
        }
        const body = await chatgpt(`/conversation/${encodeURIComponent(id)}`);
        res.json(body);
      } catch (error) {
        fail(res, error);
      }
    },
  );
}
