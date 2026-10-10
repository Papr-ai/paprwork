/** HTTP routes for app covers (see services/appCovers.ts for the privacy model). */
import type { Express } from "express";
import {
  coverStatus,
  isValidCoverAppId,
  removeSharedCover,
  resolveCover,
  savePrivateCover,
  sharePrivateCover,
  sniffImageType,
  type CoverSource,
} from "../services/appCovers.js";

export function registerAppCoverRoutes(app: Express): void {
  app.get("/api/apps/:appId/cover", (req, res) => {
    const found = resolveCover(req.params.appId ?? "");
    if (!found) {
      res.status(404).end();
      return;
    }
    const buf = found.body;
    res.setHeader("Content-Type", sniffImageType(buf));
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Papr-Cover-Slot", found.slot);
    res.end(buf);
  });

  app.get("/api/apps/:appId/cover/status", (req, res) => {
    const appId = req.params.appId ?? "";
    if (!isValidCoverAppId(appId)) {
      res.status(400).json({ error: "invalid appId" });
      return;
    }
    res.json(coverStatus(appId));
  });

  /** Private cover from the open app tab (throttled to once a day server-side). */
  app.post("/api/apps/:appId/cover", (req, res) => {
    const body = (req.body ?? {}) as { dataUrl?: unknown; source?: unknown };
    const source: CoverSource = body.source === "validate" ? "validate" : "tab";
    if (typeof body.dataUrl !== "string") {
      res.status(400).json({ error: "dataUrl required" });
      return;
    }
    res.json(savePrivateCover(req.params.appId ?? "", body.dataUrl, source));
  });

  /** Retake: render the app in the hidden preview window and keep that frame. */
  app.post("/api/apps/:appId/cover/retake", async (req, res) => {
    const appId = req.params.appId ?? "";
    if (!isValidCoverAppId(appId)) {
      res.status(400).json({ error: "invalid appId" });
      return;
    }
    try {
      const { runMiniAppRuntimePreview } = await import("../utils/miniAppRuntimePreview.js");
      const preview = await runMiniAppRuntimePreview(appId);
      if (!preview.previewScreenshot) {
        res.json({ saved: false, reason: preview.skippedReason ?? "no_screenshot" });
        return;
      }
      res.json(savePrivateCover(appId, preview.previewScreenshot, "validate"));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Owner approval: share (or stop sharing) the current private cover. */
  app.post("/api/apps/:appId/cover/share", (req, res) => {
    res.json({ shared: sharePrivateCover(req.params.appId ?? "") });
  });
  app.delete("/api/apps/:appId/cover/share", (req, res) => {
    res.json({ removed: removeSharedCover(req.params.appId ?? "") });
  });
}
