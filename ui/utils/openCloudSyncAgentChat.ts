/** Open main chat with context for cloud git merge / PR review (desktop only). */
export function openCloudSyncAgentChat(message: string): void {
  window.dispatchEvent(
    new CustomEvent("papr-chat-open", {
      detail: { message },
    }),
  );
}

export function buildMergeReviewAgentPrompt(input: {
  appId?: string;
  headline?: string | null;
  error?: string | null;
}): string {
  const parts = [
    "Help me as the app owner review and merge cloud git changes into my Papr workspace.",
  ];
  if (input.appId) {
    parts.push(`App id: ${input.appId}.`);
  }
  if (input.headline?.trim()) {
    parts.push(`Remote summary: ${input.headline.trim()}.`);
  }
  if (input.error?.trim()) {
    parts.push(`Last merge error: ${input.error.trim()}.`);
  }
  parts.push(
    "Use inspect_cloud_repo and get_cloud_sync_status. Summarize what changed, whether I should merge or reject, and resolve conflicts safely if needed.",
  );
  return parts.join(" ");
}

export function buildSchemaDriftAgentPrompt(input: {
  appId?: string;
  databases?: ReadonlyArray<{
    alias: string;
    detail?: string;
    syncMode?: "legacy" | "replica";
    migrationConflict?: boolean;
    cutoverBlocked?: boolean;
    cutoverBlockReason?: string | null;
  }>;
  publishDetail?: string | null;
  error?: string | null;
}): string {
  const parts = [
    "Help me fix Turso database schema drift that is blocking Web sync / Upload for my Papr mini-app.",
    "Local SQLite schema or migration ledger does not match Turso primary — Upload may finish git/code but web-ready stays blocked until schema is aligned.",
  ];
  if (input.appId) {
    parts.push(`App id: ${input.appId}.`);
  }
  if (input.databases?.length) {
    const dbLines = input.databases
      .map((db) => {
        const bits = [db.alias];
        if (db.syncMode === "replica") {
          bits.push("replica");
        } else if (db.syncMode === "legacy") {
          bits.push("legacy");
        }
        if (db.migrationConflict) {
          bits.push("migration conflict");
        }
        if (db.cutoverBlocked) {
          bits.push(
            `cutover blocked${db.cutoverBlockReason?.trim() ? `: ${db.cutoverBlockReason.trim()}` : ""}`,
          );
        } else if (db.detail?.trim()) {
          bits.push(db.detail.trim());
        }
        return bits.join(" — ");
      })
      .join("; ");
    parts.push(`Linked databases: ${dbLines}.`);
  }
  if (input.publishDetail?.trim()) {
    parts.push(`Publish blocker: ${input.publishDetail.trim()}.`);
  }
  if (input.error?.trim()) {
    parts.push(`Last upload error: ${input.error.trim()}.`);
  }
  parts.push(
    "Workflow: get_cloud_sync_status → inspect each linked DB (syncMode legacy vs replica, schemaDrift, migrationConflict, row counts local vs Turso).",
    "CDC terminology: check syncMode first. pendingOps/cdcOperations on syncMode=replica is normal Plan A pending push (including new post-replica apps) — NOT legacy CDC. Legacy CDC = syncMode=legacy or turso_cdc* / _papr_sync_log tables on disk.",
    "Legacy DB + Plan A rollout: cutover runs automatically on Publish changes **or** push_cloud_sync({ appId }) with default targets (github + turso) — same ordered flush (migrations → cutover → replica push → git → publish). Same Turso instance — never delete_database/recreate. Local-only legacy CDC tables (e.g. turso_cdc, turso_sync_last_change_id) are ignored for drift and stripped at cutover.",
    "After cutover (or if already replica): compare migrations/*.sql vs schema_migrations → papr_db_apply_migration for missing migrations (never papr_db_exec DDL or bash/sqlite3 on registry DB files).",
    "Migration conflict: repair_cloud_sync merge_lww first. accept_cloud only when Turso is authoritative (never when local has more rows).",
    "Local has rows but Turso empty/stale (e.g. after cross-namespace copy, mistaken delete/recreate): restore data.db from newest .sync-backup or .pre-replica.bak if needed, strip replica sidecars (-changes/-info/-shm/-wal), then papr_db_apply_migration_cloud + papr_db_push — NOT bootstrap_remote (reseed wipes local if Turso stays empty), NOT force_local, NOT sqlite3 INSERT.",
    "Legacy-only sync (no replica rollout): push_cloud_sync({ appId }) or Publish changes applies local migrations then pushes Turso.",
    "Do NOT use push_cloud_sync targets: ['github'] or targets: ['turso'] alone when cutover or full web upload is needed — use push_cloud_sync({ appId }) (both layers).",
    "Verify web-ready with get_cloud_sync_status.",
  );
  return parts.join(" ");
}

