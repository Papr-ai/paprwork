/**
 * What a contribute-back proposal actually changes.
 *
 * Compares the collaborator's files with the publisher's files at the commit
 * the copy is based on (not the publisher's latest main). Only real edits,
 * additions and deletions go on the branch, so a stale local file can never
 * revert work the publisher did after the copy was made, and GitHub's
 * three-way merge reports genuine overlaps as conflicts.
 */

import { isProposalExcludedAppPath } from "./contributeProposalPaths.js";
import {
  DATA_SOURCES_FILE,
  LINKED_DATABASES_FILE,
  REGENERATED_FILES,
  dataSourcesForProposal,
  isLocalScratchPath,
  isReadmeStub,
  jobJsonForProposal,
  linkedDatabasesForProposal,
} from "./proposalFileMerge.js";

export interface ProposalTree {
  /** Repo-relative directory ("." for per-app repo root). */
  repoDir: string;
  /** Path relative to repoDir → local content (ids already remapped). */
  local: Map<string, string>;
  /** Path relative to repoDir → publisher content at the base commit. */
  base: Map<string, string>;
  kind: "app" | "job" | "migrations";
  /**
   * Sub-paths of this tree owned by another tree (e.g. the app folder's stale
   * bundled `jobs/` copy when Jobs/{id} is authoritative). Neither written
   * nor deleted from here.
   */
  skipPrefixes?: string[];
  /** Migration ids (no .sql) this machine restored from the ledger (restored-migrations.json). */
  restoredIds?: ReadonlySet<string>;
  /**
   * Migration ids (no .sql) that ran on this copy's database: its ledger plus
   * any held for proposal. A new migration file outside this set never ran and
   * blocks the proposal (it is reported, never silently dropped). null = the
   * ledger could not be read, so nothing can be confirmed. Omitted = no check.
   */
  appliedIds?: ReadonlySet<string> | null;
  /**
   * Local files come from a different folder than the base (a duplicate job
   * folded onto the publisher's id). A file it lacks was never there, not
   * deleted: propose edits and additions only.
   */
  noDeletes?: boolean;
}

export interface ProposalChangeSet {
  /** Repo-relative path → new content. */
  writes: Map<string, string>;
  /** Repo-relative paths to delete. */
  deletes: string[];
  /** Repo-relative paths that differ only because the platform rewrote them. */
  ignored: string[];
  /** Migration files that are restorations of already-applied files, not new schema. */
  restored: string[];
  /** Existing migrations whose content differs from the publisher's — never proposed. */
  immutableSkipped: string[];
  /** New migration files that never ran on this copy (proposal is blocked). */
  unapplied: string[];
  /** New migration files that couldn't be checked (ledger unreadable; proposal is blocked). */
  unverified: string[];
}

function joinRepo(dir: string, rel: string): string {
  return dir === "." || dir === "" ? rel : `${dir.replace(/\/+$/, "")}/${rel}`;
}

function skipped(tree: ProposalTree, rel: string): boolean {
  if (tree.skipPrefixes?.some((p) => rel === p.replace(/\/$/, "") || rel.startsWith(p))) return true;
  if (isLocalScratchPath(rel, { job: tree.kind === "job" })) return true;
  if (tree.kind === "app") {
    if (isProposalExcludedAppPath(rel)) return true;
    if (REGENERATED_FILES.has(rel) && rel !== LINKED_DATABASES_FILE) return true;
  }
  return false;
}

/** Text normalisation so CRLF / trailing-newline noise isn't an "edit". */
function same(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return norm(a) === norm(b);
}

export function buildProposalChangeSet(trees: ProposalTree[]): ProposalChangeSet {
  const writes = new Map<string, string>();
  const deletes: string[] = [];
  const ignored: string[] = [];
  const restored: string[] = [];
  const immutableSkipped: string[] = [];
  const unapplied: string[] = [];
  const unverified: string[] = [];

  for (const tree of trees) {
    for (const [rel, content] of tree.local) {
      if (skipped(tree, rel)) continue;
      const repoPath = joinRepo(tree.repoDir, rel);
      const base = tree.base.get(rel);

      if (tree.kind === "app" && rel === DATA_SOURCES_FILE) {
        const next = dataSourcesForProposal(base, content);
        if (next !== null) writes.set(repoPath, next);
        else if (base === undefined || !same(base, content)) ignored.push(repoPath);
        continue;
      }
      if (tree.kind === "app" && rel === LINKED_DATABASES_FILE) {
        const next = linkedDatabasesForProposal(base, content);
        if (next !== null) writes.set(repoPath, next);
        else if (base === undefined || !same(base, content)) ignored.push(repoPath);
        continue;
      }
      if (tree.kind === "app" && rel === "README.md" && isReadmeStub(content)) {
        if (base === undefined || !same(base, content)) ignored.push(repoPath);
        continue;
      }
      if (tree.kind === "job" && rel === "job.json") {
        const next = jobJsonForProposal(base, content);
        if (next !== null) writes.set(repoPath, next);
        else if (base !== undefined && !same(base, content)) ignored.push(repoPath);
        continue;
      }

      if (base !== undefined && same(base, content)) continue;
      if (tree.kind === "migrations" || /(^|\/)migrations\/[^/]+\.sql$/.test(rel)) {
        // Applied migrations are immutable: the publisher's copy wins, always.
        if (base !== undefined) {
          immutableSkipped.push(repoPath);
          continue;
        }
        const id = rel.split("/").pop()!.replace(/\.sql$/, "");
        if (tree.restoredIds?.has(id)) restored.push(repoPath);
        else if (tree.appliedIds === null) unverified.push(repoPath);
        else if (tree.appliedIds && !tree.appliedIds.has(id)) unapplied.push(repoPath);
      }
      writes.set(repoPath, content);
    }

    // Deletions: the publisher had it at the base, the collaborator removed it.
    for (const rel of tree.base.keys()) {
      if (tree.noDeletes) break;
      if (tree.local.has(rel)) continue;
      if (skipped(tree, rel)) continue;
      // Platform files are regenerated or merged, never deleted by a proposal.
      if (tree.kind === "app" && (rel === DATA_SOURCES_FILE || rel === LINKED_DATABASES_FILE || rel === "README.md")) {
        continue;
      }
      // Migrations are append-only; a missing one means "not pulled yet".
      if (tree.kind === "migrations" || /(^|\/)migrations\//.test(rel)) continue;
      deletes.push(joinRepo(tree.repoDir, rel));
    }
  }

  return {
    writes,
    deletes: deletes.sort(),
    ignored: ignored.sort(),
    restored: restored.sort(),
    immutableSkipped: immutableSkipped.sort(),
    unapplied: unapplied.sort(),
    unverified: unverified.sort(),
  };
}
