/**
 * Phase 2.4 — app-repo-committed fanout with cursor-based dedup.
 *
 * Delivery paths (first match wins, all may run in dev):
 * 1. In-process subscribers (desktop gateway revision notify)
 * 2. Optional webhook: PAPR_APP_REPO_COMMITTED_WEBHOOK_URL
 * 3. Optional GCP Pub/Sub topic: PAPR_APP_REPO_COMMITTED_TOPIC (HTTP publish at deploy)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export type AppRepoCommittedEvent = {
  appId: string;
  commitSha: string;
  githubOrg: string;
  repoName: string;
  namespaceId: string;
  committedAt: string;
};

export type AppRepoCommittedHandler = (
  event: AppRepoCommittedEvent,
) => void | Promise<void>;

const subscribers = new Set<AppRepoCommittedHandler>();
const seenCommitKeys = new Set<string>();
const MAX_SEEN = 10_000;

function eventKey(event: AppRepoCommittedEvent): string {
  return `${event.appId}:${event.commitSha}`;
}

function rememberEvent(event: AppRepoCommittedEvent): boolean {
  const key = eventKey(event);
  if (seenCommitKeys.has(key)) {
    return false;
  }
  seenCommitKeys.add(key);
  if (seenCommitKeys.size > MAX_SEEN) {
    const first = seenCommitKeys.values().next().value;
    if (first) {
      seenCommitKeys.delete(first);
    }
  }
  return true;
}

export function subscribeAppRepoCommitted(
  handler: AppRepoCommittedHandler,
): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

function resolveAppRepoCommittedWebhookHeaders(): Record<string, string> | null {
  const url = process.env.PAPR_APP_REPO_COMMITTED_WEBHOOK_URL?.trim();
  if (!url) {
    return null;
  }
  const hostKey = process.env.PAPR_CLOUD_APP_HOST_KEY?.trim();
  if (!hostKey) {
    console.warn(
      "[AppRepoFanout] PAPR_APP_REPO_COMMITTED_WEBHOOK_URL set but PAPR_CLOUD_APP_HOST_KEY missing — skipping webhook",
    );
    return null;
  }
  return {
    "Content-Type": "application/json",
    "X-Cloud-App-Host-Key": hostKey,
  };
}

async function postWebhook(event: AppRepoCommittedEvent): Promise<void> {
  const url = process.env.PAPR_APP_REPO_COMMITTED_WEBHOOK_URL?.trim();
  const headers = resolveAppRepoCommittedWebhookHeaders();
  if (!url || !headers) {
    return;
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    });
    if (!resp.ok) {
      console.warn(
        `[AppRepoFanout] Webhook ${url} returned ${resp.status} for appId=${event.appId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[AppRepoFanout] Webhook failed for appId=${event.appId}:`,
      (err as Error).message.slice(0, 120),
    );
  }
}

/** Fan out to subscribers + optional webhook. Dedupes by appId+commitSha. */
export async function fanoutAppRepoCommitted(
  event: AppRepoCommittedEvent,
): Promise<void> {
  if (!rememberEvent(event)) {
    return;
  }

  for (const handler of subscribers) {
    try {
      await handler(event);
    } catch (err) {
      console.warn(
        `[AppRepoFanout] Subscriber error appId=${event.appId}:`,
        (err as Error).message.slice(0, 120),
      );
    }
  }

  await postWebhook(event);
}

export interface AppRepoCommitCursorStore {
  lastCommitSha: string;
  updatedAt: string;
}

function cursorPath(): string {
  const paprHome = process.env.PAPR_HOME ?? path.join(process.env.HOME ?? "", "Papr");
  return path.join(paprHome, "data", "app-repo-commit-cursors.json");
}

export async function readAppRepoCommitCursors(): Promise<
  Record<string, AppRepoCommitCursorStore>
> {
  try {
    const raw = await fs.readFile(cursorPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, AppRepoCommitCursorStore>;
    }
  } catch {
    /* missing file */
  }
  return {};
}

export async function writeAppRepoCommitCursor(
  appId: string,
  commitSha: string,
): Promise<void> {
  const file = cursorPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const all = await readAppRepoCommitCursors();
  all[appId] = {
    lastCommitSha: commitSha,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(all, null, 2), "utf8");
}

export async function removeAppRepoCommitCursor(
  appId: string,
  paprHome?: string,
): Promise<boolean> {
  const trimmed = appId.trim();
  if (!trimmed) {
    return false;
  }
  const file = paprHome
    ? path.join(paprHome, "data", "app-repo-commit-cursors.json")
    : cursorPath();
  let all: Record<string, AppRepoCommitCursorStore>;
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    all = parsed as Record<string, AppRepoCommitCursorStore>;
  } catch {
    return false;
  }
  if (!all[trimmed]) {
    return false;
  }
  delete all[trimmed];
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(all, null, 2), "utf8");
  return true;
}

export async function clearAppRepoCommitCursorsForTests(): Promise<void> {
  try {
    await fs.unlink(cursorPath());
  } catch {
    /* ignore */
  }
  seenCommitKeys.clear();
}
