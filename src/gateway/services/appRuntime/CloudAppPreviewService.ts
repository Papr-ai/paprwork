/**
 * Cloud App Host link previews — metadata loading, OG tags, icon serving.
 */

import type { Request } from "express";
import {
  parseCloudAppMetadataFile,
  buildDefaultCloudAppDescription,
  type CloudAppMetadataFile,
} from "../../../core/utils/cloudAppMetadata.js";
import {
  buildPreviewHeadTags,
  buildPreviewLandingHtml,
  buildPreviewMetaFromSlug,
  CLOUD_APP_SITE_NAME,
  injectPreviewHeadTags,
  type CloudAppPreviewMeta,
} from "../../../core/utils/cloudAppPreview.js";
import type { AppRuntimeRouteAuth } from "./types.js";
import { fetchCachedRuntimeRepoFile } from "./cloudAppHostCache.js";
import { resolvePublishedApp, type PublishedAppResolveResult, type PublishedAppVisibility } from "./cloudAppPublishClient.js";
import {
  ensurePublishedAppRootTrailingSlash,
  publishedAppBaseHref,
} from "../../../core/utils/cloudAppPath.js";

const DEFAULT_PAPR_LOGO_SVG = `<svg width="105" height="124" viewBox="0 0 105 124" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M27.9998 101.5C-11.5 158 6.99988 51 43.4008 60.5002C99.2884 75.0861 115.18 20.7781 83.6804 8.27816C40.2693 -8.94844 51.9998 65 27.9998 101.5Z" stroke="#0060E0" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function emojiIconToSvg(icon: string): string {
  const emoji = icon.trim().slice(0, 4);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#F5F5F7"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="64">${emoji}</text></svg>`;
}

function isSvgIcon(icon: string): boolean {
  return icon.trim().startsWith("<svg");
}

function previewMetaFromCatalog(
  resolved: PublishedAppResolveResult,
  canonicalUrl: string,
  iconUrl: string,
  imageUrl: string,
): CloudAppPreviewMeta | null {
  const title = resolved.catalogTitle?.trim();
  if (!title) {
    return null;
  }
  const description =
    resolved.catalogDescription?.trim() ||
    buildDefaultCloudAppDescription(title);
  return {
    title,
    description,
    canonicalUrl,
    iconUrl,
    imageUrl,
    siteName: CLOUD_APP_SITE_NAME,
  };
}

function catalogIconToSvg(icon: string): string {
  if (isSvgIcon(icon)) {
    return icon;
  }
  return emojiIconToSvg(icon);
}

async function loadPublishedApp(
  runtimeAuth: AppRuntimeRouteAuth,
  publishedApp?: PublishedAppResolveResult | null,
): Promise<PublishedAppResolveResult | null> {
  if (publishedApp !== undefined) {
    return publishedApp;
  }
  return resolvePublishedApp(runtimeAuth.namespaceId, runtimeAuth.slug);
}

const SHARE_GATE_SIGNED_IN_MESSAGE =
  "You're signed in, but this app isn't shared with your account. Ask the person who sent you this link to add you.";

const SHARE_LINK_REQUIRED_MESSAGE =
  "Use the full invite link you were sent, or sign in with an account the app owner has added.";

export interface ShareGateState {
  hasSession: boolean;
  hasShareToken: boolean;
  visibility?: PublishedAppVisibility;
}

export interface ShareGatePresentation {
  headline: string;
  message: string;
  showLoginButton: boolean;
}

function isInviteLinkVisibility(visibility: PublishedAppVisibility | undefined): boolean {
  return visibility === "link_read" || visibility === "link_read_write";
}

function isTeamVisibility(visibility: PublishedAppVisibility | undefined): boolean {
  return visibility === "team" || visibility === "private";
}

