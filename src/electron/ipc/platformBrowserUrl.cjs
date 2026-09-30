/**
 * URL helpers for platform browser IPC (mirrors platformSessionUrl.ts).
 */

const { matchesSuccessUrl } = require("./platformBrowserConfig.cjs");

function isLoggedOutPlatformUrl(url) {
  return (
    /\/login(?:\/|$|\?|#)/i.test(url) ||
    /\/signin(?:\/|$|\?|#)/i.test(url) ||
    /\/sign-in(?:\/|$|\?|#)/i.test(url) ||
    /\/checkpoint(?:\/|$|\?|#)/i.test(url) ||
    /\/authwall/i.test(url) ||
    /\/oauth/i.test(url) ||
    /\/sso(?:\/|$|\?|#)/i.test(url)
  );
}

function normalizePlatformNavigationUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

function platformNavigationUrlsMatch(current, target) {
  return (
    normalizePlatformNavigationUrl(current) ===
    normalizePlatformNavigationUrl(target)
  );
}

function isAuthenticatedPlatformUrl(platformId, url) {
  if (!url || url === "about:blank") {
    return false;
  }
  if (isLoggedOutPlatformUrl(url)) {
    return false;
  }
  return matchesSuccessUrl(platformId, url);
}

/**
 * Skip linkedin.com/ landing hop when already on an authenticated page.
 */
function shouldSkipPlatformLandingHop(platformId, currentUrl, destination) {
  if (!currentUrl || currentUrl === "about:blank") {
    return false;
  }
  if (isLoggedOutPlatformUrl(currentUrl)) {
    return false;
  }
  if (!isAuthenticatedPlatformUrl(platformId, currentUrl)) {
    return false;
  }

  try {
    const currentHost = new URL(currentUrl).hostname;
    const destHost = new URL(destination).hostname;
    return currentHost === destHost;
  } catch {
    return false;
  }
}

module.exports = {
  isLoggedOutPlatformUrl,
  normalizePlatformNavigationUrl,
  platformNavigationUrlsMatch,
  isAuthenticatedPlatformUrl,
  shouldSkipPlatformLandingHop,
};
