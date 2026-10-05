/**
 * v7 status panel model — what the share-bar chip opens.
 *
 * The panel answers "what is different from the web, and what do I do about
 * it", one row per kind of change, worst first:
 *
 *   conflict  an update overlaps my edits — pick Mine / Theirs / Ask agent per file
 *   update    a newer version exists (the web copy, or the original's publisher)
 *   code      my edits not on the web yet — app files, jobs, schema files
 *   data      row changes that are stuck (offline, failed, structure mismatch)
 *   issue     anything else that needs a person (large files, review, errors)
 *
 * Header = the chip's own words, so the chip and the panel never disagree.
 * Synced things are not listed; an empty panel says "Nothing to send".
 * Pure: no React, no fetch — the component renders whatever this returns.
 */

import type { AppCloudSyncStatus } from "./appCloudSyncStatus";

export type PanelTone = "ok" | "warn" | "bad" | "info" | "idle" | "busy";
export type FileChange = "added" | "edited" | "removed";

export interface ChangeItem {
  path: string;
  change: FileChange;
  /** Replaces the change label, e.g. "Merged with your edits". */
  note?: string;
}

export type GroupName = "App files" | "Jobs" | "Database" | "Databases";
export interface ChangeGroup {
  name: GroupName;
  items: ChangeItem[];
}

/** A file both sides edited on the same lines. */
export interface ConflictItem {
  path: string;
  /** Schema file (migration) — label it so the choice reads as "structure". */
  schema?: boolean;
}

export type PanelAction =
  | "publish"
  | "propose"
  | "get_updates"
  | "apply_update"
  | "retry_data"
  | "ask_agent"
  /** Review + double-confirm deletes held back (more than 10 at once). */
  | "confirm_deletes"
  /** Remove files that are on the web but were never on this computer. */
  | "remove_web_only";

export interface PanelRow {
  kind: "conflict" | "update" | "code" | "data" | "issue";
  title: string;
  value: string;
  tone: PanelTone;
  action?: { id: PanelAction; label: string; disabled?: boolean };
  /** 0–100 while sending. */
  progress?: number;
  groups?: ChangeGroup[];
  conflicts?: ConflictItem[];
  foot?: string;
}

export interface SyncPanel {
  header: { label: string; tone: PanelTone };
  rows: PanelRow[];
  /** Shown under the rows; e.g. offline reassurance. */
  note?: string;
  /** Offer "Ask agent" in the footer (anything not simply synced). */
  offerAgent: boolean;
}

/** Incoming update, from a dry run of Get updates. */
export interface UpdatePreview {
  incoming: Array<{ path: string; change: "added" | "edited" | "removed"; merged?: boolean; conflict?: boolean }>;
  conflictFiles: string[];
}

export interface SyncPanelInput {
  status: AppCloudSyncStatus | null;
  chip: { label: string; tone: PanelTone };
  /** Where my code goes: Publish (my copy) or Propose (team's live data). */
  codeDestination: "publish" | "propose";
  /** Files my Publish / Propose would send. null = not loaded. */
  codeChanges: ChangeItem[] | null;
  /** Removals held back until confirmed (more than 10 at once). */
  heldDeletes?: string[];
  /** On the web, not on this computer, never synced from here. */
  webOnly?: string[];
  /** A newer version exists. */
  update: {
    /** "the web" for my own app, else the original's slug. */
    source: string;
    fromPublisher: boolean;
    preview: UpdatePreview | null;
  } | null;
  pushing: boolean;
  pulling: boolean;
  error: string | null;
  live: boolean;
}

/** Build output is sent with the code but never something a person edited. */
const GENERATED = /^(dist\/|__papr__\/|backend\/bundle\.json$)/;

