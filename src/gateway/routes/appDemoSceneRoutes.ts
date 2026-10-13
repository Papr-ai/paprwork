/**
 * App demo scenes: generation is handed to the Papr agent (AgentService) so the model,
 * auth (OAuth / API key / Papr proxy) and fallbacks match the rest of Paprwork.
 * See services/appDemoScenes.ts.
 */
import type { Express } from "express";
import {
  DEMO_SCENE_SYSTEM,
  buildDemoScenePrompt,
  hasDemoScene,
  isValidDemoAppId,
  listDemoAppIds,
  readDemoScene,
  saveDemoScene,
} from "../services/appDemoScenes.js";

export function registerAppDemoSceneRoutes(app: Express): void {
  /** Which apps have a preview loop — one call for the whole library. */
  app.get("/api/apps/demos", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.json({ appIds: listDemoAppIds() });
  });

  app.get("/api/apps/:appId/demo-scene/status", (req, res) => {
    res.json({ exists: hasDemoScene(req.params.appId ?? "") });
  });

  /** The scene HTML. ?play=1 adds the looping player (for iframes). */
  app.get("/api/apps/:appId/demo-scene", (req, res) => {
    const html = readDemoScene(req.params.appId ?? "", req.query.play === "1", req.query.fit === "cover");
    if (!html) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.send(html);
  });

  /** Generate (or regenerate). Body is optional: { feedback?, provider?, model? }. */
  app.post("/api/apps/:appId/demo-scene/generate", async (req, res) => {
    const appId = req.params.appId ?? "";
    if (!isValidDemoAppId(appId)) {
      res.status(400).json({ error: "invalid appId" });
      return;
    }
    const body = (req.body ?? {}) as { system?: unknown; prompt?: unknown; feedback?: unknown; provider?: unknown; model?: unknown };
    try {
      const system = typeof body.system === "string" ? body.system : DEMO_SCENE_SYSTEM;
      let user = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : buildDemoScenePrompt(appId);
      if (typeof body.feedback === "string" && body.feedback.trim()) {
        user += `\n\nYOUR PREVIOUS ATTEMPT HAD PROBLEMS — fix them:\n${body.feedback}`;
      }
      const { getAgentService } = await import("../services/AgentService.js");
      const result = await getAgentService().runStructuredJobSession({
        jobId: `demo-scene-${appId}`,
        runId: String(Date.now()),
        prompt: `${system}\n\n---\n\n${user}`,
        schemaName: "demo_scene",
        schemaDescription: "A self-contained HTML document for the app's animated preview loop.",
        outputSchema: {
          type: "object",
          properties: { html: { type: "string", description: "Full HTML file starting with <!doctype html>" } },
          required: ["html"],
          additionalProperties: false,
        },
        ...(typeof body.provider === "string" ? { provider: body.provider as never } : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
      });
      const raw = (result.object as { html?: unknown })?.html;
      if (typeof raw !== "string" || !/<html|<!doctype/i.test(raw)) {
        res.status(502).json({ error: "The model returned no scene." });
        return;
      }
      const html = saveDemoScene(appId, raw);
      res.json({ saved: true, html });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
