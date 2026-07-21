/**
 * Git commit marker synced to cloud so apps.papr.ai can bust repo-file caches
 * after desktop push without requiring Cmd+Shift+R.
 */

export const CLOUD_REPO_HEAD_RELATIVE_PATH = "data/cloud-repo-head.txt";

export function parseCloudRepoHeadContent(content: string): string {
  const line = content.trim().split("\n")[0]?.trim() ?? "";
  if (/^[0-9a-f]{7,40}$/i.test(line)) {
    return line.toLowerCase();
  }
  return "0";
}
