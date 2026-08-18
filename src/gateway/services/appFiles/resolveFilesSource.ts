/**
 * Pick which linked database holds an app's `app_files` rows.
 *
 * App Files is app-scoped, not source-scoped. Asking a user which of twelve
 * job databases should hold their file index is a question with no meaningful
 * answer — they dropped a file on an app, not on "Whisper Transcriber".
 *
 * The generic mini-app resolver is right to demand an explicit `sourceId` for
 * `/api/db/query`: a query names a table, and the caller knows which database
 * owns it. It is wrong for `/api/files`, where the caller is the Files panel
 * and there is nothing to disambiguate. Routing App Files through that resolver
 * meant every app with anything other than exactly one linked database got a
 * 400 on the first call — which is most apps, and why the panel never worked
 * end to end.
 *
 * Resolution order, most-specific first:
 *   1. Explicit `sourceId` — the caller knows better than we do.
 *   2. Whatever the standard resolver returns (single source, or legacy
 *      `primary`). Unambiguous cases must keep behaving exactly as before.
 *   3. A source that already has an `app_files` table — existing rows decide,
 *      so a second call never lands somewhere different from the first.
 *   4. First source by sorted alias — arbitrary but *stable*, which is the
 *      property that matters. An unstable choice would scatter one app's files
 *      across several databases depending on array order.
 *
 * Steps 3 and 4 always re-resolve by the source's unique `id` rather than its
 * alias, because aliases are not unique in practice (a duplicated job link
 * produces two sources with the same alias) and alias lookup silently returns
 * whichever comes first.
 */

export interface FilesSourceRef {
  id: string;
  alias?: string;
}

export interface FilesSourceDeps {
  resolveSource: (
    appId: string,
    sourceId: string | undefined,
    sql: string | undefined,
    operation: "read" | "write",
  ) => Promise<unknown>;
  dbQuery: (
    appId: string,
    source: unknown,
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows?: unknown[] }>;
  listSources?: (appId: string) => Promise<FilesSourceRef[]>;
}

/** True when the resolver rejected because it could not choose for us. */
function isAmbiguityError(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 400;
}

async function hasAppFilesTable(
  appId: string,
  source: unknown,
  deps: FilesSourceDeps,
): Promise<boolean> {
  try {
    const result = await deps.dbQuery(
      appId,
      source,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='app_files' LIMIT 1`,
    );
    return (result.rows ?? []).length > 0;
  } catch {
    // A database we cannot read is a database we should not adopt.
    return false;
  }
}

export async function resolveFilesSource(
  appId: string,
  sourceId: string | undefined,
  operation: "read" | "write",
  deps: FilesSourceDeps,
): Promise<unknown> {
  if (sourceId) {
    return deps.resolveSource(appId, sourceId, undefined, operation);
  }

  try {
    return await deps.resolveSource(appId, undefined, undefined, operation);
  } catch (err) {
    // Only ambiguity is ours to resolve. "No sources linked" (404) and any
    // other failure must surface unchanged — inventing a database to satisfy
    // a genuinely broken app would turn a clear error into a silent one.
    if (!isAmbiguityError(err) || !deps.listSources) throw err;

    const sources = await deps.listSources(appId);
    if (sources.length === 0) throw err;

    for (const candidate of sources) {
      const resolved = await deps
        .resolveSource(appId, candidate.id, undefined, operation)
        .catch(() => null);
      if (resolved && (await hasAppFilesTable(appId, resolved, deps))) {
        return resolved;
      }
    }

    const [fallback] = [...sources].sort((a, b) =>
      (a.alias ?? a.id).localeCompare(b.alias ?? b.id),
    );
    return deps.resolveSource(appId, fallback.id, undefined, operation);
  }
}
