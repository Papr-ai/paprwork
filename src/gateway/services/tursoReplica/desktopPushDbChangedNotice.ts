/**
 * After a desktop replica push lands on the cloud primary, tell the memory
 * server so (1) open apps.papr.ai tabs get jobs:db-changed SSE and (2) other
 * desktops see a sync-index bump on their next heartbeat.
 *
 * Before this, the only push-side notice was notifyCloudDbChanged, which needs
 * PAPR_CLOUD_APP_HOST_KEY — a server secret desktops never have — so web
 * onDbChanged never fired for desktop writes.
 *
 * Trailing debounce per database: a burst of writes sends one notice.
 */

const DEBOUNCE_MS = 1_500;
const timers = new Map<string, NodeJS.Timeout>();

export interface DesktopPushNoticeTarget {
  dbId?: string;
  jobId?: string;
  tursoShortName: string;
}

export type SendDesktopPushNotice = (target: DesktopPushNoticeTarget) => Promise<void>;

async function defaultSend(target: DesktopPushNoticeTarget): Promise<void> {
  const { cloudApiFetch } = await import("../../utils/cloudApiClient.js");
  const res = await cloudApiFetch("/v1/cloud/runtime/turso-db-changed", {
    method: "POST",
    timeoutMs: 15_000,
    body: {
      ...(target.dbId ? { dbId: target.dbId } : {}),
      ...(target.jobId ? { jobId: target.jobId } : {}),
      tursoShortName: target.tursoShortName,
      source: "desktop_push",
    },
  });
  if (!res.ok) {
    throw new Error(`turso-db-changed ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
}

export function noticeDesktopPushDbChanged(
  target: DesktopPushNoticeTarget,
  send: SendDesktopPushNotice = defaultSend,
  debounceMs = DEBOUNCE_MS,
): void {
  if (!target.dbId && !target.jobId) {
    return;
  }
  const key = target.tursoShortName;
  const pending = timers.get(key);
  if (pending) {
    clearTimeout(pending);
  }
  const timer = setTimeout(() => {
    timers.delete(key);
    send(target).catch((error) => {
      console.warn(
        `[TursoReplica] db-changed notice for ${key} failed:`,
        (error as Error).message.slice(0, 120),
      );
    });
  }, debounceMs);
  timer.unref?.();
  timers.set(key, timer);
}
