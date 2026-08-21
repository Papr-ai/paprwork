/**
 * Host for catalog preview tabs — restores preview metadata after app restart.
 */

import { useEffect, useState } from "react";
import type { Tab } from "../../types/tabs";
import type { CommunityCatalog } from "../../src/core/types/communityCatalog";
import { useTabStore } from "../../stores/tabStore";
import { fetchCatalogEntryById } from "../../utils/fetchCatalogEntry";
import {
  catalogIdFromPreviewEntityId,
  isCatalogPreviewEntityId,
  readCloudCatalogPreviewTabMetadata,
  type CloudCatalogPreviewTabMetadata,
} from "../../types/cloudCatalogPreviewTab";
import {
  resolveCatalogLiveWebUrl,
  resolveCatalogPreviewIframeUrl,
} from "../../utils/catalogPreviewUrl";
import { CloudCatalogPreviewView } from "./CloudCatalogPreviewView";
import { MiniAppPreviewUrlBar } from "./MiniAppPreviewUrlBar";
import "./MiniAppPublishBar.css";
import "./CloudCatalogPreviewView.css";

interface CatalogPreviewTabViewProps {
  tab: Tab;
  previewTabVisible?: boolean;
}

function buildPreviewMetadataFromCatalogEntry(
  entry: CommunityCatalog["entries"][number],
): CloudCatalogPreviewTabMetadata | null {
  const previewIframeUrl = resolveCatalogPreviewIframeUrl(entry);
  const liveUrl = resolveCatalogLiveWebUrl(entry);
  if (!previewIframeUrl || !liveUrl) {
    return null;
  }
  return {
    cloudCatalogPreview: true,
    previewIframeUrl,
    liveUrl,
    catalogId: entry.catalogId,
    ...(entry.appId ? { publisherAppId: entry.appId } : {}),
    ...(entry.namespaceId ? { namespaceId: entry.namespaceId } : {}),
    slug: entry.slug ?? null,
  };
}

async function recoverCatalogPreviewMetadata(
  catalogId: string,
): Promise<CloudCatalogPreviewTabMetadata | null> {
  const entry = await fetchCatalogEntryById(catalogId);
  if (!entry) {
    return null;
  }
  return buildPreviewMetadataFromCatalogEntry(entry);
}

export function CatalogPreviewTabView({
  tab,
  previewTabVisible = true,
}: CatalogPreviewTabViewProps) {
  const directPreview = readCloudCatalogPreviewTabMetadata(tab);
  const [preview, setPreview] = useState<CloudCatalogPreviewTabMetadata | null>(
    directPreview,
  );
  const [recovering, setRecovering] = useState(
    !directPreview && isCatalogPreviewEntityId(tab.entityId),
  );

  useEffect(() => {
    const fromTab = readCloudCatalogPreviewTabMetadata(tab);
    if (fromTab) {
      setPreview(fromTab);
      setRecovering(false);
      return;
    }

    if (!isCatalogPreviewEntityId(tab.entityId)) {
      setPreview(null);
      setRecovering(false);
      return;
    }

    const catalogId = catalogIdFromPreviewEntityId(tab.entityId);
    if (!catalogId) {
      setPreview(null);
      setRecovering(false);
      return;
    }

    let cancelled = false;
    setRecovering(true);

    void recoverCatalogPreviewMetadata(catalogId)
      .then((recovered) => {
        if (cancelled) {
          return;
        }
        if (!recovered) {
          setPreview(null);
          setRecovering(false);
          return;
        }
        setPreview(recovered);
        setRecovering(false);
        useTabStore.setState((state) => ({
          tabs: state.tabs.map((item) =>
            item.id === tab.id
              ? { ...item, metadata: { ...item.metadata, ...recovered } }
              : item,
          ),
        }));
      })
      .catch(() => {
        if (!cancelled) {
          setPreview(null);
          setRecovering(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tab]);

  if (recovering) {
    return (
      <div className="mini-app-view">
        <MiniAppPreviewUrlBar title={tab.title} statusLabel="Restoring…" />
        <div className="mini-app-view__frame-wrap">
          <div className="mini-app-view__overlay cloud-catalog-preview__overlay">
            <div className="cloud-catalog-preview__loading">
              <div className="cloud-catalog-preview__spinner" aria-hidden="true" />
              <p className="cloud-catalog-preview__loading-title">
                Restoring live preview…
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="content-area__empty">
        Re-open this app from Team or Community apps to load the live preview.
      </div>
    );
  }

  return (
    <CloudCatalogPreviewView
      title={tab.title}
      preview={preview}
      previewTabVisible={previewTabVisible}
    />
  );
}
