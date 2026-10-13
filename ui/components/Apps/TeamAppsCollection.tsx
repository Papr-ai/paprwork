/**
 * My apps → "From <team>": team-shared apps you don't have yet, as the last
 * section (the Team tab scrolls here). Get installs; the card opens details
 * (Get / Open web). Installed team apps are already in your list above.
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
import { useCloudCatalogInstallFlow } from "../../hooks/useCloudCatalogInstallFlow";
import { useArtifacts } from "../../hooks/useArtifacts";
import { useTabs } from "../../hooks/useTabs";
import { CatalogAppDetails } from "./CatalogAppDetails";
import { CloudInstallOptionalDepsNotice } from "./CloudInstallOptionalDepsNotice";
import { GetRow } from "./HomeRows";

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
}: {
  namespaceId: string;
  namespaceName: string | null;
}) {
  // Last-known team list paints at once (any age); the fetch below refreshes it.
  // My apps never waits on this — the collection appears when it has entries.
  const [catalog, setCatalog] = useState<CommunityCatalog | null>(() =>
    readCommunityCatalogCache("namespace", namespaceId, { allowStale: true }),
  );
  useEffect(() => {
    let stale = false;
    setCatalog(readCommunityCatalogCache("namespace", namespaceId, { allowStale: true }));
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
  const { artifacts } = useArtifacts("apps", { autoLoad: false });
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
    return (
      <section className="ah-sec" id="ah-team">
        <h2 className="ah-sec__h">From {namespaceName?.trim() || "your team"}</h2>
        <p className="ah-sec__none">You have every app your team shares.</p>
        {notice()}
      </section>
    );
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

  const team = namespaceName?.trim() || "your team";
  return (
    <section className="ah-sec" id="ah-team" aria-label={`From ${team}`}>
      <h2 className="ah-sec__h">
        From {team} <em>{entries.length}</em>
      </h2>
      <div className="ah-rows">
        {entries.map((e) => (
          <GetRow
            key={e.catalogId}
            name={e.name}
            icon={clean(e.icon)}
            description={e.description}
            by={e.author}
            busy={flow.installingId === e.catalogId}
            onDetails={() => setOpen(e)}
            onGet={() => flow.startCloudInstall(e, { catalogScope: "namespace" })}
          />
        ))}
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
    </section>
  );
}
