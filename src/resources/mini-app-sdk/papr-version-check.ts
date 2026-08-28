/**
 * One-shot version check for published cloud apps (Vercel-style).
 *
 * - On first tab focus: fetch __papr__/app-revision.json vs meta tag
 * - On parent Refresh (postMessage): same check before reload
 * - Schema sync banner when Turso lags behind bundle requiredSchemaVersion
 * - No polling, no persistent SSE
 *
 * Uses in-DOM confirm (papr-dialog) — window.confirm() is silently blocked in
 * cross-origin iframes (Paprwork local + web preview toggles).
 */

import { askConfirm } from "./papr-dialog.ts";

const REVISION_META = "papr-app-revision";
const REVISION_JSON_PATH = "__papr__/app-revision.json";
const PROMPT_MESSAGE = "New version available — refresh?";
const SCHEMA_BANNER_ID = "papr-schema-sync-banner";
const SCHEMA_BANNER_MESSAGE =
  "Database syncing — some features may be unavailable until sync completes.";

interface AppRevisionPayload {
  revision?: string;
  schemaSyncing?: boolean;
  schemaReady?: boolean;
}

function readLoadedRevision(): string | null {
  return (
    document.querySelector(`meta[name="${REVISION_META}"]`)?.getAttribute("content") ??
    null
  );
}

async function fetchRevisionPayload(): Promise<AppRevisionPayload | null> {
  try {
    const response = await fetch(REVISION_JSON_PATH, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as AppRevisionPayload;
  } catch {
    return null;
  }
}

function showSchemaSyncBanner(): void {
  if (document.getElementById(SCHEMA_BANNER_ID)) {
    return;
  }
  const banner = document.createElement("div");
  banner.id = SCHEMA_BANNER_ID;
  banner.setAttribute("role", "status");
  banner.textContent = SCHEMA_BANNER_MESSAGE;
  Object.assign(banner.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    zIndex: "99999",
    padding: "10px 16px",
    fontSize: "14px",
    lineHeight: "1.4",
    textAlign: "center",
    background: "rgba(255, 149, 0, 0.95)",
    color: "#1c1c1e",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
  });
  document.body.prepend(banner);
}

function hideSchemaSyncBanner(): void {
  document.getElementById(SCHEMA_BANNER_ID)?.remove();
}

function updateSchemaSyncBanner(payload: AppRevisionPayload | null): void {
  if (payload?.schemaSyncing === true || payload?.schemaReady === false) {
    showSchemaSyncBanner();
    return;
  }
  hideSchemaSyncBanner();
}

function postToParent(source: MessageEventSource | null, reload: boolean): void {
  if (source && "postMessage" in source) {
    source.postMessage({ type: "papr-check-version-result", reload }, "*");
  }
}

const loadedRevision = readLoadedRevision();
if (loadedRevision) {
  let focusChecked = false;

  void fetchRevisionPayload().then(updateSchemaSyncBanner);

  document.addEventListener("visibilitychange", () => {
    if (focusChecked || document.hidden) {
      return;
    }
    focusChecked = true;
    void (async () => {
      const payload = await fetchRevisionPayload();
      updateSchemaSyncBanner(payload);
      const currentRevision = payload?.revision ?? null;
      if (!currentRevision || currentRevision === loadedRevision) {
        return;
      }
      if (await askConfirm(PROMPT_MESSAGE, "Refresh")) {
        location.reload();
      }
    })();
  });

  window.addEventListener("message", (event) => {
    if (event.data?.type !== "papr-check-version") {
      return;
    }
    void (async () => {
      const payload = await fetchRevisionPayload();
      updateSchemaSyncBanner(payload);
      const currentRevision = payload?.revision ?? null;
      if (currentRevision && currentRevision !== loadedRevision) {
        if (await askConfirm(PROMPT_MESSAGE, "Refresh")) {
          location.reload();
          postToParent(event.source, false);
          return;
        }
        postToParent(event.source, false);
        return;
      }
      postToParent(event.source, true);
    })();
  });
}
