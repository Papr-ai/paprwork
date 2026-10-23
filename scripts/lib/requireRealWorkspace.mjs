/**
 * Import FIRST in E2E/diagnostic scripts that deliberately use the developer's
 * REAL workspace (running gateway, real ~/Papr, real registry, real keychain
 * session). Refuses to run unless PAPR_E2E_REAL_HOME=1, so nobody points one
 * at their live workspace by accident.
 *
 * Scripts that can run against a throwaway workspace should import
 * ./isolateHome.mjs instead. tests/gateway/scripts-workspace-isolation.test.ts
 * enforces that every script importing app code picks one.
 */
if (process.env.PAPR_E2E_REAL_HOME !== "1") {
  const script = process.argv[1] ?? "this script";
  console.error(
    `[requireRealWorkspace] ${script} reads or writes your REAL Papr workspace.\n` +
      `Re-run with PAPR_E2E_REAL_HOME=1 if that is what you want.`,
  );
  process.exit(2);
}