export function buildUploadFailureAgentPrompt(input: {
  appId?: string;
  error?: string | null;
  databases?: ReadonlyArray<{
    alias: string;
    detail?: string;
    lastReplicaPushError?: string | null;
    pendingOps?: number;
    syncMode?: "legacy" | "replica";
  }>;
  uploadDetail?: string | null;
  codeLastError?: string | null;
}): string {
  const parts = [
    "Help me fix a failed Web sync / Publish changes for my Papr mini-app.",
    "Publish changes did not complete — local changes are still not on the web.",
  ];
  if (input.appId) {
    parts.push(`App id: ${input.appId}.`);
  }
  const errorText =
    input.error?.trim() ||
    input.codeLastError?.trim() ||
    input.uploadDetail?.trim();
  if (errorText) {
    parts.push(`Last upload error: ${errorText}.`);
  }
  if (input.databases?.length) {
    const dbLines = input.databases
      .map((db) => {
        const bits = [db.alias];
        if (db.syncMode === "replica") {
          bits.push("replica");
        }
        if (db.pendingOps != null && db.pendingOps > 0) {
          bits.push(`${db.pendingOps} pending op(s)`);
        }
        if (db.lastReplicaPushError?.trim()) {
          bits.push(`push error: ${db.lastReplicaPushError.trim()}`);
        } else if (db.detail?.trim()) {
          bits.push(db.detail.trim());
        }
        return bits.join(" — ");
      })
      .join("; ");
    parts.push(`Linked databases: ${dbLines}.`);
  }
  parts.push(
    "Workflow: get_cloud_sync_status → inspect linked database sync (Plan A replica vs legacy) → diagnose the error.",
    "Legacy DBs migrate to Plan A replica automatically on Publish changes or push_cloud_sync({ appId }) — same pipeline (never delete/recreate Turso).",
    "For Turso replica WAL/checkpoint or stuck pending push (pendingOps on syncMode=replica): try repair_cloud_sync with strategy accept_cloud after explaining data loss (resets local replica from cloud). Do not confuse replica pendingOps with legacy CDC.",
    "For migration conflicts: reconcile schema_migrations on primary vs local before push.",
    "For writer/git conflicts: inspect_cloud_repo and merge remote changes first.",
    "After fixing, verify web-ready and retry push_cloud_sync({ appId }) or Publish changes. Explain what failed and what you changed.",
  );
  return parts.join(" ");
}

export function buildOversizedFilesAgentPrompt(input: {
  appId?: string;
  message?: string | null;
  count?: number;
}): string {
  const parts = [
    "Help me fix large or unsyncable files in my Papr mini-app that will not sync to the web.",
    "Git sync skips files over 10MB and never-tracked paths (e.g. data.db left in the app folder). Move them to App Files (object storage) or linked job databases instead.",
  ];
  if (input.appId) {
    parts.push(`App id: ${input.appId}.`);
  }
  if (input.count != null && input.count > 0) {
    parts.push(`${input.count} file(s) skipped.`);
  }
  if (input.message?.trim()) {
    parts.push(`Skipped files:\n${input.message.trim()}`);
  }
  parts.push(
    "Workflow: get_cloud_sync_status → read oversizedAppFiles paths and reasons.",
    "For binary assets (images, PDFs, large JSON): upload via App Files and update the app to use the App Files reference instead of a local path.",
    "For data.db in the app folder: if it belongs to a job, ensure the database lives under Jobs/ and is linked in Data Sources — not copied into apps/<appId>/.",
    "Remove or relocate skipped paths from the app folder, then verify oversizedAppFiles is clear with get_cloud_sync_status and retry Publish changes if needed.",
  );
  return parts.join(" ");
}

