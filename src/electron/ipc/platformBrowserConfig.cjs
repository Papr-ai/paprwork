/**
 * Platform browser config (mirrors src/gateway/services/platforms/platformRegistry.ts).
 * Kept in CJS for the Electron main process.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const PLATFORM_CONFIG = {
  linkedin: {
    loginUrl: "https://www.linkedin.com/login",
    homeUrl: "https://www.linkedin.com/feed/",
    prepareNavigationUrl: "https://www.linkedin.com/",
    successUrlPattern: "linkedin\\.com\\/(feed|in\\/|mynetwork|messaging)",
    cookieDomains: ["linkedin.com"],
  },
  instagram: {
    loginUrl: "https://www.instagram.com/accounts/login/",
    homeUrl: "https://www.instagram.com/",
    successUrlPattern: "instagram\\.com\\/?($|\\/[^accounts])",
    cookieDomains: ["instagram.com"],
  },
  reddit: {
    loginUrl: "https://www.reddit.com/login/",
    homeUrl: "https://www.reddit.com/",
    successUrlPattern: "reddit\\.com\\/?($|\\/r\\/|\\/user\\/)",
    cookieDomains: ["reddit.com"],
  },
  facebook: {
    loginUrl: "https://www.facebook.com/login/",
    homeUrl: "https://www.facebook.com/",
    successUrlPattern: "facebook\\.com\\/?($|\\/[^login])",
    cookieDomains: ["facebook.com"],
  },
  tiktok: {
    loginUrl: "https://www.tiktok.com/login",
    homeUrl: "https://www.tiktok.com/foryou",
    successUrlPattern: "tiktok\\.com\\/(foryou|following|@)",
    cookieDomains: ["tiktok.com"],
  },
  twitter: {
    loginUrl: "https://x.com/i/flow/login",
    homeUrl: "https://x.com/home",
    successUrlPattern: "x\\.com\\/(home|explore|notifications)",
    cookieDomains: ["x.com", "twitter.com"],
  },
  telegram: {
    loginUrl: "https://web.telegram.org/a/",
    homeUrl: "https://web.telegram.org/a/",
    successUrlPattern: "web\\.telegram\\.org\\/a\\/",
    cookieDomains: ["telegram.org"],
  },
  "papr-auth": {
    loginUrl: "",
    homeUrl: "",
    cookieDomains: ["auth0.com", "papr.ai"],
  },
};

function getPlatformConnectionsPath() {
  const paprHome =
    process.env.PAPR_HOME || path.join(os.homedir(), "Papr");
  return path.join(paprHome, "data", "platform-connections.json");
}

function loadCustomPlatformConfig(platformId) {
  try {
    const storePath = getPlatformConnectionsPath();
    if (!fs.existsSync(storePath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const entry = Array.isArray(parsed.connections)
      ? parsed.connections.find((item) => item && item.id === platformId)
      : null;
    if (!entry) {
      return null;
    }
    const cookieHost = String(entry.cookieDomain || entry.originHost || "").replace(
      /^\./,
      "",
    );
    return {
      loginUrl: entry.loginUrl,
      homeUrl: entry.homeUrl,
      successUrlPattern: String(entry.originHost || cookieHost).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      ),
      cookieDomains: cookieHost ? [cookieHost] : [],
      originHost: entry.originHost,
      isCustom: true,
    };
  } catch {
    return null;
  }
}

function getPlatformConfig(platformId) {
  return PLATFORM_CONFIG[platformId] ?? loadCustomPlatformConfig(platformId);
}

function matchesSuccessUrl(platformId, url) {
  const config = getPlatformConfig(platformId);
  if (!config?.successUrlPattern || typeof url !== "string" || url.length === 0) {
    return false;
  }
  return new RegExp(config.successUrlPattern, "i").test(url);
}

function cookieMatchesDomains(cookie, domains) {
  if (!domains || domains.length === 0) {
    return true;
  }
  const domain = cookie.domain ?? "";
  return domains.some((d) => domain.includes(d.replace(/^\./, "")));
}

module.exports = {
  PLATFORM_CONFIG,
  getPlatformConfig,
  matchesSuccessUrl,
  cookieMatchesDomains,
};
