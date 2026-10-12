/**
 * Publish completion record (memory PR #219).
 *
 * Registering a publish (POST /v1/cloud/apps/publish) happens before the code
 * and database reach the cloud. With `trackCompletion: true` the memory server
 * keeps a first publish out of the catalogs until we report, here, the commit
 * and schema that actually landed. Installs then use that commit, not
 * whatever HEAD happens to be mid-upload.
 *
 * Best effort: a failure is logged and retried on the next publish/flush; it
 * never fails the publish itself.
 */

import { cloudApiFetch } from "../../utils/cloudApiClient.js";

export interface PublishCompletionResult {
  recorded: boolean;
  commit?: string;
  reason?: string;
}

export async function markPublishComplete(
  appId: string,
  paprDir?: string,
): Promise<PublishCompletionResult> {
  try {
    const { webReady } = await import("./webReady.js");
    const ready = await webReady(appId, paprDir);
    if (!ready.ready) {
      return { recorded: false, reason: `not web-ready: ${ready.reason ?? "unknown"}` };
    }

    const { fetchAppRepoHead } = await import("../syncV3/AppOpsClient.js");
    const head = await fetchAppRepoHead(appId, { seedOidCache: false });
    const commit = head.commitSha?.trim();
    if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) {
      return { recorded: false, reason: "no writer commit" };
    }

    const { appliedSchemaHeadsForApp } = await import("./publishSchemaSnapshots.js");
    const dbSchema = await appliedSchemaHeadsForApp(appId).catch(() => ({}));

    const response = await cloudApiFetch(
      `/v1/cloud/apps/publish/${encodeURIComponent(appId)}/complete`,
      { method: "POST", timeoutMs: 20_000, body: { commit, dbSchema } },
    );
    if (!response.ok) {
      // 404: not published, or a memory server without the endpoint yet.
      const text = (await response.text()).slice(0, 160);
      console.warn(
        `[PublishCompletion] ${appId}: complete returned ${response.status} ${text}`,
      );
      return { recorded: false, reason: `HTTP ${response.status}` };
    }
    console.log(`[PublishCompletion] ${appId}: recorded ${commit.slice(0, 8)}`);
    return { recorded: true, commit };
  } catch (error) {
    const reason = (error as Error).message.slice(0, 160);
    console.warn(`[PublishCompletion] ${appId}: ${reason}`);
    return { recorded: false, reason };
  }
}
