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
  startDemoRevision,
  type DemoDeps,
} from "../services/appDemoVideos.js";
import { REVIEW_SCHEMA } from "../services/appDemoQuality.js";
import { SCREENS_SCHEMA, composeItem } from "../services/appDemoScreens.js";
import {
  addNote,
  deleteNote,
  markSeen,
  readManifest,
  screenPath,
  setCurrentVersion,
  updateScreen,
  versionTake,
} from "../services/appDemoStore.js";
import { exportGallery } from "../services/appDemoExport.js";

const deps: DemoDeps = {
  async writeScene(appId, prompt, images) {
    const { getAgentService } = await import("../services/AgentService.js");
    const result = await getAgentService().runStructuredJobSession({
      jobId: `app-demo-${appId}`,
      runId: String(Date.now()),
      prompt: `${DEMO_SCENE_SYSTEM}\n\n---\n\n${prompt}`,
      ...(images?.length ? { images } : {}),
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
  async stills(scenePath, stills) {
    const { requestAppDemoRender } = await import("../utils/appDemoRenderBridge.js");
    // video/poster paths are unused in stills mode but must sit in the demos folder.
    const base = scenePath.replace(/\.html$/, "");
    const r = await requestAppDemoRender({ scenePath, videoPath: `${base}.mp4`, posterPath: `${base}.jpg`, stills });
    return r.stills ?? [];
  },
  async composeScreens(items) {
    const { requestAppDemoRender } = await import("../utils/appDemoRenderBridge.js");
    // video/poster paths are unused in compose mode but must sit in the demos folder.
    const base = items[0]!.path.replace(/\.jpg$/, "");
    await requestAppDemoRender({ scenePath: `${base}.html`, videoPath: `${base}.mp4`, posterPath: `${base}.poster.jpg`, compose: items });
  },
  async review(prompt, images) {
    const { getAgentService } = await import("../services/AgentService.js");
    const result = await getAgentService().runStructuredJobSession({
      jobId: "app-demo-review",
      runId: String(Date.now()),
      prompt,
      images,
      schemaName: "demo_review",
      schemaDescription: "QA review of an app preview video's frames.",
      outputSchema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
    });
    return result.object;
  },
  async pickScreens(prompt, images) {
    const { getAgentService } = await import("../services/AgentService.js");
    const result = await getAgentService().runStructuredJobSession({
      jobId: "app-demo-screens",
      runId: String(Date.now()),
      prompt,
      images,
      schemaName: "gallery_screens",
      schemaDescription: "Five moments of an app preview: one component each, with a headline and a supporting line.",
      outputSchema: SCREENS_SCHEMA as unknown as Record<string, unknown>,
    });
    return result.object;
  },
};

const ownAppId = (req: { params: { appId?: string } }, res: import("express").Response): string | null => {
  const appId = req.params.appId ?? "";
  if (isValidDemoAppId(appId)) return appId;
  res.status(400).json({ error: "invalid appId" });
  return null;
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
      const { uploadCoverToAppFiles, syncCoverToCatalog } = await import("./appCoverRoutes.js");
      const appId = req.params.appId ?? "";
      const result = await shareDemoVideo(appId, uploadCoverToAppFiles);
      if (result.shared) syncCoverToCatalog(appId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const sendDemoFile = (kind: "video" | "poster", type: string) => (req: { params: { appId?: string }; query: Record<string, unknown> }, res: import("express").Response) => {
    const appId = req.params.appId ?? "";
    // ?ver=N plays one saved version; no ?ver is the version in use.
    const ver = Number(req.query.ver);
    const take = Number.isInteger(ver) && ver > 0 ? versionTake(ver) : "";
    const file = isValidDemoAppId(appId) ? demoPaths(appId, take)[kind] : "";
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

  /** One gallery screen of the version in use (?ver=N for another). k is 1-based. */
  app.get("/api/apps/:appId/demo/screens/:k", (req, res) => {
    const appId = req.params.appId ?? "";
    const k = Number(req.params.k);
    if (!isValidDemoAppId(appId) || !Number.isInteger(k) || k < 1) {
      res.status(400).end();
      return;
    }
    const ver = Number(req.query.ver);
    const v = Number.isInteger(ver) && ver > 0 ? ver : readManifest(appId).current;
    const file = screenPath(appId, v, k);
    if (!fs.existsSync(file)) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(file);
  });

  /** Edit a screen's caption, or leave it out / put it back. */
  app.patch("/api/apps/:appId/demo/screens/:k", async (req, res) => {
    const appId = ownAppId(req, res);
    if (!appId) return;
    try {
      const k = Number(req.params.k);
      const body = (req.body ?? {}) as { caption?: unknown; sub?: unknown; hidden?: unknown };
      const m = updateScreen(appId, k, body);
      // Scene-style screens carry the words in the image: lay it out again.
      const screen = m.versions.find((x) => x.v === m.current)?.screens?.[k - 1];
      if (screen?.style === "scene" && (body.caption !== undefined || body.sub !== undefined)) {
        await deps.composeScreens!([composeItem(appId, m.current, k, screen)]);
      }
      res.json(demoStatus(appId));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** The owner opened the Gallery: the bar's "Review gallery" goes away. */
  app.post("/api/apps/:appId/demo/seen", (req, res) => {
    const appId = ownAppId(req, res);
    if (!appId) return;
    markSeen(appId);
    res.json(demoStatus(appId));
  });

  /** Copy the video and the kept screens to ~/Downloads/<App> gallery. */
  app.post("/api/apps/:appId/demo/download", (req, res) => {
    const appId = ownAppId(req, res);
    if (!appId) return;
    try {
      res.json(exportGallery(appId));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** Notes: a moment (t), optional spot (x, y in 0..1), and what should change. Owner only, private. */
  app.post("/api/apps/:appId/demo/notes", (req, res) => {
    const appId = ownAppId(req, res);
    if (!appId) return;
    try {
      res.json({ note: addNote(appId, req.body ?? {}), ...readManifest(appId) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/apps/:appId/demo/notes/:noteId", (req, res) => {
    const appId = ownAppId(req, res);
    if (!appId) return;
    const ok = deleteNote(appId, req.params.noteId ?? "");
    res.status(ok ? 200 : 404).json(readManifest(appId));
  });

  /** One run fixes every open note and makes the next version. Poll GET /demo. */
  app.post("/api/apps/:appId/demo/revise", (req, res) => {
    const appId = ownAppId(req, res);
    if (!appId) return;
    try {
      startDemoRevision(appId, deps);
      res.status(202).json(demoStatus(appId));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** Use a saved version as the preview (cards). Sharing still goes through App info → Save. */
  app.post("/api/apps/:appId/demo/current", (req, res) => {
    const appId = ownAppId(req, res);
    if (!appId) return;
    try {
      setCurrentVersion(appId, Number((req.body as { version?: unknown })?.version));
      res.json(demoStatus(appId));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

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
