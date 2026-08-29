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
    "Legacy DB + Plan A rollout: cutover runs automatically on Upload now **or** push_cloud_sync({ appId }) with default targets (github + turso) — same ordered flush (migrations → cutover → replica push → git → publish). Same Turso instance — never delete_database/recreate. Local-only legacy CDC tables (e.g. turso_cdc, turso_sync_last_change_id) are ignored for drift and stripped at cutover.",
    "After cutover (or if already replica): compare migrations/*.sql vs schema_migrations → papr_db_apply_migration for missing migrations (never papr_db_exec DDL or bash/sqlite3 on registry DB files).",
    "Migration conflict: repair_cloud_sync merge_lww first. accept_cloud only when Turso is authoritative (never when local has more rows).",
    "Local has rows but Turso empty/stale (e.g. after mistaken delete/recreate): restore data.db from newest .sync-backup or .pre-replica.bak, then repair_cloud_sync bootstrap_remote (NOT force_local, NOT sqlite3 INSERT).",
    "Legacy-only sync (no replica rollout): push_cloud_sync({ appId }) or Upload now applies local migrations then pushes Turso.",
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
    "Help me fix a failed Web sync / Upload now for my Papr mini-app.",
    "Upload now did not complete — local changes are still not on the web.",
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
    "Legacy DBs migrate to Plan A replica automatically on Upload now or push_cloud_sync({ appId }) — same pipeline (never delete/recreate Turso).",
    "For Turso replica WAL/checkpoint or stuck pending CDC: try repair_cloud_sync with strategy accept_cloud after explaining data loss (resets local replica from cloud).",
    "For migration conflicts: reconcile schema_migrations on primary vs local before push.",
    "For writer/git conflicts: inspect_cloud_repo and merge remote changes first.",
    "After fixing, verify web-ready and retry push_cloud_sync({ appId }) or Upload now. Explain what failed and what you changed.",
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
    "Remove or relocate skipped paths from the app folder, then verify oversizedAppFiles is clear with get_cloud_sync_status and retry Upload now if needed.",
  );
  return parts.join(" ");
}

export function buildWriterConflictAgentPrompt(input: {
  appId?: string;
  error?: string | null;
}): string {
  const parts = [
    "Help me resolve a cloud repo upload conflict (writer 409) for my Papr mini-app.",
    "The cloud copy changed since my last upload, so my push was rejected.",
  ];
  if (input.appId) {
    parts.push(`App id: ${input.appId}.`);
  }
  if (input.error?.trim()) {
    parts.push(`Last error: ${input.error.trim()}.`);
  }
  parts.push(
    "Workflow: get_cloud_sync_status → inspect_cloud_repo (see what changed on the web) → merge remote changes OR edit my local files to incorporate remote updates → push_cloud_sync / Upload now.",
    "Do not blindly overwrite — explain what changed and what I should keep before uploading again.",
  );
  return parts.join(" ");
}

export function buildPrReviewAgentPrompt(input: {
  sourceAppId: string;
  title: string;
  description: string;
  prUrl?: string | null;
}): string {
  const parts = [
    `Help me review an incoming contribute-back proposal for my app (${input.sourceAppId}).`,
    `Title: ${input.title}.`,
    `Description: ${input.description}.`,
  ];
  if (input.prUrl) {
    parts.push(`GitHub PR: ${input.prUrl}.`);
  }
  parts.push(
    "Use list_cloud_app_changes and inspect_cloud_repo. Explain the code diff, risks, and whether I should Accept or Decline. If I accept, guide me through merge + local sync.",
  );
  return parts.join(" ");
}
