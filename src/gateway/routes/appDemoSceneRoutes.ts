/**
 * App demo scenes: hand the generation to the Papr agent (AgentService) so the model,
 * auth (OAuth / API key / Papr proxy) and fallbacks match the rest of Paprwork.
 */
import type { Express } from "express";

export function registerAppDemoSceneRoutes(app: Express): void {
  app.post("/api/apps/:appId/demo-scene/generate", async (req, res) => {
    const body = (req.body ?? {}) as { system?: unknown; prompt?: unknown; provider?: unknown; model?: unknown };
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      res.status(400).json({ error: "prompt required" });
      return;
    }
    try {
      const { getAgentService } = await import("../services/AgentService.js");
      const prompt = typeof body.system === "string" ? `${body.system}\n\n---\n\n${body.prompt}` : body.prompt;
      const result = await getAgentService().runStructuredJobSession({
        jobId: `demo-scene-${req.params.appId}`,
        runId: String(Date.now()),
        prompt,
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
      const html = (result.object as { html?: unknown })?.html;
      if (typeof html !== "string" || !/<html|<!doctype/i.test(html)) {
        res.status(502).json({ error: "model returned no HTML" });
        return;
      }
      res.json({ html });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
