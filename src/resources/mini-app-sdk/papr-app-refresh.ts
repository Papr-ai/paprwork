/**
 * Auto-reload published cloud apps when desktop sync pushes a new bundle.
 *
 * index.html is no-cache, but dist/app.js is immutable for 1 year. After Sync
 * now, desktop notifies apps.papr.ai, which pushes a revision event over SSE.
 * Open tabs reload without manual refresh or background polling.
 */

const REVISION_META = "papr-app-revision";
const REVISION_JSON_PATH = "__papr__/app-revision.json";
const REVISION_EVENTS_PATH = "__papr__/app-revision/events";
const RELOAD_DELAY_MS = 2_000;

function readLoadedRevision(): string | null {
  return (
    document.querySelector(`meta[name="${REVISION_META}"]`)?.getAttribute("content") ??
    null
  );
}

async function fetchCurrentRevision(): Promise<string | null> {
  try {
    const response = await fetch(REVISION_JSON_PATH, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { revision?: string };
    return typeof body.revision === "string" ? body.revision : null;
  } catch {
    return null;
  }
}

let pendingReload = false;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleReload(): void {
  if (pendingReload) {
    return;
  }
  pendingReload = true;

  if (document.hidden) {
    location.reload();
    return;
  }

  reloadTimer = window.setTimeout(() => {
    if (pendingReload) {
      location.reload();
    }
  }, RELOAD_DELAY_MS);
}

function handleRevisionChange(nextRevision: string, loadedRevision: string): void {
  if (nextRevision !== loadedRevision) {
    scheduleReload();
  }
}

async function checkForAppUpdate(): Promise<void> {
  const loadedRevision = readLoadedRevision();
  if (!loadedRevision) {
    return;
  }

  const currentRevision = await fetchCurrentRevision();
  if (!currentRevision) {
    return;
  }

  handleRevisionChange(currentRevision, loadedRevision);
}

function connectRevisionStream(loadedRevision: string): void {
  const source = new EventSource(REVISION_EVENTS_PATH);

  source.addEventListener("app-revision", (event) => {
    const data = (() => {
      try {
        return JSON.parse((event as MessageEvent<string>).data) as {
          revision?: string;
        };
      } catch {
        return null;
      }
    })();
    if (typeof data?.revision === "string") {
      handleRevisionChange(data.revision, loadedRevision);
    }
  });

  source.onerror = () => {
    /* EventSource reconnects automatically */
  };
}

const loadedRevision = readLoadedRevision();
if (loadedRevision) {
  connectRevisionStream(loadedRevision);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && pendingReload) {
      if (reloadTimer !== undefined) {
        window.clearTimeout(reloadTimer);
        reloadTimer = undefined;
      }
      location.reload();
      return;
    }
    if (!document.hidden) {
      void checkForAppUpdate();
    }
  });
}
