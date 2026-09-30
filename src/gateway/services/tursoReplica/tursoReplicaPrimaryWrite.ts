/** SQL classification helpers for Turso Sync replica routing. */

export function isDdlSql(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  return (
    trimmed.startsWith("create") ||
    trimmed.startsWith("alter") ||
    trimmed.startsWith("drop") ||
    trimmed.startsWith("truncate")
  );
}
