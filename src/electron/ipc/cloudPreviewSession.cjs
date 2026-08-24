/**
 * Seed apps.papr.ai cookies into Electron session for direct cloud preview iframes.
 */

const GATEWAY_PORT = process.env.GATEWAY_PORT || "18789";
const GATEWAY_HOST = process.env.GATEWAY_HOST || "localhost";
const CLOUD_APPS_ORIGIN =
  process.env.PAPR_CLOUD_APPS_HOST?.replace(/\/$/, "") ?? "https://apps.papr.ai";

/** Electron cookies.set uses no_restriction, not HTTP's "none". */
function toElectronSameSite(raw, secure, forceCrossSite = false) {
  if (forceCrossSite && secure) {
    return "no_restriction";
  }
  const normalized = String(raw ?? "lax").toLowerCase();
  if (normalized === "none" || normalized === "no_restriction") {
    return secure ? "no_restriction" : "lax";
  }
  if (normalized === "strict") {
    return "strict";
  }
  return "lax";
}

async function hasCloudPreviewSessionCookies(session) {
  const cookies = await session.defaultSession.cookies.get({
    url: CLOUD_APPS_ORIGIN,
  });
  const sessionCookie = cookies.find(
    (cookie) => cookie.name === "papr_session" && Boolean(cookie.value),
  );
  if (!sessionCookie) {
    return false;
  }
  // Cross-site Paprwork iframe requires SameSite=None (Electron: no_restriction).
  const sameSite = sessionCookie.sameSite ?? "unspecified";
  return sameSite === "no_restriction" || sameSite === "unspecified";
}

async function clearCloudPreviewAuthCookies(session) {
  const cookies = await session.defaultSession.cookies.get({
    url: CLOUD_APPS_ORIGIN,
  });
  for (const cookie of cookies) {
    if (cookie.name === "papr_session" || cookie.name === "papr_share") {
      await session.defaultSession.cookies.remove(CLOUD_APPS_ORIGIN, cookie.name);
    }
  }
}

async function requestSeedSession(namespaceId, slug, shareToken, force) {
  const response = await fetch(
    `http://${GATEWAY_HOST}:${GATEWAY_PORT}/api/cloud-preview/seed-session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespaceId, slug, shareToken, force }),
    },
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) {
    return {
      success: false,
      error:
        typeof body.error === "string"
          ? body.error
          : `Seed failed (${response.status})`,
    };
  }

  return body;
}

async function applySeedCookies(session, cookies) {
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== "string") continue;
    const isSessionCookie = cookie.name === "papr_session";
    const isShareCookie = cookie.name === "papr_share";
    const secure = cookie.secure !== false;
    const sameSite = toElectronSameSite(
      cookie.sameSite,
      secure,
      isSessionCookie || isShareCookie,
    );
    await session.defaultSession.cookies.set({
      url: CLOUD_APPS_ORIGIN,
      name: cookie.name,
      value: String(cookie.value ?? ""),
      path: typeof cookie.path === "string" ? cookie.path : "/",
      httpOnly: cookie.httpOnly !== false,
      secure,
      sameSite,
      ...(typeof cookie.expirationDate === "number"
        ? { expirationDate: cookie.expirationDate }
        : {}),
    });
  }
}

function registerCloudPreviewSessionIPC(ipcMain, session) {
  ipcMain.handle("cloud-preview:seed-session", async (_event, input) => {
    const namespaceId =
      input && typeof input.namespaceId === "string" ? input.namespaceId.trim() : "";
    const slug = input && typeof input.slug === "string" ? input.slug.trim() : "";
    const shareToken =
      input && typeof input.shareToken === "string"
        ? input.shareToken.trim() || undefined
        : undefined;

    if (!namespaceId || !slug) {
      return { success: false, error: "namespaceId and slug required" };
    }

    let body = await requestSeedSession(namespaceId, slug, shareToken, false);
    if (!body.success) {
      return body;
    }

    if (body.cached && (await hasCloudPreviewSessionCookies(session))) {
      return { success: true, cached: true };
    }

    if (body.cached) {
      body = await requestSeedSession(namespaceId, slug, shareToken, true);
      if (!body.success) {
        return body;
      }
    }

    if (body.cached) {
      if (await hasCloudPreviewSessionCookies(session)) {
        return { success: true, cached: true };
      }
      return {
        success: false,
        error: "Session cookies missing after seed — try signing in to Papr again",
      };
    }

    const cookies = Array.isArray(body.cookies) ? body.cookies : [];
    await clearCloudPreviewAuthCookies(session);
    await applySeedCookies(session, cookies);

    if (!(await hasCloudPreviewSessionCookies(session))) {
      return {
        success: false,
        error: "Could not store papr_session cookie for apps.papr.ai preview",
      };
    }

    return { success: true, cookieCount: cookies.length };
  });
}

module.exports = { registerCloudPreviewSessionIPC };