export function groupChanges(items: ChangeItem[]): ChangeGroup[] {
  const shown = items.filter((i) => !GENERATED.test(i.path));
  const list = shown.length > 0 ? shown : items;
  const app: ChangeItem[] = [];
  const jobs: ChangeItem[] = [];
  const db: ChangeItem[] = [];
  for (const item of list) {
    if (item.path.startsWith("jobs/")) {
      jobs.push({ ...item, path: item.path.slice("jobs/".length) });
    } else if (item.path.startsWith("databases/")) {
      db.push({ ...item, path: item.path.split("/").pop() ?? item.path });
    } else {
      app.push(item);
    }
  }
  const groups: ChangeGroup[] = [];
  if (app.length) groups.push({ name: "App files", items: app });
  if (jobs.length) groups.push({ name: "Jobs", items: jobs });
  if (db.length) groups.push({ name: "Database", items: db });
  return groups;
}

const UNIT: Record<GroupName, [string, string]> = {
  "App files": ["app file", "app files"],
  Jobs: ["job file", "job files"],
  Database: ["schema change", "schema changes"],
  Databases: ["database", "databases"],
};

/** "2 app files · 1 job file · 1 schema change" */
export function summarizeGroups(groups: ChangeGroup[]): string {
  return groups
    .map((g) => `${g.items.length} ${UNIT[g.name][g.items.length === 1 ? 0 : 1]}`)
    .join(" · ");
}

export function countItems(groups: ChangeGroup[]): number {
  return groups.reduce((n, g) => n + g.items.length, 0);
}

export function isSchemaPath(p: string): boolean {
  return p.startsWith("databases/") || /\.sql$/i.test(p);
}

function conflictRow(input: SyncPanelInput, files: string[]): PanelRow {
  const n = files.length;
  const preview = input.update?.preview;
  const rest = (preview?.incoming ?? []).filter((i) => !i.conflict);
  const groups = groupChanges(
    rest.map((i) => ({
      path: i.path,
      change: i.change,
      ...(i.merged ? { note: "Merged with your edits" } : {}),
    })),
  );
  return {
    kind: "conflict",
    title: n === 1 ? "1 file overlaps your edits" : `${n} files overlap your edits`,
    value: groups.length
      ? "Everything else merges on its own. Pick a version for these."
      : "Pick a version for each file.",
    tone: "bad",
    conflicts: files.map((path) => ({ path, ...(isSchemaPath(path) ? { schema: true } : {}) })),
    groups,
    // On a team copy the live data follows the owner's code: whatever you
    // keep (Mine, or the agent's merge) becomes part of your next proposal.
    foot: input.codeDestination === "propose"
      ? "Files you keep go to the owner with your next proposal."
      : undefined,
    action: { id: "apply_update", label: input.pulling ? "Applying…" : "Apply update", disabled: input.pulling },
  };
}

function updateRow(input: SyncPanelInput): PanelRow {
  const u = input.update!;
  const preview = u.preview;
  const groups = preview
    ? groupChanges(
        preview.incoming.map((i) => ({
          path: i.path,
          change: i.change,
          ...(i.merged ? { note: "Merges with your edits" } : {}),
        })),
      )
    : [];
  const merges = preview?.incoming.some((i) => i.merged) ?? false;
  return {
    kind: "update",
    title: u.fromPublisher ? `New version from ${u.source}` : "Newer version on the web",
    value: groups.length ? summarizeGroups(groups) : preview ? "Small update" : "Checking what changed…",
    tone: "info",
    groups,
    foot: merges
      ? "Your edits are kept — overlapping lines are the only thing you'd be asked about."
      : u.fromPublisher
        ? "Your edits on this Mac are kept."
        : undefined,
    action: {
      id: "get_updates",
      label: input.pulling ? "Getting updates…" : "Get updates",
      disabled: input.pulling || input.pushing,
    },
  };
}

