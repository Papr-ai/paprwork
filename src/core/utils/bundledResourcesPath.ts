/**
 * Resolve bundled resource directories (default-apps, default-jobs) in dev and
 * packaged Electron builds. ASAR archives cannot be listed or recursively copied
 * via fs.readdir/fs.cp on parent dirs — unpack via electron-builder asarUnpack
 * and fall back to app.asar.unpacked when needed.
 */

import { access, readdir } from "fs/promises";
import path from "path";

async function isReadableResourceDir(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath);
    await readdir(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param gatewayServicesDir - Typically `dist/gateway/services` (__dirname of AppService)
 * @param resourcesSubpath - e.g. `resources/default-apps`
 */
export async function resolveBundledResourcesDir(
  gatewayServicesDir: string,
  resourcesSubpath: string,
): Promise<string | null> {
  const insideAsar = path.resolve(gatewayServicesDir, "..", "..", resourcesSubpath);
  const candidates = [
    insideAsar,
    insideAsar.replace("app.asar", "app.asar.unpacked"),
  ];

  for (const candidate of candidates) {
    if (await isReadableResourceDir(candidate)) {
      return candidate;
    }
  }

  return null;
}
