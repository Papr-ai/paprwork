/**
 * Team apps in My apps. preview: under Recent, the newest 4 team apps you don't
 * have yet + "Show all". all: the "Team apps" chip — everything your team shares
 * (not yours), A–Z. One button per card: Open (you have it / web-only) or Get.
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

/** Everything shared with the team that isn't yours: installable, already installed, or web-only. */
export function teamSharedEntries(entries: CommunityCatalogEntry[]): CommunityCatalogEntry[] {
  return entries
    .filter((e) => e.source === "cloud" && isTeamSharedVisibility(e.visibility) && !e.isOwned)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

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

const PREVIEW = 4;

export function TeamAppsCollection({
  namespaceId,
  namespaceName,
  mode = "all",
  onShowAll,
}: {
  namespaceId: string;
  namespaceName: string | null;
  /** preview = newest 4 you don't have yet + "Show all" (My apps home); all = the full team list (Team apps chip). */
  mode?: "preview" | "all";
  onShowAll?: () => void;
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
  const entries = useMemo(() => teamSharedEntries(catalog?.entries ?? []), [catalog]);
  /** Local copy of a team app (installed fork, or the publisher's app id on this computer). */
  const localOf = (e: CommunityCatalogEntry): string | null => {
    if (e.appId && localIds.has(e.appId)) return e.appId;
    const local = flow.resolveLocalAppId(e);
    return local && localIds.has(local) ? local : null;
  };
  /** What the one button does: Open your copy, Get it, or Open the web version. */
  const actionOf = (e: CommunityCatalogEntry) => {
    const local = localOf(e);
    if (local) return { label: "Open" as const, note: "Installed", run: () => switchToTab(createTab("app", local, e.name)) };
    if (canInstallCloudCatalogEntry(e, null)) {
      return { label: "Get" as const, note: "", run: () => flow.startCloudInstall(e, { catalogScope: "namespace" }) };
    }
    if (resolveCatalogLiveWebUrl(e)) return { label: "Open" as const, note: "Web app", run: () => openWeb(e) };
    return null;
  };
  const fresh = [...entries]
    .filter((e) => !localOf(e))
    .sort((x, y) => (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""))
    .slice(0, PREVIEW);
  const shown = mode === "preview" ? fresh : entries;
  if (shown.length === 0) {
    if (mode === "preview") return flow.optionalDepsNotice ? notice() : null;
    return (
      <section className="ah-sec" id="ah-team">
        <p className="ah-sec__none">Nothing shared with your team yet.</p>
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
    <section className="ah-sec" id="ah-team" aria-label={`Team apps from ${team}`}>
      <h2 className="ah-sec__h">
        {mode === "preview" ? "New from your team" : "Team apps"} <em>{mode === "preview" ? "" : entries.length}</em>
        {mode === "preview" && onShowAll && entries.length > shown.length ? (
          <button type="button" className="ah-sec__more" onClick={onShowAll}>
            Show all {entries.length}
          </button>
        ) : null}
      </h2>
      <div className="ah-rows">
        {shown.map((e) => {
          const act = actionOf(e);
          return (
            <GetRow
              key={e.catalogId}
              name={e.name}
              icon={clean(e.icon)}
              description={e.description}
              by={e.author}
              note={act?.note}
              action={act?.label ?? "Open"}
              busy={flow.installingId === e.catalogId || !act}
              onDetails={() => setOpen(e)}
              onGet={() => act?.run()}
            />
          );
        })}
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
              {localOf(open) || canInstallCloudCatalogEntry(open, null) ? (
                <button
                  type="button"
                  className="cat-btn cat-btn--lg cat-btn--solid"
                  disabled={flow.installingId === open.catalogId}
                  onClick={() => {
                    actionOf(open)?.run();
                    setOpen(null);
                  }}
                >
                  {localOf(open) ? "Open" : flow.installingId === open.catalogId ? "Getting…" : "Get"}
                </button>
              ) : null}
            </>
          }
        />
      ) : null}
      {notice()}
    </section>
  );
}