function codeRow(input: SyncPanelInput, blockedByUpdate: boolean): PanelRow | null {
  const status = input.status;
  const items = input.codeChanges ?? [];
  const unpublished = status?.hasLocalChanges === true || items.length > 0 || !input.live;
  if (!unpublished) return null;
  if (input.codeDestination === "propose" && items.length === 0) return null;
  const groups = groupChanges(items);
  const label = input.codeDestination === "propose" ? "Propose" : "Publish";
  const busyLabel = input.codeDestination === "propose" ? label : "Publishing…";
  return {
    kind: "code",
    title: !input.live && input.codeDestination === "publish" ? "Not on the web yet" : "Code",
    value: groups.length
      ? summarizeGroups(groups)
      : input.codeChanges === null
        ? "Edited since last publish"
        : "Ready to publish",
    tone: input.live ? "warn" : "idle",
    groups,
    foot: blockedByUpdate ? "Get the update first — then publish on top of it." : undefined,
    action: {
      id: input.codeDestination,
      label: input.pushing ? busyLabel : label,
      disabled: input.pushing || input.pulling || blockedByUpdate,
    },
  };
}

function dataRow(status: AppCloudSyncStatus, input: SyncPanelInput): PanelRow | null {
  const stuck = status.databases.filter(
    (db) =>
      db.migrationConflict ||
      db.cutoverBlocked ||
      db.schemaDrift ||
      Boolean(db.lastReplicaPushError) ||
      db.online === false ||
      (db.pendingPush && db.phase !== "synced"),
  );
  if (stuck.length === 0) return null;
  const pending = stuck.reduce((n, db) => n + (db.pendingOps ?? 0), 0);
  const failed = stuck.some((db) => db.lastReplicaPushError);
  const structure = stuck.some((db) => db.migrationConflict || db.cutoverBlocked || db.schemaDrift);
  const offline = stuck.every((db) => db.online === false);
  const rows = `${pending} row change${pending === 1 ? "" : "s"}`;
  const groups: ChangeGroup[] = [
    {
      name: "Databases",
      items: stuck.map((db) => ({
        path: db.alias,
        change: "edited" as const,
        note: db.pendingOps ? `${db.pendingOps} waiting` : db.migrationConflict || db.cutoverBlocked ? "Structure differs" : undefined,
      })),
    },
  ];
  if (structure) {
    return {
      kind: "data",
      title: "Data",
      value: "Database structure differs from the web",
      tone: "bad",
      groups,
      action: { id: "ask_agent", label: "Ask agent" },
    };
  }
  if (failed) {
    return {
      kind: "data",
      title: "Data",
      value: pending ? `${rows} couldn't be sent` : "Last send failed",
      tone: "bad",
      groups,
      action: { id: "retry_data", label: input.pushing ? "Retrying…" : "Retry", disabled: input.pushing },
    };
  }
  if (offline) {
    return { kind: "data", title: "Data", value: pending ? `${rows} waiting` : "Waiting to send", tone: "idle", groups };
  }
  return {
    kind: "data",
    title: "Data",
    value: pending ? `Sending ${rows}` : "Sending",
    tone: "busy",
    groups,
  };
}

function issueRows(status: AppCloudSyncStatus, input: SyncPanelInput): PanelRow[] {
  const rows: PanelRow[] = [];
  if ((status.oversizedAppFilesCount ?? 0) > 0) {
    const n = status.oversizedAppFilesCount ?? 0;
    rows.push({
      kind: "issue",
      title: n === 1 ? "1 file won't sync to the web" : `${n} files won't sync to the web`,
      value: status.oversizedAppFilesSummary
        ? `${status.oversizedAppFilesSummary} — store them with App Files.`
        : "Store them with App Files so visitors can load them.",
      tone: "warn",
      action: { id: "ask_agent", label: "Ask agent" },
    });
  }
  if (status.gitRemoteRequiresReview && !status.gitRemoteMetadataSync) {
    rows.push({
      kind: "issue",
      title: "Web history changed",
      value: status.gitRemoteReviewHeadline ?? "Review before publishing again.",
      tone: "bad",
      action: { id: "ask_agent", label: "Ask agent" },
    });
  } else if (status.writerConflict) {
    rows.push({
      kind: "issue",
      title: "The web copy moved while you were publishing",
      value: "Get updates, then publish again.",
      tone: "bad",
      action: { id: "get_updates", label: input.pulling ? "Getting updates…" : "Get updates", disabled: input.pulling },
    });
  }
  const failure =
    input.error?.trim() ||
    (status.uploadStatus === "failed" && !status.uploadRetryPending
      ? status.uploadDetail?.trim() || status.uploadLabel?.trim() || "Publish failed"
      : "") ||
    status.codeLastError?.trim() ||
    "";
  if (failure && !rows.some((r) => r.tone === "bad")) {
    rows.push({
      kind: "issue",
      title: "Last publish didn't finish",
      value: failure.length > 120 ? `${failure.slice(0, 119)}…` : failure,
      tone: "bad",
      action: { id: "ask_agent", label: "Ask agent" },
    });
  }
  return rows;
}

