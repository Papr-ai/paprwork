/**
 * Download all: the preview video and the gallery screens the owner kept, copied to
 * ~/Downloads/<App name> gallery/ (numbered in display order). Sample data only.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getPaprAppsRoot } from "../../core/utils/paprRoot.js";
import { demoPaths, readManifest, screenPath } from "./appDemoStore.js";

function appName(appId: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(getPaprAppsRoot(), appId, "metadata.json"), "utf8")) as { title?: string };
    const clean = (meta.title ?? "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
    return clean || "App";
  } catch {
    return "App";
  }
}

export function exportGallery(appId: string, downloads = path.join(os.homedir(), "Downloads")): { folder: string; files: string[] } {
  const m = readManifest(appId);
  const video = demoPaths(appId).video;
  if (!m.current || !fs.existsSync(video)) throw new Error("Make the gallery first.");
  const folder = path.join(downloads, `${appName(appId)} gallery`);
  fs.mkdirSync(folder, { recursive: true });
  const files = ["0 Preview.mp4"];
  fs.copyFileSync(video, path.join(folder, files[0]!));
  const screens = m.versions.find((x) => x.v === m.current)?.screens ?? [];
  let n = 0;
  screens.forEach((s, i) => {
    const src = screenPath(appId, m.current, i + 1);
    if (s.hidden || !fs.existsSync(src)) return;
    const name = `${++n} ${s.caption.replace(/[\\/:*?"<>|]+/g, " ")}.jpg`;
    fs.copyFileSync(src, path.join(folder, name));
    files.push(name);
  });
  return { folder, files };
}
