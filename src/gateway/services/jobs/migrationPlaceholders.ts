/**
 * `{{papr.owner_user_id}}` in migration and seed SQL.
 *
 * Publishers used to hard-code their own user id into migrations and seed rows
 * (e.g. `WHERE owner_id = 'pub-123'`, `INSERT ... VALUES ('pub-123', ...)`).
 * On a fork those rows then belong to the publisher, and a global index built
 * around them breaks the installer's writes (LinkedIn Outreach).
 *
 * The placeholder is filled in at apply time with the database OWNER:
 *   - team shared database (shared primary) → the publisher, who owns it
 *   - everything else (fork, private copy, own database) → the current user
 *
 * The checksum of a migration is always taken over the raw file, before
 * substitution, so the same file verifies identically on every device.
 */

import path from "path";

export const OWNER_USER_ID_PLACEHOLDER = "{{papr.owner_user_id}}";

export function hasMigrationPlaceholders(sql: string): boolean {
  return sql.includes(OWNER_USER_ID_PLACEHOLDER);
}

type OwnerResolver = (migrationRoot: string) => string | undefined;
let ownerResolverOverride: OwnerResolver | null = null;

/** Tests only. */
export function setMigrationOwnerResolverForTests(resolver: OwnerResolver | null): void {
  ownerResolverOverride = resolver;
}

async function defaultOwnerResolver(migrationRoot: string): Promise<string | undefined> {
  const { getPaprUserId } = await import("../../utils/paprUserId.js");
  const currentUser = getPaprUserId()?.trim() || undefined;
  try {
    const { getDatabaseRegistryService, tursoNameForRecord } = await import(
      "../DatabaseRegistryService.js"
    );
    const record = getDatabaseRegistryService().getByPath?.(
      path.join(migrationRoot, "data.db"),
    );
    if (record) {
      const { lookupSharedPrimaryTursoEntry } = await import(
        "../sharedPrimaryTursoStore.js"
      );
      // Shared primary entries are keyed by the publisher-suffixed name for
      // per-user DBs and the plain name otherwise; per-user never shares.
      const shared = lookupSharedPrimaryTursoEntry(tursoNameForRecord(record));
      if (shared?.publisherUserId) {
        return shared.publisherUserId;
      }
    }
  } catch {
    /* registry not initialised (tests / early boot) — fall back to current user */
  }
  return currentUser;
}

export async function resolveMigrationOwnerUserId(
  migrationRoot: string,
): Promise<string | undefined> {
  if (ownerResolverOverride) {
    return ownerResolverOverride(migrationRoot);
  }
  return defaultOwnerResolver(migrationRoot);
}

function sqlStringContent(value: string): string {
  // The placeholder sits inside a quoted SQL string; only quotes need escaping.
  return value.replace(/'/g, "''");
}

/**
 * Fill placeholders in `sql` for the database under `migrationRoot`.
 * Throws when a placeholder is present but no owner can be resolved — running
 * the SQL with the literal placeholder would write garbage ownership.
 */
export async function substituteMigrationPlaceholders(
  sql: string,
  migrationRoot: string,
): Promise<string> {
  if (!hasMigrationPlaceholders(sql)) {
    return sql;
  }
  const owner = await resolveMigrationOwnerUserId(migrationRoot);
  if (!owner) {
    throw new Error(
      `Migration uses ${OWNER_USER_ID_PLACEHOLDER} but no database owner is known ` +
        `(sign in to Papr). Nothing was applied.`,
    );
  }
  return sql.split(OWNER_USER_ID_PLACEHOLDER).join(sqlStringContent(owner));
}

/**
 * Agent-authored migrations: replace the owner's literal id with the
 * placeholder so the file is portable. Only whole quoted literals
 * ('<id>' → '{{papr.owner_user_id}}') and only when `ownerUserId` is the
 * database owner — on a team shared database written by a collaborator the
 * literal means that collaborator, not the owner, so it is left alone.
 */
export function portableOwnerIdInSql(
  sql: string,
  ownerUserId: string | undefined,
): { sql: string; replaced: number } {
  const id = ownerUserId?.trim();
  if (!id || id.length < 6) {
    return { sql, replaced: 0 };
  }
  const literal = `'${id.replace(/'/g, "''")}'`;
  const parts = sql.split(literal);
  if (parts.length === 1) {
    return { sql, replaced: 0 };
  }
  return {
    sql: parts.join(`'${OWNER_USER_ID_PLACEHOLDER}'`),
    replaced: parts.length - 1,
  };
}