/** Removals that need a decision. Nothing here is ever deleted without one. */
function deleteRows(input: SyncPanelInput): PanelRow[] {
  const rows: PanelRow[] = [];
  const held = input.heldDeletes ?? [];
  if (held.length > 0) {
    rows.push({
      kind: "issue",
      title: `${held.length} deleted files need your OK`,
      value: "You removed these here. Confirm to remove them from the web too.",
      tone: "warn",
      groups: groupChanges(held.map((path) => ({ path, change: "removed" as const }))),
      action: { id: "confirm_deletes", label: "Review", disabled: input.pushing },
    });
  }
  const webOnly = input.webOnly ?? [];
  if (webOnly.length > 0 && input.codeDestination === "publish") {
    rows.push({
      kind: "issue",
      title: webOnly.length === 1
        ? "1 file is on the web but not on this computer"
        : `${webOnly.length} files are on the web but not on this computer`,
      value: "Usually old copies. They stay until you remove them.",
      tone: "idle",
      groups: groupChanges(webOnly.map((path) => ({ path, change: "removed" as const, note: "Web only" }))),
      action: { id: "remove_web_only", label: "Remove from web", disabled: input.pushing || input.pulling },
    });
  }
  return rows;
}

/** Red rows first; otherwise update → code → data → issues, so "get the
 *  update" always sits above the Publish it blocks. */
const ORDER: Record<PanelTone, number> = { bad: 0, warn: 1, info: 1, busy: 1, idle: 1, ok: 1 };

export function buildSyncPanel(input: SyncPanelInput): SyncPanel {
  const { status } = input;
  const rows: PanelRow[] = [];

  const conflictFiles =
    input.update?.preview?.conflictFiles.length
      ? input.update.preview.conflictFiles
      : status?.updateConflictFiles ?? [];
  // A conflict row only exists once we know which files overlap; until the
  // preview loads, the update row stands in for it.
  if (input.update && conflictFiles.length > 0) {
    rows.push(conflictRow(input, conflictFiles));
  } else if (input.update) {
    rows.push(updateRow(input));
  }

  // My own web copy is ahead: publish would overwrite it, so get it first.
  const blockedByUpdate = Boolean(input.update && !input.update.fromPublisher);
  const code = codeRow(input, blockedByUpdate);
  if (code) rows.push(code);

  if (status) {
    const data = dataRow(status, input);
    if (data) rows.push(data);
    rows.push(...issueRows(status, input));
  }
  rows.push(...deleteRows(input));

  // Problems first; within the rest, keep the order above.
  const sorted = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => ORDER[a.row.tone] - ORDER[b.row.tone] || a.i - b.i)
    .map(({ row }) => row);

  const offline =
    status != null &&
    status.databases.length > 0 &&
    status.databases.some((db) => db.online === false) &&
    !sorted.some((r) => r.tone === "bad");

  return {
    header: input.chip,
    rows: sorted,
    note: offline ? "Row changes send by themselves when you're back online." : undefined,
    offerAgent: sorted.length > 0 || Boolean(input.error),
  };
}
