/** HTTP routes for app covers (see services/appCovers.ts for the privacy model). */
import type { Express } from "express";
import { listCoveredAppIds,
  coverStatus,
  isValidCoverAppId,
  removeSharedCover,
  resolveCover,
  sharePrivateCover,
  sniffImageType,
  type CoverUploader,
} from "../services/appCovers.js";

/**
 * Store the cover through the same App Files path mini-apps use (POST /api/files/upload),
 * then make it CDN-readable so Community/Team cards can load it without signing in.
 */
export const uploadCoverToAppFiles: CoverUploader = async ({ appId, filePath, fileName, mime }) => {
  const port = process.env.GATEWAY_PORT ?? "18789";
  const base = (process.env.PAPR_GATEWAY_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const res = await fetch(`${base}/api/files/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, filePath, fileName, mime, scope: "app", keepLocal: true }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; objectKey?: string; error?: string };
  if (!res.ok || !body.id || !body.objectKey) {
    throw new Error(body.error ?? `App Files upload failed (${res.status})`);
  }
  const { setVisibility } = await import("../services/appFiles/appFilesClient.js");
  const { buildCdnUrl } = await import("../services/appFiles/cloudFileUrl.js");
  const vis = await setVisibility(appId, body.objectKey, true).catch(() => null);
  return { id: body.id, objectKey: body.objectKey, url: vis?.cdn_url ?? buildCdnUrl(body.objectKey) };
};

export function registerAppCoverRoutes(app: Express): void {
  /** Which apps have a cover — one call for the whole library (cards skip the rest). */
  app.get("/api/apps/covers", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.json({ appIds: listCoveredAppIds() });
  });

  app.get("/api/apps/:appId/cover", (req, res) => {
    const found = resolveCover(req.params.appId ?? "");
    if (!found) {
      res.status(404).end();
      return;
    }
    if (found.redirect) {
      res.setHeader("X-Papr-Cover-Slot", found.slot);
      res.redirect(302, found.redirect);
      return;
    }
    const buf = found.body!;
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

  /** Legacy upload — automatic screenshot covers for library cards are disabled. */
  app.post("/api/apps/:appId/cover", (_req, res) => {
    res.json({ saved: false, reason: "cover_screenshots_disabled" });
  });

  /** Legacy retake — use preview video in App info instead of screenshot covers. */
  app.post("/api/apps/:appId/cover/retake", (req, res) => {
    const appId = req.params.appId ?? "";
    if (!isValidCoverAppId(appId)) {
      res.status(400).json({ error: "invalid appId" });
      return;
    }
    res.json({ saved: false, reason: "cover_screenshots_disabled" });
  });

  /** Owner approval: share (or stop sharing) the current private cover. */
  app.post("/api/apps/:appId/cover/share", async (req, res) => {
    try {
      res.json(await sharePrivateCover(req.params.appId ?? "", uploadCoverToAppFiles));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
  app.delete("/api/apps/:appId/cover/share", (req, res) => {
    res.json({ removed: removeSharedCover(req.params.appId ?? "") });
  });
}
