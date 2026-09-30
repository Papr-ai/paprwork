/**
 * One-shot version check for published cloud apps (Vercel-style).
 *
 * - On first tab focus: fetch __papr__/app-revision.json vs meta tag
 * - On parent Refresh (postMessage): same check before reload
 * - No polling, no persistent SSE
 *
 * Uses in-DOM confirm (papr-dialog) — window.confirm() is silently blocked in
 * cross-origin iframes (Paprwork local + web preview toggles).
 */

import { askConfirm } from "./papr-dialog.ts";

const REVISION_META = "papr-app-revision";
const REVISION_JSON_PATH = "__papr__/app-revision.json";
const PROMPT_MESSAGE = "New version available — refresh?";

interface AppRevisionPayload {
  revision?: string;
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

function postToParent(source: MessageEventSource | null, reload: boolean): void {
  if (source && "postMessage" in source) {
    source.postMessage({ type: "papr-check-version-result", reload }, "*");
  }
}

const loadedRevision = readLoadedRevision();
if (loadedRevision) {
  let focusChecked = false;

  document.addEventListener("visibilitychange", () => {
    if (focusChecked || document.hidden) {
      return;
    }
    focusChecked = true;
    void (async () => {
      const payload = await fetchRevisionPayload();
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
