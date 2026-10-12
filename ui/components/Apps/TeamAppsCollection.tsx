/**
 * My apps → "From <team>": team-shared apps you don't have yet, as one more
 * collection. Your installed team apps are already in My apps (Open); these
 * show Get / Open web in the details modal. "See all" opens the full team list.
 */
import { useEffect, useMemo, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import type { CommunityCatalog, CommunityCatalogEntry } from "../../../src/core/types/communityCatalog";
import { isTeamSharedVisibility } from "../../../src/core/types/communityCatalog";
import { readCommunityCatalogCache, writeCommunityCatalogCache } from "../../utils/communityCatalogCache";
import { canInstallCloudCatalogEntry } from "../../utils/communityAppLocalOpen";
import {
  catalogCoverUrl,
  resolveCatalogLiveWebUrl,
  resolveCatalogPreviewIframeUrl,
} from "../../utils/catalogPreviewUrl";
import { cloudCatalogPreviewEntityId, type CloudCatalogPreviewTabMetadata } from "../../types/cloudCatalogPreviewTab";
import { bannerShade } from "../../utils/appsHome";
import { useCloudCatalogInstallFlow } from "../../hooks/useCloudCatalogInstallFlow";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { CatalogAppDetails } from "./CatalogAppDetails";
import { CloudInstallOptionalDepsNotice } from "./CloudInstallOptionalDepsNotice";
import { DropGlyph } from "./HomeTiles";
import { HomeIcon } from "./HomeIcon";

const SHOW = 6;
const ID = "s:team";
const clean = (raw?: string) =>
  raw?.trim().startsWith("<")
    ? raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/on\w+\s*=/gi, "data-blocked=")
    : raw;

/** Team-shared, installable, not yours, and not on this computer yet. */
export function uninstalledTeamEntries(
  entries: CommunityCatalogEntry[],
  isLocal: (e: CommunityCatalogEntry) => boolean,
): CommunityCatalogEntry[] {
  return entries.filter(
    (e) =>
      e.source === "cloud" &&
      isTeamSharedVisibility(e.visibility) &&
      !e.isOwned &&
      e.codeInstallable &&
      !isLocal(e),
  );
}

