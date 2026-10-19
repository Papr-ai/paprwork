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
 * Upload a cover straight to cloud storage (memory ticket → GCS → commit; stays private).
 * Deliberately skips the app's own database: a cover is catalog metadata, not app data,
 * and a damaged app DB (e.g. keyless app_files copies) must never block sharing it.
 */
export const uploadCoverToAppFiles: CoverUploader = async ({ appId, filePath, fileName, mime }) => {
  const { stat } = await import("fs/promises");
  const { hashFile, uploadResumable } = await import("../services/appFiles/resumableUploader.js");
  const { requestUploadTicket, commitUpload } = await import("../services/appFiles/appFilesClient.js");
  const { buildCdnUrl } = await import("../services/appFiles/cloudFileUrl.js");
  const sizeBytes = (await stat(filePath)).size;
  const sha256 = await hashFile(filePath);
  const ticket = await requestUploadTicket({ appId, sha256, sizeBytes, fileName, mime, scope: "app" });
  if (!ticket.already_exists) {
    if (!ticket.upload_url) throw new Error("Cover upload: server returned no upload URL");
    await uploadResumable({ sessionUrl: ticket.upload_url, filePath, totalBytes: sizeBytes });
    const commit = await commitUpload(appId, ticket.object_key, sizeBytes);
    if (!commit.verified) throw new Error("Cover upload: cloud storage could not verify the file");
  }
  // Stored as a reference. The bucket stays private; catalog + app pages resolve it per viewer
  // under the app's own sharing rules, so there is no public-flip step to fail.
  return { id: ticket.object_key, objectKey: ticket.object_key, url: buildCdnUrl(ticket.object_key) };
};

/**
 * Push the shared cover to the catalog record (Mongo, via memory) right away, the same
 * way a headline edit does, so Community / Team cards don't wait for the next publish.
 */
export function syncCoverToCatalog(appId: string): void {
  void (async () => {
    const { getCloudAppPublishService } = await import("../services/CloudAppPublishService.js");
    const publish = getCloudAppPublishService();
    if ((await publish.getCloudPublishStatus(appId)).published) {
      await publish.updateCatalogMetadata(appId, { preserveCloudSharing: true });
    }
  })().catch((err) => console.warn(`[appCovers] catalog cover sync failed for ${appId.slice(0, 8)}…`, err));
}

const MEDIA_SEG = /^[A-Za-z0-9_-]{1,64}$/;

export function registerAppCoverRoutes(app: Express): void {
  /**
   * Catalog cover / gallery media, fetched AS the signed-in user. memory.papr.ai gates media
   * by the app's own access, so for apps that require sign-in a bare <video src> (no key)
   * gets 404 and Discover shows nothing. The desktop asks with the user's key and hands the
   * player the short-lived signed link.
   */
  app.get("/api/cloud/catalog-media/:ns/:slug/:index", async (req, res) => {
    const { ns = "", slug = "", index = "" } = req.params;
    if (!MEDIA_SEG.test(ns) || !MEDIA_SEG.test(slug) || !/^\d{1,3}$/.test(index)) {
      res.status(400).end();
      return;
    }
    try {
      const { getMemoryServerBaseUrl } = await import("../utils/cloudApiClient.js");
      const { getPaprApiKey } = await import("../utils/keyResolver.js");
      const key = await getPaprApiKey();
      const q = req.query.poster === "1" ? "?poster=1" : "";
      const r = await fetch(`${getMemoryServerBaseUrl()}/v1/cloud/apps/media/${ns}/${slug}/${index}${q}`, {
        headers: key ? { "X-API-Key": key } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const to = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && to) {
        // Signed links live ~minutes; let the player re-ask rather than cache a dead one.
        res.setHeader("Cache-Control", "private, max-age=300");
        res.redirect(302, to);
        return;
      }
      res.status(r.status === 200 ? 502 : r.status).end();
    } catch {
      res.status(502).end();
    }
  });

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
      const appId = req.params.appId ?? "";
      const result = await sharePrivateCover(appId, uploadCoverToAppFiles);
      if (result.shared) syncCoverToCatalog(appId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
  app.delete("/api/apps/:appId/cover/share", (req, res) => {
    const appId = req.params.appId ?? "";
    const removed = removeSharedCover(appId);
    if (removed) syncCoverToCatalog(appId);
    res.json({ removed });
  });
}
