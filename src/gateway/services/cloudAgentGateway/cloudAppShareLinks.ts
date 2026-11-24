/**
 * The right link to hand out for each of the user's published apps in a cloud run.
 * The catalog only carries the bare URL; a link-shared app needs its ?t= token or
 * the visitor sees "Invite link required". Reads each own app's access (same call
 * the Share sheet makes) and picks the link from it.
 */
import { pickShareLink, type PickedShareLink } from "../../../core/utils/cloudShareLink.js";
import { describeAudiences, fetchAudiences } from "../cloudAppAudiences.js";
import type { CloudCatalogApp } from "./cloudAppCatalog.js";

const MAX_LOOKUPS = 20;

export async function shareLinksForCatalogApps(
  apps: CloudCatalogApp[],
  isOwn: (app: CloudCatalogApp) => boolean,
): Promise<Map<string, PickedShareLink>> {
  const out = new Map<string, PickedShareLink>();
  const own = apps.filter((a) => isOwn(a) && a.shareUrl).slice(0, MAX_LOOKUPS);
  await Promise.all(
    own.map(async (app) => {
      const access = await fetchAudiences(app.appId).catch(() => null);
      const view = describeAudiences(access);
      if (!view) return;
      out.set(
        app.appId,
        pickShareLink(app.shareUrl, access?.shareToken ?? null, view as Parameters<typeof pickShareLink>[2]),
      );
    }),
  );
  return out;
}