export function buildWriterConflictAgentPrompt(input: {
  appId?: string;
  error?: string | null;
}): string {
  const parts = [
    "Help me resolve a cloud repo publish conflict (writer 409) for my Papr mini-app.",
    "The cloud copy changed since my last publish, so my push was rejected.",
  ];
  if (input.appId) {
    parts.push(`App id: ${input.appId}.`);
  }
  if (input.error?.trim()) {
    parts.push(`Last error: ${input.error.trim()}.`);
  }
  parts.push(
    "Workflow: get_cloud_sync_status → inspect_cloud_repo (if another device may have edited cloud) → reset_writer_baseline_and_publish({ appId }) when gitUpdatesAvailable is false but writer 409 persists → verify with get_cloud_sync_status.",
    "reset_writer_baseline_and_publish re-seeds local publish baseline from cloud HEAD and publishes local code — it does NOT delete local app source files.",
    "Do not blindly overwrite — explain what changed and what you are keeping before resetting baseline when cloud may have real edits.",
  );
  return parts.join(" ");
}

export function buildChangeRequestResolveAgentPrompt(input: {
  action: "approve" | "reject";
  requestId: string;
  title: string;
  sourceAppId: string;
  description?: string;
  error: string;
}): string {
  const verb = input.action === "approve" ? "accept" : "decline";
  const parts = [
    `I tried to ${verb} a contribute-back proposal for my app but Papr returned an error.`,
    `App id: ${input.sourceAppId}.`,
    `Proposal title: ${input.title}.`,
    `Change request id: ${input.requestId}.`,
  ];
  if (input.description?.trim()) {
    parts.push(`Contributor summary: ${input.description.trim()}.`);
  }
  parts.push(`Error from Papr: ${input.error.trim()}.`);
  parts.push(
    `Please diagnose why ${verb} failed, retry safely if appropriate, and tell me the next step.`,
    "Use check_cloud_app_contributions, get_cloud_app_pr_review, get_cloud_sync_status, and resolve_cloud_app_pr as needed.",
  );
  return parts.join(" ");
}

export function buildPrReviewAgentPrompt(input: {
  sourceAppId: string;
  title: string;
  description: string;
  requestId?: string;
  branch?: string | null;
  headSha?: string | null;
  stagedPaths?: string[];
}): string {
  const parts = [
    `Help me review an incoming contribute-back proposal for my app (${input.sourceAppId}).`,
    `Title: ${input.title}.`,
    `Summary from contributor: ${input.description}.`,
  ];
  if (input.requestId) {
    parts.push(`Change request id: ${input.requestId}.`);
  }
  if (input.branch) {
    parts.push(`Branch: ${input.branch}.`);
  }
  if (input.headSha) {
    parts.push(`Commit: ${input.headSha.slice(0, 12)}.`);
  }
  if (input.stagedPaths && input.stagedPaths.length > 0) {
    const preview = input.stagedPaths.slice(0, 20).join(", ");
    const extra =
      input.stagedPaths.length > 20
        ? ` (+${input.stagedPaths.length - 20} more paths)`
        : "";
    parts.push(`Files in proposal: ${preview}${extra}.`);
  }
  parts.push(
    "Use check_cloud_app_contributions or list_cloud_app_prs, then get_cloud_app_pr_review({ requestId }) for the PR diff (Papr per-app GitHub token — not my personal GitHub login). Do not use inspect_cloud_repo or local edit_file to review this proposal. Optionally read_cloud_app_pr_file for full files. Summarize risks and recommend Accept or Decline; use resolve_cloud_app_pr to approve/reject.",
  );
  return parts.join(" ");
}

/**
 * Owner: a proposal overlaps edits accepted since it was made (e.g. both
 * changed the same heading). Ask the agent for a merged version the owner
 * approves before anything is published.
 */
export function buildProposalConflictMergeAgentPrompt(input: {
  sourceAppId: string;
  requestId: string;
  title: string;
  description?: string;
  stagedPaths?: string[];
}): string {
  const parts = [
    `A proposal for my app (${input.sourceAppId}) conflicts with changes I accepted since it was made. Help me combine them.`,
    `Proposal: "${input.title}" (change request id ${input.requestId}).`,
  ];
  if (input.description?.trim()) {
    parts.push(`Contributor summary: ${input.description.trim()}.`);
  }
  if (input.stagedPaths && input.stagedPaths.length > 0) {
    parts.push(`Files in proposal: ${input.stagedPaths.slice(0, 20).join(", ")}.`);
  }
  parts.push(
    "Steps: 1) get_cloud_app_pr_review({ requestId }) for what the contributor changed; read_cloud_app_pr_file for their full versions and read_file on my local app for mine.",
    "2) For each overlapping spot, write a merged version that keeps the intent of both, and show me a short before/after per file. Do not write anything yet.",
    "3) Only after I confirm: write the merged files into my app, publish with push_cloud_sync({ appId }), then resolve_cloud_app_pr({ requestId, action: \"approve\", mergedManually: true }). If that returns merge_not_published, the publish has not reached the web yet — wait for it and retry; don't tell me it's accepted until it succeeds.",
    "Ignore build outputs (dist/, backend/bundle.json, __papr__/, metadata.json) — they are regenerated on publish. If the two changes can't sensibly be combined, say so and suggest declining.",
  );
  return parts.join(" ");
}

