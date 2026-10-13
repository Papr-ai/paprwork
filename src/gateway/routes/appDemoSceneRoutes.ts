/**
 * App preview videos (see services/appDemoVideos.ts).
 * The scene is written by the Papr agent (AgentService — Paprwork's model, auth and
 * fallbacks) and recorded to MP4 by Electron.
 */
import * as fs from "fs";
import type { Express } from "express";
import {
  DEMO_SCENE_SYSTEM,
  demoPaths,
  demoStatus,
  isValidDemoAppId,
  listDemoAppIds,
  markRecording,
  shareDemoVideo,
  sharedCoverKind,
  startDemoGeneration,
  type DemoDeps,
} from "../services/appDemoVideos.js";

const deps: DemoDeps = {
  async writeScene(appId, prompt) {
    const { getAgentService } = await import("../services/AgentService.js");
    const result = await getAgentService().runStructuredJobSession({
      jobId: `app-demo-${appId}`,
      runId: String(Date.now()),
      prompt: `${DEMO_SCENE_SYSTEM}\n\n---\n\n${prompt}`,
      schemaName: "demo_scene",
      schemaDescription: "A self-contained HTML document for the app's animated preview loop.",
      outputSchema: {
        type: "object",
        properties: { html: { type: "string", description: "Full HTML file starting with <!doctype html>" } },
        required: ["html"],
        additionalProperties: false,
      },
    });
    const html = (result.object as { html?: unknown })?.html;
    if (typeof html !== "string") throw new Error("The model returned no scene.");
    return html;
  },
  async render(paths) {
    markRecording(paths.scenePath.split(/[\\/]/).pop()!.split(".")[0]!);
    const { requestAppDemoRender } = await import("../utils/appDemoRenderBridge.js");
    return requestAppDemoRender(paths);
  },
};

export function registerAppDemoSceneRoutes(app: Express): void {
  /** Which apps have a preview video — one call for the whole library. */
  app.get("/api/apps/demos", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.json({ appIds: listDemoAppIds() });
  });

  app.get("/api/apps/:appId/demo", (req, res) => {
    const appId = req.params.appId ?? "";
    if (!isValidDemoAppId(appId)) {
      res.status(400).json({ error: "invalid appId" });
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.json({ ...demoStatus(appId), sharedKind: sharedCoverKind(appId) });
  });

  /** Owner approval: the preview video becomes the shared cover (Community / Team cards). */
  app.post("/api/apps/:appId/demo/share", async (req, res) => {
    try {
      const { uploadCoverToAppFiles } = await import("./appCoverRoutes.js");
      res.json(await shareDemoVideo(req.params.appId ?? "", uploadCoverToAppFiles));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const sendDemoFile = (kind: "video" | "poster", type: string) => (req: { params: { appId?: string } }, res: import("express").Response) => {
    const appId = req.params.appId ?? "";
    const file = isValidDemoAppId(appId) ? demoPaths(appId)[kind] : "";
    if (!file || !fs.existsSync(file)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file); // supports Range for <video>
  };
  app.get("/api/apps/:appId/demo/video", sendDemoFile("video", "video/mp4"));
  app.get("/api/apps/:appId/demo/poster", sendDemoFile("poster", "image/jpeg"));

  /** Start making (or remaking) the preview. Returns at once; poll GET /demo for progress. */
  app.post("/api/apps/:appId/demo/generate", (req, res) => {
    const appId = req.params.appId ?? "";
    if (!isValidDemoAppId(appId)) {
      res.status(400).json({ error: "invalid appId" });
      return;
    }
    try {
      startDemoGeneration(appId, deps);
      res.status(202).json(demoStatus(appId));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
