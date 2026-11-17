/**
 * A proposal must never carry a migration that didn't run on this copy (it
 * would run untested on approve). Before refusing, run the new ones here: a
 * teammate on shared data applies them on this desktop only (proposal hold),
 * everyone else on their own copy, exactly like papr_db_apply_migration.
 */

export interface AutoApplyTree {
  /** Repo-relative migrations directory (after any db-id remap). */
  repoRelativeDir: string;
  kind: "app" | "job" | "migrations";
  /** Local registry database id (registry migration trees only). */
  dbId?: string;
  appliedIds?: ReadonlySet<string> | null;
}

export type ApplyMigrationFn = (input: {
  dbId: string;
  migrationId: string;
}) => Promise<{ applied: boolean }>;

export interface AutoApplyResult {
  /** Migration ids that ran here now. */
  applied: string[];
  /** Repo paths that still couldn't be applied, with the reason. */
  failed: Array<{ path: string; error: string }>;
}

/** Ids to run per tree index, in filename (= number, then timestamp) order. */
export function unappliedIdsByTree(
  trees: readonly AutoApplyTree[],
  unapplied: readonly string[],
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  trees.forEach((tree, index) => {
    if (tree.kind !== "migrations" || !tree.dbId) return;
    const prefix = `${tree.repoRelativeDir.replace(/\/+$/, "")}/`;
    const ids = unapplied
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map((p) => p.slice(prefix.length).replace(/\.sql$/, ""))
      .sort();
    if (ids.length > 0) out.set(index, ids);
  });
  return out;
}

/**
 * Runs each unapplied migration and records it in the tree's appliedIds so the
 * change set can be rebuilt. Stops at the first failure in a database: later
 * migrations usually depend on earlier ones.
 */
export async function autoApplyProposalMigrations(
  trees: AutoApplyTree[],
  unapplied: readonly string[],
  apply: ApplyMigrationFn,
): Promise<AutoApplyResult> {
  const result: AutoApplyResult = { applied: [], failed: [] };
  for (const [index, ids] of unappliedIdsByTree(trees, unapplied)) {
    const tree = trees[index]!;
    const ran = new Set(tree.appliedIds ?? []);
    for (const [i, migrationId] of ids.entries()) {
      try {
        const outcome = await apply({ dbId: tree.dbId!, migrationId });
        if (!outcome.applied) throw new Error("it did not run");
        ran.add(migrationId);
        result.applied.push(migrationId);
      } catch (err) {
        for (const id of ids.slice(i)) {
          result.failed.push({
            path: `${tree.repoRelativeDir.replace(/\/+$/, "")}/${id}.sql`,
            error: id === migrationId ? (err as Error).message.slice(0, 200) : "skipped after an earlier failure",
          });
        }
        break;
      }
    }
    tree.appliedIds = ran;
  }
  return result;
}
