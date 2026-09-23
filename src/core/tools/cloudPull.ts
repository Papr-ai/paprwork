/**
 * Agent tools for bringing app code DOWN — the inbound half of the publish bar.
 *
 * The agent could already send work out (push_cloud_sync, submit_cloud_app_pr)
 * but had no way to pull it in: the chip's "Get updates" and "Update from
 * publisher" called gateway endpoints no tool reached. That left a real hazard —
 * asked to "propose my changes" on a fork behind its publisher, the agent would
 * open a PR against stale code. These mirror the two chip actions exactly.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getCloudAppTrackSyncService } from "../../gateway/services/CloudAppTrackSyncService.js";
import { getCloudSyncService } from "../../gateway/services/cloudSync/cloudSyncSingleton.js";
import { pullAppFromCloud } from "../../gateway/services/syncV3/pullAppFromCloud.js";
import { checkPublisherUpstreamRevision } from "../../gateway/services/syncV3/checkPublisherUpstreamRevision.js";

function unwrapContext<T>(input: T | { context?: T }): T {
  if (input && typeof input === "object" && "context" in input) {
    return (input as { context?: T }).context ?? (input as T);
  }
  return input as T;
}

function toolError(error: unknown, startTime: number): never {
  throw new Error(
    JSON.stringify({
      success: false,
      error: (error as Error).message,
      duration: performance.now() - startTime,
      timestamp: new Date().toISOString(),
    }),
  );
}

const appIdSchema = z.object({
  appId: z.string().uuid().describe("Local mini-app ID"),
});

export const pullCloudAppUpdatesTool = createTool({
  id: "pull_cloud_app_updates",
  description: `Pull this app's own web copy down to local — same as "Get updates" on the status chip.

Use when get_cloud_sync_status shows the web copy is ahead (gitUpdatesAvailable, chip "Updates on web"), e.g. edited on another device or on apps.papr.ai.
Not for forks pulling from their publisher — use pull_publisher_updates for that.
Not for database rows only — use papr_db_pull.

Web wins on files that differ (same as the UI). Returns updatedFiles, conflictFiles, skipped/reason.
**If conflictFiles is non-empty, STOP and tell the user which files need a decision — do not retry, publish, or edit those files blindly.**
If the status shows gitRemoteRequiresReview or writerConflict, do not call this — the user must review in the app tab first.`,
  inputSchema: appIdSchema,
  execute: async (input) => {
    const { appId } = unwrapContext(input);
    const startTime = performance.now();
    try {
      const sync = getCloudSyncService();
      const token = sync ? await sync.ensureFreshToken() : null;
      const result = await pullAppFromCloud(appId, {
        token,
        waitForTurso: true,
        allowRecentSkip: false,
        preferCloudOverLocal: true,
      });
      return {
        success: true,
        data: {
          appId,
          commitSha: result.code.commitSha,
          updatedFiles: result.code.updatedFiles,
          conflictFiles: result.code.conflictFiles,
          skipped: result.code.skipped ?? false,
          reason: result.code.reason ?? null,
          registryMigrationsApplied: result.registryMigrationsApplied ?? [],
          needsUserDecision: result.code.conflictFiles.length > 0,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

const publisherSchema = z.object({
  appId: z.string().uuid().describe("Local installed app ID (the fork/track copy)"),
  checkOnly: z
    .boolean()
    .optional()
    .describe("Only report whether the publisher has a newer revision; do not pull. Default false."),
});

export const pullPublisherUpdatesTool = createTool({
  id: "pull_publisher_updates",
  description: `Pull the publisher's latest version into an installed copy — same as "Update from publisher" on the status chip.

**Call with checkOnly: true before submit_cloud_app_pr.** If publisherUpdatesAvailable, pull first so the proposal is based on the publisher's current code, not a stale snapshot.

Only works for apps installed in track mode (install_cloud_app mode: "track"). A mode: "fork" copy returns supported: false — tell the user rather than working around it.

Local edits are kept on conflict. Returns updatedFiles, conflictFiles, skippedFiles.
**If conflictFiles is non-empty, STOP and tell the user which files conflict — do not submit a PR or publish until they decide.**`,
  inputSchema: publisherSchema,
  execute: async (input) => {
    const { appId, checkOnly } = unwrapContext(input);
    const startTime = performance.now();
    try {
      const status = await checkPublisherUpstreamRevision(appId);
      if (checkOnly || !status.publisherUpdatesAvailable) {
        return {
          success: true,
          data: {
            appId,
            pulled: false,
            publisherUpdatesAvailable: status.publisherUpdatesAvailable,
            liveRevision: status.liveRevision,
            storedUpstreamRevision: status.storedUpstreamRevision,
            reason: status.reason,
          },
          duration: performance.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }
      let result;
      try {
        result = await getCloudAppTrackSyncService().syncTrackApp(appId);
      } catch (err) {
        const message = (err as Error).message;
        if (/not in track mode/i.test(message)) {
          return {
            success: true,
            data: {
              appId,
              pulled: false,
              supported: false,
              publisherUpdatesAvailable: true,
              reason:
                "This copy was installed as a fork, which has no pull-from-publisher path yet. Tell the user; do not copy files over by hand.",
            },
            duration: performance.now() - startTime,
            timestamp: new Date().toISOString(),
          };
        }
        throw err;
      }
      return {
        success: true,
        data: {
          appId,
          pulled: true,
          upstreamRevision: result.upstreamRevision ?? status.liveRevision,
          updatedFiles: result.updatedFiles,
          conflictFiles: result.conflictFiles,
          skippedFiles: result.skippedFiles,
          needsUserDecision: result.conflictFiles.length > 0,
        },
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      toolError(error, startTime);
    }
  },
});

export const cloudPullTools = [pullCloudAppUpdatesTool, pullPublisherUpdatesTool];