/**
 * Contributor: the owner can't accept my proposal as is. Bring in the
 * publisher's latest, resolve any overlap with my edits, then propose again
 * (the new proposal replaces the old one automatically).
 */
export function buildContributorProposalUpdateAgentPrompt(input: {
  appId: string;
  sourceSlug: string;
  conflictFiles: string[];
}): string {
  return [
    `My proposal to ${input.sourceSlug} is out of date: they accepted other changes that overlap mine.`,
    `My copy's app id: ${input.appId}.`,
    input.conflictFiles.length > 0
      ? `Updating from the publisher kept my versions of: ${input.conflictFiles.join(", ")}.`
      : "",
    "Use pull_publisher_updates({ appId, checkOnly: true }) to confirm, then compare my files with the publisher's (inspect_cloud_repo on their app, read_file on mine).",
    "Merge each conflicting file so their accepted change and my edit both survive, show me the result, and after I confirm write it locally and send a new proposal with submit_cloud_app_pr — it replaces my old one.",
  ].filter(Boolean).join(" ");
}

/** Held Get updates: same files edited locally and in the incoming update. */
export function buildUpdateConflictAgentPrompt(input: {
  appId?: string;
  files: string[];
}): string {
  return [
    "An update to my app conflicts with my local edits and is on hold.",
    input.appId ? `App id: ${input.appId}.` : "",
    `Conflicting files: ${input.files.join(", ")}.`,
    "Use inspect_cloud_repo to read the incoming version and read_file for mine. Merge each file so both sets of changes survive, write the merged files locally,",
    "then call pull_cloud_app_updates with resolution \"keep_mine\" to apply the rest of the update (including migrations), and tell me what you merged before I publish.",
  ].filter(Boolean).join(" ");
}

/**
 * Status panel, "Ask agent" on some overlapping files: the update was already
 * applied with my version of these files kept. Combine the incoming version
 * into them. Nothing else is left to apply.
 */
export function buildMergeAfterUpdateAgentPrompt(input: {
  appId: string;
  files: string[];
  /** Original's slug for a linked copy; omit for my own app's web copy. */
  publisherSlug?: string;
}): string {
  const source = input.publisherSlug
    ? `the publisher's version (${input.publisherSlug} — inspect_cloud_repo on their app)`
    : "the web version (inspect_cloud_repo on this app)";
  const next = input.publisherSlug
    ? "Then I'll propose the result."
    : "Then I'll publish the result.";
  return [
    "I just got an update for my app and kept my version of files that overlapped it.",
    `App id: ${input.appId}.`,
    `Files to combine: ${input.files.join(", ")}.`,
    `For each one, read my local file (read_file) and ${source}, merge them so both sets of changes survive, and write the merged file locally.`,
    "Database schema files (.sql): never rewrite one that already ran — add a new migration instead.",
    `Show me what you merged before writing. ${next}`,
  ].join(" ");
}

/** Status panel, "Ask agent to merge all": nothing applied yet. */
export function buildMergeAllAgentPrompt(input: {
  appId: string;
  files: string[];
  publisherSlug?: string;
}): string {
  if (!input.publisherSlug) {
    return buildUpdateConflictAgentPrompt({ appId: input.appId, files: input.files });
  }
  return [
    `An update from ${input.publisherSlug} overlaps my edits and is on hold.`,
    `My copy's app id: ${input.appId}.`,
    `Overlapping files: ${input.files.join(", ")}.`,
    "Compare each with the publisher's version (inspect_cloud_repo on their app, read_file on mine) and merge so both survive.",
    "Show me the merge, and after I confirm write it locally and call pull_publisher_updates to bring in the rest — my merged files are kept.",
  ].join(" ");
}
