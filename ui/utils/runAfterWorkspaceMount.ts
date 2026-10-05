/**
 * Run `fn` once the workspace UI has finished its first restore.
 *
 * The auth gate releases by flipping App into the workspace, and App's
 * cold-boot effect then calls reloadUiForWorkspaceSwitch() — which CLEARS the
 * tab store and restores the saved tab bar from SQLite. Anything onboarding
 * opened before that finished (the installed app + its chat) was wiped a
 * moment later, so the user saw "Installing…" and then nothing. Waiting for
 * `papr-workspace-switch-complete` puts our tabs on top of the restored bar.
 *
 * Register BEFORE releasing the gate so the event can't be missed. Falls back
 * after `timeoutMs` so a missed event never swallows the action.
 */

import { isWorkspaceSwitchReloading } from "../lib/workspaceSwitchReload";

const RELOAD_SETTLE_MS = 300;
const RELOAD_POLL_MS = 50;
const RELOAD_POLL_MAX = 40;

async function waitForReloadToFinish(): Promise<void> {
  for (let i = 0; i < RELOAD_POLL_MAX; i += 1) {
    if (!isWorkspaceSwitchReloading()) {
      return;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, RELOAD_POLL_MS);
    });
  }
}

export function runAfterWorkspaceMount(
  fn: () => void,
  options: { immediate?: boolean; timeoutMs?: number } = {},
): void {
  // Dev preview: the workspace is already mounted, no restore is coming.
  if (options.immediate) {
    window.setTimeout(fn, 400);
    return;
  }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    window.removeEventListener("papr-workspace-switch-complete", onSwitchComplete);
    window.clearTimeout(timer);
    void (async () => {
      await waitForReloadToFinish();
      // Let the restored ContentArea mount before we add tabs / send.
      window.setTimeout(fn, RELOAD_SETTLE_MS);
    })();
  };
  const onSwitchComplete = () => {
    run();
  };
  window.addEventListener("papr-workspace-switch-complete", onSwitchComplete);
  const timer = window.setTimeout(run, options.timeoutMs ?? 10_000);
}