export function TeamAppsCollection({
  namespaceId,
  namespaceName,
  onSeeAll,
}: {
  namespaceId: string;
  namespaceName: string | null;
  onSeeAll: () => void;
}) {
  const [catalog, setCatalog] = useState<CommunityCatalog | null>(() =>
    readCommunityCatalogCache("namespace", namespaceId),
  );
  useEffect(() => {
    let stale = false;
    gateway
      .send("bundle:fetch-community-catalog", { scope: "namespace", namespaceId }, { timeoutMs: 60_000 })
      .then((res) => {
        if (stale) return;
        const next = res.data as CommunityCatalog;
        setCatalog(next);
        writeCommunityCatalogCache("namespace", namespaceId, next);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [namespaceId]);

  const flow = useCloudCatalogInstallFlow();
  const { artifacts } = useArtifacts();
  const { createTab, switchToTab } = useTabs();
  const [open, setOpen] = useState<CommunityCatalogEntry | null>(null);
  const localIds = useMemo(() => new Set(artifacts.filter((a) => a.type === "app").map((a) => a.id)), [artifacts]);
  const entries = useMemo(
    () =>
      uninstalledTeamEntries(catalog?.entries ?? [], (e) => {
        if (e.appId && localIds.has(e.appId)) return true;
        const local = flow.resolveLocalAppId(e);
        return Boolean(local && localIds.has(local)) || !canInstallCloudCatalogEntry(e, null);
      }),
    [catalog, localIds, flow],
  );
  if (entries.length === 0) {
    return flow.optionalDepsNotice ? notice() : null;
  }

  function notice() {
    const n = flow.optionalDepsNotice;
    return n ? (
      <CloudInstallOptionalDepsNotice
        appTitle={n.appTitle}
        dependencies={n.dependencies}
        onClose={() => flow.setOptionalDepsNotice(null)}
        onOpenCommunityApps={flow.openCommunityAppsFromOptionalDeps}
        onContinue={flow.continueFromOptionalDeps}
      />
    ) : null;
  }

  const openWeb = (e: CommunityCatalogEntry) => {
    const previewIframeUrl = resolveCatalogPreviewIframeUrl(e);
    const liveUrl = resolveCatalogLiveWebUrl(e);
    if (!previewIframeUrl || !liveUrl) return;
    const metadata: CloudCatalogPreviewTabMetadata = {
      cloudCatalogPreview: true,
      previewIframeUrl,
      liveUrl,
      catalogId: e.catalogId,
      ...(e.appId ? { publisherAppId: e.appId } : {}),
      ...(e.namespaceId ? { namespaceId: e.namespaceId } : {}),
      ...(e.slug ? { slug: e.slug } : {}),
    };
    switchToTab(createTab("app", cloudCatalogPreviewEntityId(e.catalogId), e.name, metadata as unknown as Record<string, unknown>));
  };

  const shown = entries.length > SHOW ? entries.slice(0, SHOW - 1) : entries;
  const more = entries.length - shown.length;
  const team = namespaceName?.trim() || "your team";
  return (
    <div className={`ah-card ah-coll ah-coll--auto ${entries.length > 3 ? "ah-coll--big" : ""}`}>
      <div className={`ah-coll__art ah-tint-${bannerShade(ID)}`}>
        <div className="ah-coll__grid">
          {shown.map((e) => (
            <div key={e.catalogId} className="ah-cell">
              <button type="button" className="ah-cell__open" onClick={() => setOpen(e)} title={e.description}>
                <span className="ah-cell__ic">
                  <DropGlyph icon={clean(e.icon)} title={e.name} size={50} />
                </span>
                <span className="ah-cell__t">{e.name}</span>
                <span className="ah-cell__get">{flow.installingId === e.catalogId ? "Getting…" : "Get"}</span>
              </button>
            </div>
          ))}
          {more > 0 ? (
            <div className="ah-cell">
              <button type="button" className="ah-cell__open" onClick={onSeeAll}>
                <span className="ah-cell__ic">
                  <span className="ah-gl ah-gl--more">+{more}</span>
                </span>
                <span className="ah-cell__t">See all</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="ah-coll__row">
        <span className={`ah-coll__ic ah-pb-${bannerShade(ID)}`}>
          <HomeIcon name="users" size={18} />
        </span>
        <div className="ah-coll__txt">
          <button type="button" className="ah-coll__name" onClick={onSeeAll}>
            From {team}
          </button>
          <span className="ah-coll__meta">
            {entries.length} you don't have yet
          </span>
        </div>
        <button type="button" className="ah-open" onClick={onSeeAll}>
          See all
        </button>
      </div>
      {open ? (
        <CatalogAppDetails
          entry={{ ...open, icon: clean(open.icon) }}
          coverUrl={catalogCoverUrl(open)}
          hasWeb={Boolean(resolveCatalogLiveWebUrl(open))}
          onClose={() => setOpen(null)}
          actions={
            <>
              {resolveCatalogLiveWebUrl(open) ? (
                <button type="button" className="cat-btn cat-btn--lg" onClick={() => openWeb(open)}>
                  Open web
                </button>
              ) : null}
              <button
                type="button"
                className="cat-btn cat-btn--lg cat-btn--solid"
                disabled={flow.installingId === open.catalogId}
                onClick={() => {
                  flow.startCloudInstall(open, { catalogScope: "namespace" });
                  setOpen(null);
                }}
              >
                {flow.installingId === open.catalogId ? "Getting…" : "Get"}
              </button>
            </>
          }
        />
      ) : null}
      {notice()}
    </div>
  );
}
