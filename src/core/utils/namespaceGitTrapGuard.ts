/**
 * Warn when bash git commands inspect legacy namespace monorepo app paths for cloud sync.
 */

export const NAMESPACE_GIT_TRAP_WARNING =
  "Sync V3 app code lives in a per-app GitHub repo (writer ops), NOT in the legacy namespace monorepo under apps/{id}/. " +
  "Do NOT use bash git ls-files/status on the namespace repo to verify cloud upload. " +
  "Use get_cloud_sync_status({ appId }) → appWriterRepo, or inspect_cloud_repo({ appId, ... }).";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const TRAP_PATTERNS: RegExp[] = [
  /\bgit\s+ls-files\b[^\n|;&]*\bapps\//i,
  /\bgit\s+ls-tree\b[^\n|;&]*\bapps\//i,
  /\bgit\s+show\b[^\n|;&]*HEAD:apps\//i,
  /\bgit\s+status\b[^\n|;&]*\bapps\//i,
  new RegExp(`\\bgit\\s+diff\\b[^\\n|;&]*\\bapps/${UUID}`, "i"),
  new RegExp(`\\bgit\\s+log\\b[^\\n|;&]*\\bapps/${UUID}`, "i"),
];

export function detectNamespaceGitTrapCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized.includes("git")) {
    return false;
  }
  return TRAP_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function buildNamespaceGitTrapWarning(): string {
  return (
    "=== Namespace git trap (Sync V3) ===\n" +
    `${NAMESPACE_GIT_TRAP_WARNING}\n` +
    "Use: get_cloud_sync_status({ appId }) or inspect_cloud_repo({ appId, action: 'list'|'read', ... }).\n" +
    "=== End warning ===\n\n"
  );
}
