/**
 * Git env for short-lived GitHub App installation tokens (x-access-token URLs).
 *
 * Papr auth flow: PAPR_API_KEY (keychain) → memory server → 1-hour git token.
 * Those tokens must NOT be stored in macOS Keychain — git's osxkeychain helper
 * would otherwise prompt users when cloning/pushing with embedded credentials.
 */
export function ephemeralGitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  };
}