export function resolveShareGatePresentation(state: ShareGateState): ShareGatePresentation {
  const { hasSession, hasShareToken, visibility } = state;

  if (!hasSession) {
    if (isInviteLinkVisibility(visibility)) {
      if (hasShareToken) {
        return {
          headline: "This link isn't working yet",
          message:
            "The invite link may still be updating, or it may have expired. Ask the app owner for a fresh link and try again in a few minutes.",
          showLoginButton: false,
        };
      }
      return {
        headline: "Invite link required",
        message:
          "Open the full link you were sent — signing in alone won't open this app.",
        showLoginButton: false,
      };
    }
    if (isTeamVisibility(visibility)) {
      return {
        headline: "Sign in is required to access this app.",
        message: "Sign in with the Papr account your team uses for this app.",
        showLoginButton: true,
      };
    }
    return {
      headline: "Sign in is required to access this app.",
      message: "",
      showLoginButton: true,
    };
  }

  // Authenticated but still blocked
  if (isInviteLinkVisibility(visibility) && !hasShareToken) {
    return {
      headline: "Invite link required",
      message:
        "You're signed in, but you still need the full invite link from the person who shared this app.",
      showLoginButton: false,
    };
  }

  if (isTeamVisibility(visibility)) {
    return {
      headline: "No access",
      message:
        "You're signed in, but this app isn't shared with your account. Ask the person who sent you this link to add you.",
      showLoginButton: false,
    };
  }

  return {
    headline: "No access",
    message: hasShareToken
      ? "This invite link may be invalid or expired. Ask the app owner for a new link."
      : SHARE_GATE_SIGNED_IN_MESSAGE,
    showLoginButton: false,
  };
}

/** @deprecated Use resolveShareGatePresentation for headline + message. */
export function resolveShareGateMessage(input: ShareGateState): string {
  return resolveShareGatePresentation(input).message;
}

export function buildCanonicalAppUrl(
  publicBaseUrl: string,
  namespaceId: string,
  slug: string,
): string {
  const root = ensurePublishedAppRootTrailingSlash(`/${namespaceId}/${slug}`);
  return `${publicBaseUrl.replace(/\/$/, "")}${root}`;
}

export function buildPreviewAssetUrl(
  publicBaseUrl: string,
  namespaceId: string,
  slug: string,
  asset: "opengraph-icon" | "assets/papr-logo.svg",
  shareToken?: string,
): string {
  const base = `${publicBaseUrl.replace(/\/$/, "")}/${namespaceId}/${slug}/${asset}`;
  if (!shareToken) {
    return base;
  }
  return `${base}?t=${encodeURIComponent(shareToken)}`;
}

function previewMetaFromMetadata(
  metadata: CloudAppMetadataFile,
  canonicalUrl: string,
  iconUrl: string,
  imageUrl: string,
): CloudAppPreviewMeta {
  return {
    title: metadata.title,
    description: metadata.description,
    canonicalUrl,
    iconUrl,
    imageUrl,
    siteName: CLOUD_APP_SITE_NAME,
  };
}

async function readMetadataFromRepo(
  runtimeAuth: AppRuntimeRouteAuth,
): Promise<CloudAppMetadataFile | null> {
  try {
    const metadataFile = await fetchCachedRuntimeRepoFile(runtimeAuth, "metadata.json");
    if (!metadataFile?.content) {
      return null;
    }
    return parseCloudAppMetadataFile(metadataFile.content);
  } catch {
    // Memory may deny repo-file for unsigned visitors even with host key — fall back to slug meta.
    return null;
  }
}

async function readIconSvgFromRepo(
  runtimeAuth: AppRuntimeRouteAuth,
): Promise<string | null> {
  try {
    for (const iconPath of ["logo.svg", "icon.svg", "favicon.svg"]) {
      const iconFile = await fetchCachedRuntimeRepoFile(runtimeAuth, iconPath);
      if (iconFile?.content?.trim().startsWith("<svg")) {
        return iconFile.content;
      }
    }
  } catch {
    // Same as readMetadataFromRepo — unsigned gate must not 500 on repo-file 403.
  }
  return null;
}

