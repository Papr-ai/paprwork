/**
 * Compare loaded revision (iframe meta) vs live __papr__/app-revision.json.
 * Used by Paprwork publish bar Refresh in web preview mode.
 */

const REVISION_META = "papr-app-revision";
const PROMPT_MESSAGE = "New version available — refresh?";

export function buildAppRevisionJsonUrl(previewPageUrl: string): string {
  const url = previewPageUrl.startsWith("http")
    ? new URL(previewPageUrl)
    : new URL(
        previewPageUrl,
        typeof window !== "undefined" ? window.location.origin : "http://localhost",
      );
  let pathname = url.pathname;
  if (pathname.endsWith("/index.html")) {
    pathname = pathname.slice(0, -"/index.html".length);
  }
  if (!pathname.endsWith("/")) {
    pathname += "/";
  }
  url.pathname = `${pathname}__papr__/app-revision.json`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readLoadedRevisionFromIframe(iframe: HTMLIFrameElement): string | null {
  try {
    return (
      iframe.contentDocument
        ?.querySelector(`meta[name="${REVISION_META}"]`)
        ?.getAttribute("content") ?? null
    );
  } catch {
    return null;
  }
}

async function fetchLiveRevision(revisionJsonUrl: string): Promise<string | null> {
  try {
    const response = await fetch(revisionJsonUrl, {
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

function checkViaPostMessage(iframe: HTMLIFrameElement): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(true);
    }, 4000);

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow) {
        return;
      }
      if (event.data?.type !== "papr-check-version-result") {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      resolve(event.data.reload !== false);
    };

    window.addEventListener("message", onMessage);
    iframe.contentWindow?.postMessage({ type: "papr-check-version" }, "*");
  });
}

/**
 * Returns true if the caller should proceed with reload.
 * Shows confirm when live revision differs from loaded meta.
 */
export async function confirmRefreshIfNewRevision(
  iframe: HTMLIFrameElement | null,
  previewPageUrl: string,
): Promise<boolean> {
  if (!iframe) {
    return true;
  }

  const loaded = readLoadedRevisionFromIframe(iframe);
  if (!loaded) {
    return checkViaPostMessage(iframe);
  }

  const live = await fetchLiveRevision(buildAppRevisionJsonUrl(previewPageUrl));
  if (!live || live === loaded) {
    return true;
  }

  return window.confirm(PROMPT_MESSAGE);
}
