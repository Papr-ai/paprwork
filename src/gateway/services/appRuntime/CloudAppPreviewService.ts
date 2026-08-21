/**
 * Cloud App Host link previews — metadata loading, OG tags, icon serving.
 */

import type { Request } from "express";
import {
  parseCloudAppMetadataFile,
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
import { resolvePublishedApp, type PublishedAppVisibility } from "./cloudAppPublishClient.js";
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

const SHARE_GATE_SIGNED_IN_MESSAGE =
  "You signed in at apps.papr.ai, but you still need access to this app. If sharing is set to People with invite link, open the full external link from Paprwork. If sharing is My team, ask the owner to add your email under Settings → Papr → Team, then sign in here again.";

const SHARE_LINK_REQUIRED_MESSAGE =
  "This app needs either the full invite link from Paprwork (Copy external link — includes a ?t= token) or Papr team access.";

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
          headline: "This invite link isn't working yet",
          message:
            "The link includes an invite token, but the web app is still catching up. " +
            "After changing sharing or uploading, allow 2–5 minutes for the publish catalog and app bundle to propagate, " +
            "then copy a fresh external link from Paprwork (Share → Copy external link) and try again. " +
            "If you already waited, the token may be outdated — request a new link after Upload now finishes.",
          showLoginButton: false,
        };
      }
      return {
        headline: "Invite link required",
        message:
          "You are not signed in, and this app is shared via invite link. " +
          "Open the full external link from Paprwork (Copy external link — it includes a ?t= token). " +
          "Signing in alone will not open this app.",
        showLoginButton: false,
      };
    }
    if (isTeamVisibility(visibility)) {
      return {
        headline: "Sign in required",
        message:
          "You are not signed in. This app is shared with My team — sign in with a Papr account " +
          "that the owner added under Settings → Papr → Team in Paprwork.",
        showLoginButton: true,
      };
    }
    return {
      headline: "Sign in required",
      message:
        "You are not signed in. Sign in at apps.papr.ai if you are on the workspace team, " +
        "or open the invite link from Paprwork. dashboard.papr.ai sign-in does not carry over here.",
      showLoginButton: true,
    };
  }

  // Authenticated but still blocked
  if (isInviteLinkVisibility(visibility) && !hasShareToken) {
    return {
      headline: "Signed in — invite link still required",
      message:
        "You are signed in, but this app is published as People with invite link. " +
        "Team membership does not grant access to the bare URL. " +
        "Ask the owner for the full external link from Paprwork (includes ?t=), or have them switch sharing to My team and click Update web version.",
      showLoginButton: false,
    };
  }

  if (isTeamVisibility(visibility)) {
    return {
      headline: "Signed in — access denied",
      message:
        "You are signed in, but this Papr account is not authorized for this app namespace. " +
        "Common fixes: confirm the app is still shared as My team and the owner clicked Update web version; " +
        "confirm your email is on the owner's workspace team (Settings → Papr → Team); " +
        "confirm you are signing in with the same Papr account (not a different email alias).",
      showLoginButton: false,
    };
  }

  return {
    headline: hasShareToken ? "Access denied" : "Signed in — access denied",
    message: hasShareToken
      ? "Your invite link may be invalid or expired. Ask the owner for a new external link from Paprwork."
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
  const metadataFile = await fetchCachedRuntimeRepoFile(runtimeAuth, "metadata.json");
  if (!metadataFile?.content) {
    return null;
  }
  return parseCloudAppMetadataFile(metadataFile.content);
}

async function readIconSvgFromRepo(
  runtimeAuth: AppRuntimeRouteAuth,
): Promise<string | null> {
  for (const iconPath of ["logo.svg", "icon.svg", "favicon.svg"]) {
    const iconFile = await fetchCachedRuntimeRepoFile(runtimeAuth, iconPath);
    if (iconFile?.content?.trim().startsWith("<svg")) {
      return iconFile.content;
    }
  }
  return null;
}

export async function resolveCloudAppPreviewMeta(input: {
  runtimeAuth: AppRuntimeRouteAuth;
  publicBaseUrl: string;
  canReadRepo: boolean;
}): Promise<CloudAppPreviewMeta> {
  const { runtimeAuth, publicBaseUrl, canReadRepo } = input;
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

  const resolved = await resolvePublishedApp(
    runtimeAuth.namespaceId,
    runtimeAuth.slug,
  );
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
): string {
  return buildPreviewLandingHtml(meta, presentation?.message ?? SHARE_LINK_REQUIRED_MESSAGE, {
    loginUrl,
    showLoginButton: presentation?.showLoginButton ?? true,
    headline: presentation?.headline,
  });
}

export async function resolvePreviewIconSvg(
  runtimeAuth: AppRuntimeRouteAuth,
  canReadRepo: boolean,
): Promise<string> {
  if (canReadRepo) {
    const metadata = await readMetadataFromRepo(runtimeAuth);
    if (metadata?.icon) {
      if (isSvgIcon(metadata.icon)) {
        return metadata.icon;
      }
      return emojiIconToSvg(metadata.icon);
    }
    const iconSvg = await readIconSvgFromRepo(runtimeAuth);
    if (iconSvg) {
      return iconSvg;
    }
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
