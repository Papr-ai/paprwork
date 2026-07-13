import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function cloneUserRepoToPaprHome(input: {
  targetPaprHome: string;
  cloneUrl: string;
  token: string;
  branch?: string;
}): Promise<void> {
  await fs.rm(input.targetPaprHome, { recursive: true, force: true });
  await fs.mkdir(path.dirname(input.targetPaprHome), { recursive: true });

  const url = injectTokenIntoCloneUrl(input.cloneUrl, input.token);
  const branch = input.branch ?? "main";
  await execFileAsync(
    "git",
    ["clone", "--depth", "1", "--branch", branch, url, input.targetPaprHome],
    { timeout: 180_000 },
  );
}

function injectTokenIntoCloneUrl(cloneUrl: string, token: string): string {
  const normalized = cloneUrl.replace(/^https:\/\//, "");
  return `https://x-access-token:${encodeURIComponent(token)}@${normalized}`;
}