export async function resolveCloudAppPreviewMeta(input: {
  runtimeAuth: AppRuntimeRouteAuth;
  publicBaseUrl: string;
  canReadRepo: boolean;
  publishedApp?: PublishedAppResolveResult | null;
}): Promise<CloudAppPreviewMeta> {
  const { runtimeAuth, publicBaseUrl, canReadRepo, publishedApp } = input;
  const canonicalUrl = buildCanonicalAppUrl(
    publicBaseUrl,
    runtimeAuth.namespaceId,
    runtimeAuth.slug,
  );
  const iconUrl = buildPreviewAssetUrl(
    publicBaseUrl,
    runtimeAuth.namespaceId,
    runtimeAuth.slug,
    "opengraph-icon",
    runtimeAuth.shareToken,
  );
  const imageUrl = iconUrl;

  if (canReadRepo) {
    const metadata = await readMetadataFromRepo(runtimeAuth);
    if (metadata) {
      return previewMetaFromMetadata(metadata, canonicalUrl, iconUrl, imageUrl);
    }
  }

  const resolved = await loadPublishedApp(runtimeAuth, publishedApp);
  const catalogMeta = resolved ? previewMetaFromCatalog(resolved, canonicalUrl, iconUrl, imageUrl) : null;
  if (catalogMeta) {
    return catalogMeta;
  }

  const slug = resolved?.slug ?? runtimeAuth.slug;
  return buildPreviewMetaFromSlug(slug, canonicalUrl, iconUrl, imageUrl);
}

export function injectCloudAppPreviewIntoHtml(
  html: string,
  meta: CloudAppPreviewMeta,
  namespaceId: string,
  slug: string,
): string {
  const withBase = html.includes("<base ")
    ? html
    : html.replace(
        "<head>",
        `<head>\n  <base href="${publishedAppBaseHref(namespaceId, slug)}">`,
      );
  return injectPreviewHeadTags(withBase, buildPreviewHeadTags(meta));
}

export function buildShareGateLandingHtml(
  meta: CloudAppPreviewMeta,
  loginUrl?: string,
  presentation?: ShareGatePresentation,
  iconSvg?: string,
  signupUrl?: string,
): string {
  return buildPreviewLandingHtml(meta, presentation?.message ?? SHARE_LINK_REQUIRED_MESSAGE, {
    loginUrl,
    signupUrl,
    showLoginButton: presentation?.showLoginButton ?? true,
    headline: presentation?.headline,
    iconSvg,
  });
}

export async function resolvePreviewIconSvg(
  runtimeAuth: AppRuntimeRouteAuth,
  canReadRepo: boolean,
  publishedApp?: PublishedAppResolveResult | null,
): Promise<string> {
  if (canReadRepo) {
    const metadata = await readMetadataFromRepo(runtimeAuth);
    if (metadata?.icon) {
      return catalogIconToSvg(metadata.icon);
    }
    const iconSvg = await readIconSvgFromRepo(runtimeAuth);
    if (iconSvg) {
      return iconSvg;
    }
  }

  const resolved = await loadPublishedApp(runtimeAuth, publishedApp);
  if (resolved?.catalogIcon?.trim()) {
    return catalogIconToSvg(resolved.catalogIcon);
  }

  return DEFAULT_PAPR_LOGO_SVG;
}

export function getCloudAppPublicBaseUrl(req: Request): string {
  const configured = process.env.PAPR_CLOUD_APP_PUBLIC_URL?.replace(/\/$/, "");
  if (configured) {
    return configured;
  }
  const proto =
    req.headers["x-forwarded-proto"] === "https" || req.protocol === "https"
      ? "https"
      : "http";
  const host = req.get("host") ?? "apps.papr.ai";
  return `${proto}://${host}`;
}

export function getDefaultPaprLogoSvg(): string {
  return DEFAULT_PAPR_LOGO_SVG;
}
